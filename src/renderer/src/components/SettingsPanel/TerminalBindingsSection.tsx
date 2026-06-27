import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { DEFAULT_HOTKEYS, buildHotkeys, type HotkeyId } from '../../utils/hotkeys'
import {
  TERMINAL_BINDING_ORDER,
  bindingDisplay,
  bindingKey,
  defaultLabel,
  findClaimant,
  isCustomizedBinding,
  isValidTrigger,
  isWellKnownId,
  triggerFromEvent,
  type TerminalKeyBinding,
  type Trigger,
} from '../../utils/terminalKeyBindings'
import { ui } from '../../styles/theme'

// Who the trigger recorder is currently capturing a combo for. A discriminated
// union (not a sentinel-encoded string) so the recorder dispatch is exhaustive
// and compiler-checked.
type RecordingTarget =
  | { kind: 'rebind'; id: string }   // a well-known signal/clipboard binding
  | { kind: 'newMacro' }             // the add-macro form
  | { kind: 'editMacro'; id: string } // an existing custom macro

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
  const addCustom = useSettingsStore((s) => s.addCustomTerminalKeyBinding)
  const updateCustom = useSettingsStore((s) => s.updateCustomTerminalKeyBinding)
  const removeBinding = useSettingsStore((s) => s.removeTerminalKeyBinding)

  // Recording state for binding triggers. `recording` is null when idle; the
  // recorder effect re-runs only when it (or `bindings`) actually changes, so
  // the capture-phase listener is not churned on every unrelated re-render.
  const [recording, setRecording] = useState<RecordingTarget | null>(null)
  // Conflict/error notice for the rebind + reset paths (auto-cleared).
  const [conflict, setConflict] = useState<string | null>(null)

  // Add-custom-macro form state.
  const [showAddForm, setShowAddForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newText, setNewText] = useState('')
  const [newTrigger, setNewTrigger] = useState<Trigger | null>(null)
  const [addFormError, setAddFormError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editText, setEditText] = useState('')
  const [editTrigger, setEditTrigger] = useState<Trigger | null>(null)
  const [editFormError, setEditFormError] = useState<string | null>(null)

  const customBindings = bindings.filter((b) => !isWellKnownId(b.id))

  const effectiveHotkeys = buildHotkeys(hotkeyOverrides)

  function labelFor(id: string): string {
    return defaultLabel(id) ?? bindings.find((b) => b.id === id)?.label ?? id
  }

  // --- Trigger recorder -----------------------------------------------------
  useEffect(() => {
    if (!recording) return
    // Bind to an explicitly-typed const: TS does not carry control-flow
    // narrowing into the nested onKeyDown closure, so a plain `const target =
    // recording` would widen back to `RecordingTarget | null` inside it. The
    // effect re-runs whenever `recording` or `bindings` changes, so the closure
    // always sees current values.
    const target: RecordingTarget = recording

    function onKeyDown(e: KeyboardEvent): void {
      // Escape cancels recording (only when no modifier held). Swallow it
      // (capture phase) so it does NOT bubble to App.tsx's global Escape handler
      // and close the settings overlay. This listener only exists while
      // recording is active, so normal Escape-to-close still works.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setRecording(null)
        setConflict(null)
        return
      }
      // Skip bare modifier presses (no real key yet).
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return

      const trigger = triggerFromEvent(e)
      // Reject bare keys and Shift-only combos: they would hijack ordinary
      // typing (e.g. a Shift+M macro swallows every capital 'M'; Shift+Enter is
      // reserved for agent-CLI multiline input). Stay in recording and ignore.
      if (!isValidTrigger(trigger)) return

      e.preventDefault()
      e.stopPropagation()

      const newKey = bindingKey(trigger)
      const clashMessage = (owner: TerminalKeyBinding) => `Already used by: ${labelFor(owner.id)}`

      // Dispatch on the recording target. The store is the final validation
      // authority: new/edit macros only stage the trigger here and re-validate
      // on confirm, while a rebind commits directly and surfaces any failure.
      switch (target.kind) {
        case 'newMacro': {
          const owner = findClaimant(bindings, newKey)
          if (owner) { setAddFormError(clashMessage(owner)); setRecording(null); return }
          setNewTrigger(trigger)
          setAddFormError(null)
          setRecording(null)
          return
        }
        case 'editMacro': {
          // The macro being edited is excluded as self.
          const owner = findClaimant(bindings, newKey, target.id)
          if (owner) { setEditFormError(clashMessage(owner)); setRecording(null); return }
          setEditTrigger(trigger)
          setEditFormError(null)
          setRecording(null)
          return
        }
        case 'rebind': {
          const res = setTrigger(target.id, trigger)
          setRecording(null)
          if (res.ok) {
            setConflict(null)
          } else {
            setConflict(res.message)
            window.setTimeout(() => setConflict(null), 2000)
          }
          return
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, bindings, setTrigger])

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

  const hasCustomized = bindings.some((b) => isWellKnownId(b.id) && isCustomizedBinding(b))
  const showResetAll = hasCustomized

  function resetAddForm(): void {
    setShowAddForm(false)
    setNewLabel('')
    setNewText('')
    setNewTrigger(null)
    setAddFormError(null)
    if (recording?.kind === 'newMacro') setRecording(null)
  }

  function confirmAddMacro(): void {
    const trimmed = newLabel.trim()
    if (!trimmed) {
      setAddFormError('Label is required')
      return
    }
    if (!newTrigger) {
      setAddFormError('Set a trigger key combination')
      return
    }
    // The store is the final validation authority; on failure keep the form
    // open and surface the reason.
    const res = addCustom(trimmed, newTrigger, newText)
    if (res.ok) resetAddForm()
    else setAddFormError(res.message)
  }

  function resetBinding(id: string): void {
    const res = resetOne(id)
    setConflict(res.ok ? null : res.message)
  }

  function resetAllBindings(): void {
    const res = resetAll()
    setRecording(null)
    setConflict(res.ok ? null : res.message)
  }

  function startEditMacro(b: TerminalKeyBinding): void {
    if (b.action.type !== 'text-macro') return
    resetAddForm()
    setEditingId(b.id)
    setEditLabel(b.label)
    setEditText(b.action.text)
    setEditTrigger({ ...b.trigger })
    setEditFormError(null)
    setConflict(null)
  }

  function cancelEditMacro(): void {
    if (recording !== null && recording.kind === 'editMacro' && editingId !== null && recording.id === editingId) {
      setRecording(null)
    }
    setEditingId(null)
    setEditLabel('')
    setEditText('')
    setEditTrigger(null)
    setEditFormError(null)
  }

  function confirmEditMacro(): void {
    if (!editingId || !editTrigger) return
    const trimmed = editLabel.trim()
    if (!trimmed) {
      setEditFormError('Label is required')
      return
    }
    const res = updateCustom(editingId, trimmed, editTrigger, editText)
    if (res.ok) cancelEditMacro()
    else setEditFormError(res.message)
  }

  // Single trigger-badge renderer for all three recording contexts (#rebind /
  // newMacro / editMacro). Differing only by target + which trigger state and
  // error setter they bind, they previously existed as near-duplicate functions.
  function renderTriggerBadge(
    target: RecordingTarget,
    trigger: Trigger | null,
    onStart: () => void,
  ): JSX.Element {
    const isRecording =
      recording !== null &&
      recording.kind === target.kind &&
      // newMacro has no id, so a kind match is enough; rebind and editMacro also
      // require their id to match, so recording one rebind does not flag every
      // other rebind badge. recording.kind is narrowed explicitly here because
      // the variable-vs-variable `kind` check above does not narrow it.
      (target.kind === 'newMacro' ||
        (recording.kind !== 'newMacro' && recording.id === target.id))
    return (
      <button
        onClick={onStart}
        title="Click to record trigger"
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <KeyBadge active={isRecording}>
          {isRecording ? 'Press keys…' : trigger ? bindingDisplay(trigger) : 'Set trigger…'}
        </KeyBadge>
      </button>
    )
  }

  function renderClashBadges(b: TerminalKeyBinding): JSX.Element | null {
    const dup = findClaimant(bindings, bindingKey(b.trigger), b.id)
    const badges: JSX.Element[] = []
    if (dup) {
      badges.push(
        <ClashBadge key="dup" tone="error">
          Duplicate of {labelFor(dup.id)}
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
            onClick={resetAllBindings}
            style={resetAllBtnStyle}
          >
            Reset built-in bindings
          </button>
        )}
      </div>

      {conflict && (
        <div style={errorBannerStyle}>
          {conflict}
        </div>
      )}
      {recording && (
        <div style={recordingBannerStyle}>
          Press a key combination (Ctrl/Alt/Meta + key, Shift allowed with them) — Escape to cancel
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
              {renderTriggerBadge({ kind: 'rebind', id }, b.trigger, () => { setRecording({ kind: 'rebind', id }); setConflict(null) })}
              {customized && <ResetBtn onClick={() => resetBinding(id)} />}
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
              {renderTriggerBadge({ kind: 'rebind', id }, b.trigger, () => { setRecording({ kind: 'rebind', id }); setConflict(null) })}
              {customized && <ResetBtn onClick={() => resetBinding(id)} />}
            </RowRight>
          </BindingRow>
        )
      })}

      {/* Custom Macros */}
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SubLabel>Custom Macros</SubLabel>
        {!showAddForm && (
          <button
            onClick={() => { cancelEditMacro(); setShowAddForm(true); setAddFormError(null) }}
            style={addMacroBtnStyle}
          >
            Add custom macro
          </button>
        )}
      </div>

      <div style={{ padding: '0 14px 4px', fontSize: 11, color: ui.color.textMuted, lineHeight: 1.4 }}>
        Text is sent literally to the terminal. Press Enter for a real newline; typing \n sends backslash and n.
      </div>

      {showAddForm && (
        <div style={addFormStyle}>
          <input
            type="text"
            placeholder="Label (required)"
            value={newLabel}
            onChange={(e) => { setNewLabel(e.target.value); setAddFormError(null) }}
            style={formInputStyle}
          />
          <textarea
            placeholder="Text to send"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={2}
            style={{ ...formInputStyle, resize: 'vertical', fontFamily: 'monospace' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {renderTriggerBadge({ kind: 'newMacro' }, newTrigger, () => { setRecording({ kind: 'newMacro' }); setConflict(null); setAddFormError(null) })}
            {newTrigger && appHotkeyClash(newTrigger) && (
              <ClashBadge tone="warn">
                Shares key with app hotkey "{appHotkeyClash(newTrigger)!.label}"
              </ClashBadge>
            )}
          </div>
          {addFormError && <div style={{ ...errorBannerStyle, marginBottom: 0 }}>{addFormError}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={resetAddForm} style={cancelBtnStyle}>Cancel</button>
            <button onClick={confirmAddMacro} style={confirmBtnStyle}>Add macro</button>
          </div>
        </div>
      )}

      {customBindings.map((b) => {
        const textPreview = b.action.type === 'text-macro' ? JSON.stringify(b.action.text) : ''
        if (editingId === b.id) {
          return (
            <div key={b.id} style={addFormStyle}>
              <input
                type="text"
                aria-label="Macro label"
                value={editLabel}
                onChange={(e) => { setEditLabel(e.target.value); setEditFormError(null) }}
                style={formInputStyle}
              />
              <textarea
                aria-label="Macro text"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={2}
                style={{ ...formInputStyle, resize: 'vertical', fontFamily: 'monospace' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {renderTriggerBadge({ kind: 'editMacro', id: editingId }, editTrigger, () => { setRecording({ kind: 'editMacro', id: editingId }); setConflict(null); setEditFormError(null) })}
                {editTrigger && appHotkeyClash(editTrigger) && (
                  <ClashBadge tone="warn">
                    Shares key with app hotkey "{appHotkeyClash(editTrigger)!.label}"
                  </ClashBadge>
                )}
              </div>
              {editFormError && <div style={{ ...errorBannerStyle, marginBottom: 0 }}>{editFormError}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={cancelEditMacro} style={cancelBtnStyle}>Cancel</button>
                <button onClick={confirmEditMacro} style={confirmBtnStyle}>Save changes</button>
              </div>
            </div>
          )
        }
        return (
          <BindingRow key={b.id}>
            <RowLabel>
              {b.label}
              <SequenceChip title={textPreview}>{textPreview}</SequenceChip>
            </RowLabel>
            <RowRight>
              {renderClashBadges(b)}
              {renderTriggerBadge({ kind: 'rebind', id: b.id }, b.trigger, () => { setRecording({ kind: 'rebind', id: b.id }); setConflict(null) })}
              <EditBtn onClick={() => startEditMacro(b)} />
              <DeleteBtn onClick={() => { if (editingId === b.id) cancelEditMacro(); removeBinding(b.id) }} />
            </RowRight>
          </BindingRow>
        )
      })}
    </>
  )
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

function SequenceChip({ children, title }: { children: React.ReactNode; title?: string }): JSX.Element {
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
        maxWidth: 260,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      title={title}
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

function DeleteBtn({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      title="Delete macro"
      style={{ background: 'none', border: 'none', color: ui.color.textDim, fontSize: 13, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
    >
      ×
    </button>
  )
}

function EditBtn({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      title="Edit macro"
      style={{ background: 'none', border: 'none', color: ui.color.textMuted, fontSize: 11, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
    >
      Edit
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
const addMacroBtnStyle: React.CSSProperties = {
  background: 'none', border: `1px solid ${ui.color.textFaint}`, borderRadius: 4,
  color: ui.color.accent, fontSize: 11, cursor: 'pointer', padding: '2px 8px', marginRight: 12,
}
const addFormStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  padding: '10px 12px', margin: '4px 0 8px',
  border: `1px solid ${ui.color.borderSubtle}`, borderRadius: ui.radius.md, backgroundColor: ui.color.input,
}
const formInputStyle: React.CSSProperties = {
  background: ui.color.panelRaised, border: `1px solid ${ui.color.textFaint}`, borderRadius: 4,
  color: ui.color.text, fontSize: 12, padding: '6px 8px', width: '100%', boxSizing: 'border-box',
}
const cancelBtnStyle: React.CSSProperties = {
  background: 'none', border: `1px solid ${ui.color.textFaint}`, borderRadius: 4,
  color: ui.color.textMuted, fontSize: 11, cursor: 'pointer', padding: '4px 10px',
}
const confirmBtnStyle: React.CSSProperties = {
  background: ui.color.accentBg, border: `1px solid ${ui.color.accent}`, borderRadius: 4,
  color: ui.color.accent, fontSize: 11, cursor: 'pointer', padding: '4px 10px',
}
