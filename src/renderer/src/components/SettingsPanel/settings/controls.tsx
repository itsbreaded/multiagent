import { useEffect, useState } from 'react'
import {
  DEFAULT_TERMINAL_SCROLLBACK_LINES, MAX_CONTRAST_RATIO, MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_CONTRAST_RATIO, MIN_TERMINAL_SCROLLBACK_LINES, normalizeContrastRatio,
  normalizeTerminalScrollbackLines, useSettingsStore, type GpuAccelerationPref,
} from '../../../store/settings'
import { ui } from '../../../styles/theme'

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }): JSX.Element {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '9px 14px', borderBottom: `1px solid ${ui.color.borderSubtle}` }}>
    <div><div style={{ color: ui.color.text, fontSize: 12 }}>{title}</div><div style={{ color: ui.color.textDim, fontSize: 11, marginTop: 2 }}>{description}</div></div>{children}
  </div>
}
const checkStyle = { display: 'flex', alignItems: 'center', gap: 8, color: ui.color.text, fontSize: 12 } as const
const inputStyle = { width: 80, backgroundColor: '#0e0f11', border: `1px solid ${ui.color.textFaint}`, borderRadius: 4, color: '#d4d4d4', fontSize: 12, padding: '5px 7px', textAlign: 'right' } as const
function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return <button onClick={onClick} style={{ padding: '4px 12px', background: active ? ui.color.control : 'none', border: `1px solid ${active ? ui.color.accent : ui.color.border}`, borderRadius: ui.radius.sm, color: active ? ui.color.text : ui.color.textMuted, fontSize: 12, cursor: 'pointer', fontWeight: active ? 500 : 400 }}>{children}</button>
}
export function GitBranchBadgesSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.showGitBranchBadges); const setValue = useSettingsStore((s) => s.setShowGitBranchBadges)
  return <Row title="Git branch badges" description="Show the current branch beside tab default directories and pane directories."><label style={checkStyle}><input type="checkbox" checked={value} onChange={(e) => setValue(e.target.checked)} />Enabled</label></Row>
}
export function TabOverflowSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.tabOverflowMode); const setValue = useSettingsStore((s) => s.setTabOverflowMode)
  return <Row title="Tab overflow" description="Scroll keeps tabs in a single row; Wrap grows to additional rows."><div style={{ display: 'flex', gap: 6 }}>{(['scroll', 'wrap'] as const).map((mode) => <Choice key={mode} active={value === mode} onClick={() => setValue(mode)}>{mode[0].toUpperCase() + mode.slice(1)}</Choice>)}</div></Row>
}
export function OptimizedRendererSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.optimizedTerminalRenderer); const setValue = useSettingsStore((s) => s.setOptimizedTerminalRenderer)
  return <Row title="Optimized renderer" description="Use the environment-aware backend registry. Disable to revert to legacy unconditional WebGL behavior. Applies to new panes."><label style={checkStyle}><input type="checkbox" checked={value} onChange={(e) => setValue(e.target.checked)} />Enabled</label></Row>
}
export function GpuAccelerationSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.terminalGpuAcceleration); const setValue = useSettingsStore((s) => s.setTerminalGpuAcceleration)
  return <Row title="GPU acceleration" description="auto avoids software-rendered WebGL (the CPU spike trap). on always attempts WebGL. off always uses the DOM renderer. Applies to new panes."><div style={{ display: 'flex', gap: 6 }}>{(['auto', 'on', 'off'] as GpuAccelerationPref[]).map((mode) => <Choice key={mode} active={value === mode} onClick={() => setValue(mode)}>{mode}</Choice>)}</div></Row>
}
export function ContrastRatioSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.terminalMinimumContrastRatio); const setValue = useSettingsStore((s) => s.setTerminalMinimumContrastRatio); const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value]); const commit = (): void => { const next = normalizeContrastRatio(Number(draft)); setValue(next); setDraft(String(next)) }
  return <Row title="Minimum contrast ratio" description={`1 = no color adjustment (preserves exact agent colors). Range ${MIN_CONTRAST_RATIO}–${MAX_CONTRAST_RATIO}. Applies immediately.`}><input style={inputStyle} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur() } }} /></Row>
}
export function RescaleGlyphsSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.terminalRescaleOverlappingGlyphs); const setValue = useSettingsStore((s) => s.setTerminalRescaleOverlappingGlyphs)
  return <Row title="Rescale overlapping glyphs" description="Shrink wide or ambiguous-width characters so they don't bleed into adjacent cells. WebGL renderer only — no effect on DOM renderer."><label style={checkStyle}><input type="checkbox" checked={value} onChange={(e) => setValue(e.target.checked)} />Enabled</label></Row>
}
export function ScrollbackSetting(): JSX.Element {
  const value = useSettingsStore((s) => s.terminalScrollbackLines); const setValue = useSettingsStore((s) => s.setTerminalScrollbackLines); const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value]); const commit = (): void => { const next = normalizeTerminalScrollbackLines(Number(draft)); setValue(next); setDraft(String(next)) }
  return <Row title="Scrollback lines" description="Maximum retained terminal history. Applies immediately; lowering this can trim existing scrollback."><div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}><input style={{ ...inputStyle, width: 120 }} value={draft} min={MIN_TERMINAL_SCROLLBACK_LINES} max={MAX_TERMINAL_SCROLLBACK_LINES} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur() } }} /><div style={{ display: 'flex', gap: 6 }}>{[50_000, 100_000, DEFAULT_TERMINAL_SCROLLBACK_LINES].map((preset) => <Choice key={preset} active={value === preset} onClick={() => { setValue(preset); setDraft(String(preset)) }}>{preset >= 1_000_000 ? `${preset / 1_000_000}m` : `${preset / 1000}k`}</Choice>)}</div></div></Row>
}
