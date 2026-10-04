import { afterEach, describe, expect, it } from 'vitest'
import { installMockIpc } from '../../../../tests/mockIpc'
import { defaultAgentProviderSettings } from '../../../shared/agentProviderSettings'
import { loadSettings, useSettingsStore } from './settings'

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

  it('ignores and removes the retired tab overflow preference when saving current settings', () => {
    localStorage.setItem('multiagent:settings', JSON.stringify({ tabOverflowMode: 'wrap' }))

    useSettingsStore.getState().setShowGitBranchBadges(true)

    const persisted = JSON.parse(localStorage.getItem('multiagent:settings') ?? '{}') as Record<string, unknown>
    expect(persisted).not.toHaveProperty('tabOverflowMode')
    expect(useSettingsStore.getState()).not.toHaveProperty('tabOverflowMode')
  })

  it('ignores retired terminal renderer preferences and omits them from canonical saves', () => {
    localStorage.setItem('multiagent:settings', JSON.stringify({
      optimizedTerminalRenderer: false,
      terminalRescaleOverlappingGlyphs: false,
      terminalMinimumContrastRatio: 21,
      terminalGpuAcceleration: 'auto',
    }))

    const loaded = loadSettings()
    expect(loaded).not.toHaveProperty('optimizedTerminalRenderer')
    expect(loaded).not.toHaveProperty('terminalRescaleOverlappingGlyphs')
    expect(loaded).not.toHaveProperty('terminalMinimumContrastRatio')

    useSettingsStore.getState().setTerminalGpuAcceleration('auto')

    const persisted = JSON.parse(localStorage.getItem('multiagent:settings') ?? '{}') as Record<string, unknown>
    expect(persisted).not.toHaveProperty('optimizedTerminalRenderer')
    expect(persisted).not.toHaveProperty('terminalRescaleOverlappingGlyphs')
    expect(persisted).not.toHaveProperty('terminalMinimumContrastRatio')
    expect(useSettingsStore.getState()).not.toHaveProperty('optimizedTerminalRenderer')
    expect(useSettingsStore.getState()).not.toHaveProperty('terminalRescaleOverlappingGlyphs')
    expect(useSettingsStore.getState()).not.toHaveProperty('terminalMinimumContrastRatio')
  })
})
