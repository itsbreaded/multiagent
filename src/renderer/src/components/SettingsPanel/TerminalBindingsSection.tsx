import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { DEFAULT_HOTKEYS, buildHotkeys, type HotkeyId } from '../../utils/hotkeys'
import {
  TERMINAL_BINDING_ORDER,
  bindingDisplay,
  bindingKey,
  isCustomizedBinding,
  triggerFromEvent,
  type TerminalKeyBinding,
  type Trigger,
} from '../../utils/terminalKeyBindings'

// Well-known ids rendered in the Clipboard sub-section.
const CLIPBOARD_IDS = ['copy', 'paste']
// Well-known ids rendered in the Terminal Signals sub-section (interrupt + 9).
const SIGNAL_IDS = TERMINAL_BINDING_ORDER.filter((id) => !CLIPBOARD_IDS.includes(id))

export function TerminalBindingsSection(): JSX.Element {
  const bindings = useSettingsStore((s) => s.terminalKeyBindings)
  const hotkeyOverrides = useSettingsStore((s) => s.hotkeyOverrides)
  const setTrigger = useSettingsStore((s) => s.setTerminalKeyBindingTrigger)
  const resetOne = useSettingsStore((s) => s.resetTerminalKeyBinding)
  const resetAll = useSettingsStore((s) => s.resetAllTerminalKeyBindings)

  // Recording state for binding triggers (full-modifier).
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ id: string; message: string } | null>(null)

  const effectiveHotkeys = buildHotkeys(hotkeyOverrides)

  // Map bindingKey(trigger) -> the id that claims it, for duplicate-within-
  // terminal detection. First claimant wins (matches runtime).
  const claimantByKey = new Map<string, string>()
  for (const b of bindings) {
    const k = bindingKey(b.trigger)
    if (!claimantByKey.has(k)) claimantByKey.set(k, b.id)
  }

  function labelFor(id: string): string {
    return DEFAULT_LABELS[id] ?? bindings.find((b) => b.id === id)?.label ?? id
  }

  // --- Trigger recorder -----------------------------------------------------
  useEffect(() => {
    if (!recordingId) return
    // Bind to an explicitly-typed const: TS does not carry control-flow
    // narrowing into the nested onKeyDown closure, so a plain `const rid =
    // recordingId` would widen back to `string | null` inside it. The effect
    // re-runs whenever recordingId changes, so the closure always sees current.
    const rid: string = recordingId

    function onKeyDown(e: KeyboardEvent): void {
      // Escape cancels recording (only when no modifier held). Swallow it
      // (capture phase) so it does NOT bubble to App.tsx's global Escape handler
      // and close the settings overlay. This listener only exists while
      // recording is active, so normal Escape-to-close still works.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setRecordingId(null)
        setConflict(null)
        return
      }
      // Require at least one modifier — bare keys are not valid triggers.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) return
      // Skip bare modifier presses.
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return

      e.preventDefault()
      e.stopPropagation()

      const trigger = triggerFromEvent(e)
      const newKey = bindingKey(trigger)

      // Duplicate-within-terminal check: another binding already claims this combo.
      const owner = claimantByKey.get(newKey)
      if (owner && owner !== rid) {
        setConflict({ id: rid, message: `Already used by: ${labelFor(owner)}` })
        setRecordingId(null)
        // Auto-clear the conflict notice after a short delay (mirrors app hotkeys).
        window.setTimeout(() => setConflict(null), 2000)
        return
      }

      setTrigger(rid, trigger)
      setRecordingId(null)
      setConflict(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recordingId, bindings, claimantByKey, setTrigger])

  // --- Clash helpers (computed per render) ----------------------------------
  function appHotkeyClash(t: Trigger): { id: HotkeyId; label: string } | null {
    if (!t.ctrl && !t.meta) return null // app hotkeys require Ctrl/Meta; Alt-only combos can't clash
    for (const id of Object.keys(effectiveHotkeys) as HotkeyId[]) {
      const h = effectiveHotkeys[id]
      if (h.code === t.code && h.shift === t.shift) {
        return { id, label: DEFAULT_HOTKEYS[id].label }
      }
    }
    return null
  }

  const hasCustomized = bindings.some((b) => isCustomizedBinding(b))
  const showResetAll = hasCustomized

  function renderTriggerBadge(b: TerminalKeyBinding): JSX.Element {
    const isRecording = recordingId === b.id
    return (
      <button
        onClick={() => { setRecordingId(b.id); setConflict(null) }}
        title="Click to rebind"
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <KeyBadge active={isRecording}>
          {isRecording ? 'Press keys…' : bindingDisplay(b.trigger)}
        </KeyBadge>
      </button>
    )
  }

  function renderClashBadges(b: TerminalKeyBinding): JSX.Element | null {
    const dupOwner = claimantByKey.get(bindingKey(b.trigger))
    const badges: JSX.Element[] = []
    if (dupOwner && dupOwner !== b.id) {
      badges.push(
        <ClashBadge key="dup" tone="error">
          Duplicate of {labelFor(dupOwner)}
        </ClashBadge>
      )
    }
    const appClash = appHotkeyClash(b.trigger)
    if (appClash) {
      badges.push(
        <ClashBadge key="app" tone="warn">
          Shares key with app hotkey "{appClash.label}"
        </ClashBadge>
      )
    }
    if (badges.length === 0) return null
    return <>{badges}</>
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <SectionLabel>Terminal Key Bindings</SectionLabel>
        {showResetAll && (
          <button
            onClick={() => { resetAll(); setRecordingId(null); setConflict(null) }}
            style={resetAllBtnStyle}
          >
            Reset all
          </button>
        )}
      </div>

      {conflict && (
        <div style={errorBannerStyle}>
          {conflict.message}
        </div>
      )}
      {recordingId && (
        <div style={recordingBannerStyle}>
          Press a key combination (Ctrl/Alt/Shift + key) — Escape to cancel
        </div>
      )}

      {/* Clipboard */}
      <SubLabel>Clipboard</SubLabel>
      {CLIPBOARD_IDS.map((id) => {
        const b = bindings.find((x) => x.id === id)
        if (!b) return null
        const customized = isCustomizedBinding(b)
        return (
          <BindingRow key={id}>
            <RowLabel>{labelFor(id)}</RowLabel>
            <RowRight>
              {renderClashBadges(b)}
              {renderTriggerBadge(b)}
              {customized && <ResetBtn onClick={() => resetOne(id)} />}
            </RowRight>
          </BindingRow>
        )
      })}

      {/* Terminal Signals */}
      <div style={{ marginTop: 12 }}><SubLabel>Terminal Signals</SubLabel></div>
      {SIGNAL_IDS.map((id) => {
        const b = bindings.find((x) => x.id === id)
        if (!b) return null
        const customized = isCustomizedBinding(b)
        const seq = b.action.type === 'pty-sequence' ? b.action.sequence : ''
        return (
          <BindingRow key={id}>
            <RowLabel>
              {labelFor(id)}
              <SequenceChip>{escapeLabel(seq)}</SequenceChip>
            </RowLabel>
            <RowRight>
              {renderClashBadges(b)}
              {renderTriggerBadge(b)}
              {customized && <ResetBtn onClick={() => resetOne(id)} />}
            </RowRight>
          </BindingRow>
        )
      })}
    </>
  )
}

