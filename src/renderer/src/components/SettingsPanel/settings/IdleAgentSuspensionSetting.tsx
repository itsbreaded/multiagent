import { useEffect, useState } from 'react'
import {
  MAX_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES,
  MIN_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES,
  normalizeIdleAgentSuspensionTimeout,
} from '../../../../../shared/idleAgentSuspension'
import { useSettingsStore } from '../../../store/settings'
import { checkStyle, inputStyle, SettingControlRow } from './shared'

export function IdleAgentSuspensionSetting(): JSX.Element {
  const policy = useSettingsStore((s) => s.idleAgentSuspension)
  const setPolicy = useSettingsStore((s) => s.setIdleAgentSuspension)
  const hydrate = useSettingsStore((s) => s.hydrateIdleAgentSuspension)
  const [draft, setDraft] = useState(String(policy.timeoutMinutes))

  useEffect(() => {
    setDraft(String(policy.timeoutMinutes))
  }, [policy.timeoutMinutes])

  useEffect(() => {
    window.ipc.invoke('settings:get-idle-agent-suspension').then(hydrate).catch(() => { /* local fallback */ })
  }, [hydrate])

  const commitTimeout = (): void => {
    const timeoutMinutes = normalizeIdleAgentSuspensionTimeout(draft)
    setPolicy({ ...policy, timeoutMinutes })
    setDraft(String(timeoutMinutes))
  }

  return (
    <SettingControlRow
      title="Automatically suspend idle agent sessions"
      description="When enabled, Claude, Codex, and OpenCode sessions in unfocused tabs are suspended after the timeout only when their live lifecycle state is explicitly idle and the exact session can be resumed. Shell panes and protected/unknown sessions are never targeted."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={checkStyle}>
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <input
          style={{ ...inputStyle, width: 68 }}
          inputMode="numeric"
          aria-label="Idle session timeout in minutes"
          min={MIN_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES}
          max={MAX_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitTimeout}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitTimeout()
              e.currentTarget.blur()
            }
          }}
        />
        <span style={{ color: '#8b9097', fontSize: 11 }}>minutes</span>
      </div>
    </SettingControlRow>
  )
}
