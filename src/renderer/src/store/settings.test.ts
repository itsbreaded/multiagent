import { afterEach, describe, expect, it } from 'vitest'
import { installMockIpc } from '../../../../tests/mockIpc'
import { defaultAgentProviderSettings } from '../../../shared/agentProviderSettings'
import { useSettingsStore } from './settings'

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  const settings = defaultAgentProviderSettings()
  useSettingsStore.setState({
    agentProviders: settings,
    confirmedAgentProviders: settings,
    providerSettingsHydrated: true,
    providerSettingsRevision: 0,
    providerSettingsSaveState: 'idle',
    providerSettingsSaveError: null,
    failedAgentProviders: null,
  })
})

describe('provider settings persistence acknowledgement', () => {
  it('restores the confirmed settings after a failed write and retries the same edit', async () => {
    const confirmed = defaultAgentProviderSettings()
    const desired = { ...confirmed, claude: { ...confirmed.claude, preset: 'deepseek' as const } }
    const ipc = installMockIpc()
    ipc.invoke
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ ok: true, snapshot: { revision: 1, settings: desired } })

    useSettingsStore.setState({
      agentProviders: confirmed,
      confirmedAgentProviders: confirmed,
      providerSettingsHydrated: true,
      providerSettingsRevision: 0,
      providerSettingsSaveState: 'idle',
      providerSettingsSaveError: null,
      failedAgentProviders: null,
    })

    useSettingsStore.getState().setAgentProviders(desired)
    await settled()
    expect(useSettingsStore.getState()).toMatchObject({
      agentProviders: confirmed,
      providerSettingsSaveState: 'error',
      failedAgentProviders: desired,
    })

    useSettingsStore.getState().retryAgentProvidersSave()
    await settled()
    expect(useSettingsStore.getState()).toMatchObject({
      agentProviders: desired,
      confirmedAgentProviders: desired,
      providerSettingsRevision: 1,
      providerSettingsSaveState: 'idle',
      providerSettingsSaveError: null,
    })
    expect(ipc.invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps a local edit when an older hydration snapshot arrives', async () => {
    const confirmed = defaultAgentProviderSettings()
    const desired = { ...confirmed, claude: { ...confirmed.claude, preset: 'deepseek' as const } }
    const ipc = installMockIpc()
    let resolveSave: ((value: unknown) => void) | undefined
    ipc.invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve }))

    useSettingsStore.setState({
      agentProviders: confirmed,
      confirmedAgentProviders: confirmed,
      providerSettingsHydrated: false,
      providerSettingsRevision: 0,
      providerSettingsSaveState: 'idle',
      providerSettingsSaveError: null,
      failedAgentProviders: null,
    })
    useSettingsStore.getState().setAgentProviders(desired)
    useSettingsStore.getState().hydrateAgentProviders({ revision: 0, settings: confirmed })
    expect(useSettingsStore.getState().agentProviders).toEqual(desired)

    resolveSave?.({ ok: true, snapshot: { revision: 1, settings: desired } })
    await settled()
    expect(useSettingsStore.getState().agentProviders).toEqual(desired)
  })
})