const DEFAULT_LABELS: Record<string, string> = {
  copy: 'Copy selection',
  paste: 'Paste from clipboard',
  interrupt: 'Send interrupt',
  eof: 'Send EOF',
  suspend: 'Suspend process',
  'clear-screen': 'Clear screen',
  'kill-line': 'Kill line',
  'kill-word': 'Kill word',
  'line-start': 'Line start',
  'line-end': 'Line end',
  'history-prev': 'Previous history',
  'history-next': 'Next history',
}

// Render a control-byte sequence as a readable label, e.g. \x03 -> "\\x03".
function escapeLabel(seq: string): string {
  const hex = seq.charCodeAt(0).toString(16).padStart(2, '0')
  return `\\x${hex}`
}

// --- Small presentational helpers -------------------------------------------

function BindingRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '7px 12px',
        marginBottom: 2,
        border: '1px solid #222326',
        borderRadius: 5,
        backgroundColor: '#141517',
        gap: 12,
      }}
    >
      {children}
    </div>
  )
}

function RowLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span style={{ color: '#c9cdd1', fontSize: 12, flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {children}
    </span>
  )
}

function RowRight({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {children}
    </div>
  )
}

function SequenceChip({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        background: '#1e1f22',
        border: '1px solid #222326',
        borderRadius: 4,
        color: '#4a4b4e',
        fontSize: 10,
        fontFamily: 'monospace',
        padding: '1px 6px',
      }}
    >
      {children}
    </span>
  )
}

function KeyBadge({ children, active }: { children: React.ReactNode; active?: boolean }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        background: active ? '#1a3a1a' : '#1e1f22',
        border: `1px solid ${active ? '#4ade80' : '#3a3b3e'}`,
        borderRadius: 4,
        color: active ? '#4ade80' : '#a0a4a8',
        fontSize: 11,
        fontFamily: 'monospace',
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function ClashBadge({ children, tone }: { children: React.ReactNode; tone: 'error' | 'warn' }): JSX.Element {
  const palette = tone === 'error'
    ? { bg: '#2a1a1a', border: '#5a2020', color: '#f87171' }
    : { bg: '#2a2410', border: '#5a4810', color: '#fbbf24' }
  return (
    <span style={{
      display: 'inline-block',
      background: palette.bg,
      border: `1px solid ${palette.border}`,
      borderRadius: 4,
      color: palette.color,
      fontSize: 10,
      padding: '2px 6px',
      maxWidth: 220,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }} title={typeof children === 'string' ? children : undefined}>
      {children}
    </span>
  )
}

function ResetBtn({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      title="Reset to default"
      style={{ background: 'none', border: 'none', color: '#4a4b4e', fontSize: 13, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
    >
      ×
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{
      padding: '6px 14px 3px',
      fontSize: 10,
      fontWeight: 600,
      color: '#4a4b4e',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
    }}>
      {children}
    </div>
  )
}

function SubLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ padding: '4px 14px 2px', fontSize: 10, fontWeight: 600, color: '#5a5f66', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

const resetAllBtnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid #3a3b3e', borderRadius: 4,
  color: '#6b7280', fontSize: 11, cursor: 'pointer', padding: '2px 8px', marginRight: 12, marginBottom: 3,
}
const errorBannerStyle: React.CSSProperties = {
  background: '#2a1a1a', border: '1px solid #5a2020', borderRadius: 5,
  color: '#f87171', fontSize: 12, padding: '6px 10px', marginBottom: 8,
}
const recordingBannerStyle: React.CSSProperties = {
  background: '#1a2a1a', border: '1px solid #205a20', borderRadius: 5,
  color: '#4ade80', fontSize: 12, padding: '6px 10px', marginBottom: 8,
}
