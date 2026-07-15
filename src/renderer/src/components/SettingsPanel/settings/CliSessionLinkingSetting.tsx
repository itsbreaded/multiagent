import { useEffect } from 'react'
import { useSettingsStore } from '../../../store/settings'
import { checkStyle, SettingControlRow } from './shared'

// spec 047 phase 3 / phase 4: managed SessionStart hooks for session linking. Default-ON.
// Writes a managed SessionStart hook into ~/.claude/settings.json AND ~/.codex/hooks.json,
// plus the `[features] hooks = true` flag in ~/.codex/config.toml, so launched and
// CLI-launched agent sessions link to their pane (including across in-pane resume/fork) and
// resume on restart. Reversible from this same toggle; touches nothing else. Main is the
// authority — hydrate the checkbox from it so a stale local default can't drift.
export function CliSessionLinkingSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.cliSessionLinking)
  const setValue = useSettingsStore((s) => s.setCliSessionLinking)
  const hydrate = useSettingsStore((s) => s.hydrateCliSessionLinking)

  useEffect(() => {
    window.ipc.invoke('settings:get-cli-session-linking').then((v) => {
      hydrate(v === true)
    }).catch(() => { /* leave local default */ })
  }, [hydrate])

  return (
    <SettingControlRow
      title="Session linking (managed hooks)"
      description="Links agent sessions to their pane and resumes them on restart by installing a managed SessionStart hook in ~/.claude/settings.json and ~/.codex/hooks.json (plus the [features] hook flag in ~/.codex/config.toml). On by default; uninstallable from this same toggle; preserves all unrelated settings/hooks. Claude links automatically; Codex links after you trust the hook once via codex /hooks (app-launched and CLI-launched alike)."
    >
      <label style={checkStyle}>
        <input type="checkbox" checked={value} onChange={(e) => setValue(e.target.checked)} />
        Enabled
      </label>
    </SettingControlRow>
  )
}
