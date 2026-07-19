import { useEffect } from 'react'
import { useSettingsStore } from '../../../store/settings'
import { checkStyle, SettingControlRow } from './shared'

// spec 050: the default-ON terminal-output observer for fatal agent errors the hooks
// cannot report -- notably Codex provider-compat failures (Codex has no StopFailure hook
// and no error hook, so a fatal API error prints to the terminal and the badge otherwise
// stays stuck on `working`). Complementary, NOT full status: hooks remain authoritative
// wherever they exist, and this matches only two canonical Codex fatal-output signatures
// from a rolling fresh-output buffer (never scrollback, never broad keywords -- that was
// the 048 failure). Fully independent of the managed-hooks toggle: one, both, or neither
// all work. Codex-only at launch; agent-agnostic plumbing. Read-only observer -- installs
// no hooks and mutates no agent config.
export function AgentStatusScrapingSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.agentStatusScraping)
  const setValue = useSettingsStore((s) => s.setAgentStatusScraping)
  const hydrate = useSettingsStore((s) => s.hydrateAgentStatusScraping)

  useEffect(() => {
    window.ipc.invoke('settings:get-terminal-status-scraping').then((v) => {
      hydrate(v === true)
    }).catch(() => { /* leave local default */ })
  }, [hydrate])

  return (
    <SettingControlRow
      title="Detect fatal agent errors from terminal output"
      description="Complementary error detector (on by default). Watches agent terminal output for canonical fatal-output signatures -- today, Codex provider-compat failures (e.g. unexpected status 4xx/5xx with a url, or API failed after N retries) that print to the terminal but emit no hook, so the badge would otherwise stay stuck on working. Feeds the same status reducer as the managed hooks; the two are independent and all on/off combinations are valid. Codex-only at launch; does not install any hooks or modify agent config."
    >
      <label style={checkStyle}>
        <input type="checkbox" checked={value} onChange={(e) => setValue(e.target.checked)} />
        Enabled
      </label>
    </SettingControlRow>
  )
}
