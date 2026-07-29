import { afterEach, describe, expect, it } from 'vitest'
import { installMockIpc } from '../../../../tests/mockIpc'
import { defaultAgentProviderSettings } from '../../../shared/agentProviderSettings'
import { useSettingsStore } from './settings'

afterEach(() => {
  useSettingsStore.setState({ agentProviders: defaultAgentProviderSettings() })
})

describe('provider settings persistence', () => {
  it('persists a committed complete configuration immediately and silently mirrors it to main', async () => {
    const settings = defaultAgentProviderSettings()
    const desired = {
      ...settings,
      claude: {
        ...settings.claude,
        preset: 'deepseek' as const,
        enabled: false,
        baseUrl: 'https://fixture.invalid',
        authToken: 'fixture-token',
        extraEnvVars: [{ id: 'fixture-route', key: 'FIXTURE_ROUTE', value: 'enabled', enabled: true }],
      },
    }
    const ipc = installMockIpc()

    useSettingsStore.getState().setAgentProviders(desired)

    expect(useSettingsStore.getState().agentProviders).toEqual(desired)
    expect(JSON.parse(localStorage.getItem('multiagent:settings') ?? '{}')).toMatchObject({ agentProviders: desired })
    await Promise.resolve()
    expect(ipc.invoke).toHaveBeenCalledWith('settings:set-agent-providers', desired)
  })
})
