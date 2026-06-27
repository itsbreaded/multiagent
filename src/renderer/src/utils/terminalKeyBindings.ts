// Terminal key bindings: a global, pane-type-agnostic layer of customizable
// terminal shortcuts (copy/paste and PTY signals). Separate from the
// app-level HotkeyId system in ./hotkeys.ts (those drive window/tab/pane actions).
//
// At runtime, buildTerminalKeyMap() turns the stored binding list into a lookup
// keyed by modifier fingerprint, consumed by Terminal/index.tsx's
// attachCustomKeyEventHandler on every keydown.

import { codeToDisplayKey } from './hotkeys'

export interface Trigger {
  code: string    // KeyboardEvent.code (layout-independent physical key)
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export type TerminalBindingAction =
  | { type: 'clipboard-copy' }
  | { type: 'clipboard-paste' }
  | { type: 'pty-sequence'; sequence: string }   // well-known signal bindings only
  | { type: 'text-macro'; text: string }         // user-defined literal text

export interface TerminalKeyBinding {
  id: string               // well-known id or custom-<uuid>
  label: string            // display name
  trigger: Trigger
  action: TerminalBindingAction
}

// A resolved entry in the runtime lookup map. 'suppress' consumes the keydown
// and sends nothing to the PTY — used to neutralize a vacated default trigger
// after a signal binding is rebound (see buildTerminalKeyMap).
export type ResolvedEntry =
  | { kind: 'action'; binding: TerminalKeyBinding }
  | { kind: 'suppress' }

// --- Well-known defaults -----------------------------------------------------

interface WellKnownDef {
  id: string
  label: string
  trigger: Trigger
  action: TerminalBindingAction
}

// Order matters: it is the display order in Settings, and the first-claimant
// order used by buildTerminalKeyMap (later duplicates do not overwrite).
const WELL_KNOWN: WellKnownDef[] = [
  { id: 'copy',          label: 'Copy selection',     trigger: { code: 'KeyC', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'clipboard-copy' } },
  { id: 'paste',         label: 'Paste from clipboard', trigger: { code: 'KeyV', ctrl: true, shift: false, alt: false, meta: false }, action: { type: 'clipboard-paste' } },
  { id: 'interrupt',     label: 'Send interrupt',     trigger: { code: 'KeyC', ctrl: false, shift: false, alt: true,  meta: false }, action: { type: 'pty-sequence', sequence: '\x03' } },
  { id: 'eof',           label: 'Send EOF',           trigger: { code: 'KeyD', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x04' } },
  { id: 'suspend',       label: 'Suspend process',    trigger: { code: 'KeyZ', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x1a' } },
  { id: 'clear-screen',  label: 'Clear screen',       trigger: { code: 'KeyL', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x0c' } },
  { id: 'kill-line',     label: 'Kill line',          trigger: { code: 'KeyU', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x15' } },
  { id: 'kill-word',     label: 'Kill word',          trigger: { code: 'Backspace', ctrl: true, shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x17' } },
  { id: 'line-start',    label: 'Line start',         trigger: { code: 'KeyA', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x01' } },
  { id: 'line-end',      label: 'Line end',           trigger: { code: 'KeyE', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x05' } },
  { id: 'history-prev',  label: 'Previous history',   trigger: { code: 'KeyP', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x10' } },
  { id: 'history-next',  label: 'Next history',       trigger: { code: 'KeyN', ctrl: true,  shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x0e' } },
]

export const TERMINAL_BINDING_ORDER: string[] = WELL_KNOWN.map((d) => d.id)
export const TERMINAL_KEY_BINDINGS_VERSION = 2

export function isWellKnownId(id: string): boolean {
  return WELL_KNOWN.some((d) => d.id === id)
}

export function isCustomBindingId(id: string): boolean {
  return id.startsWith('custom-')
}

export function defaultTerminalKeyBindings(): TerminalKeyBinding[] {
  return WELL_KNOWN.map((d) => ({ ...d, trigger: { ...d.trigger }, action: cloneAction(d.action) }))
}

function cloneAction(a: TerminalBindingAction): TerminalBindingAction {
  switch (a.type) {
    case 'pty-sequence': return { type: 'pty-sequence', sequence: a.sequence }
    case 'text-macro': return { type: 'text-macro', text: a.text }
    default: return a
  }
}

// Lookup of each well-known binding's default trigger, keyed by id.
// Used to (a) reset a binding, (b) decide whether a binding is "customized",
// and (c) compute vacated-trigger suppress entries.
const DEFAULT_DEF_BY_ID: Map<string, WellKnownDef> = new Map(WELL_KNOWN.map((d) => [d.id, d]))
const APP_HANDLED_DEFAULT_IDS = new Set(['copy', 'paste', 'interrupt', 'kill-word'])
const OLD_KILL_WORD_TRIGGER: Trigger = { code: 'KeyW', ctrl: true, shift: false, alt: false, meta: false }

export function defaultTrigger(id: string): Trigger | undefined {
  const def = DEFAULT_DEF_BY_ID.get(id)
  return def ? { ...def.trigger } : undefined
}

export function defaultLabel(id: string): string | undefined {
  return DEFAULT_DEF_BY_ID.get(id)?.label
}

// Returns true if a well-known binding's trigger differs from its default.
export function isCustomizedTrigger(b: TerminalKeyBinding): boolean {
  const def = DEFAULT_DEF_BY_ID.get(b.id)
  if (!def) return true
  return !triggersEqual(b.trigger, def.trigger)
}

// Returns true if a well-known binding differs from its default.
export function isCustomizedBinding(b: TerminalKeyBinding): boolean {
  if (!isWellKnownId(b.id)) return false
  return isCustomizedTrigger(b)
}

export function triggersEqual(a: Trigger, b: Trigger): boolean {
  return a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta
}

// --- Key encoding ------------------------------------------------------------

// Fingerprint used by the runtime lookup map and the trigger recorder.
// Order: ctrl:shift:alt:meta:code. `meta` is included for completeness but is
// inert on Windows (Electron never reports e.metaKey there).
export function bindingKey(t: Trigger): string {
  return `${t.ctrl ? 1 : 0}:${t.shift ? 1 : 0}:${t.alt ? 1 : 0}:${t.meta ? 1 : 0}:${t.code}`
}

// First binding (in list order) whose trigger fingerprint equals `key`, skipping
// `excludeId`. Mirrors buildTerminalKeyMap's first-claimant rule and is the
// single conflict-detection primitive used by both the settings store and the
// settings UI, so the two never diverge on what "already claimed" means.
export function findClaimant(
  bindings: TerminalKeyBinding[],
  key: string,
  excludeId?: string | null,
): TerminalKeyBinding | undefined {
  for (const b of bindings) {
    if (excludeId && b.id === excludeId) continue
    if (bindingKey(b.trigger) === key) return b
  }
  return undefined
}

// Display label for a binding: the well-known label when applicable, else the
// stored label. Used for conflict messages so the store (which has no labelFor)
// and the UI report identical wording.
export function bindingLabel(b: TerminalKeyBinding): string {
  return defaultLabel(b.id) ?? b.label
}

export function bindingEventKey(e: KeyboardEvent): string {
  return `${e.ctrlKey ? 1 : 0}:${e.shiftKey ? 1 : 0}:${e.altKey ? 1 : 0}:${e.metaKey ? 1 : 0}:${e.code}`
}

export function triggerFromEvent(e: KeyboardEvent): Trigger {
  return { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
}

// A trigger is valid only if it names a real key (non-empty code) and includes
// a Ctrl, Alt, or Meta. Shift-only combos are rejected because they would
// hijack ordinary typing: a Shift+M macro would make every capital 'M' send the
// macro text instead, and Shift+Enter is reserved for agent-CLI multiline
// input. Shift may still combine with Ctrl/Alt/Meta. This is the single
// recordability predicate shared by the trigger recorder, the settings store,
// and persisted-binding sanitization.
export function isValidTrigger(t: Trigger): boolean {
  if (!t.code) return false
  return t.ctrl || t.alt || t.meta
}

// Human-readable combo string, e.g. "Ctrl+C", "Alt+C", "Ctrl+Shift+C".
export function bindingDisplay(t: Trigger): string {
  const parts: string[] = []
  if (t.ctrl) parts.push('Ctrl')
  if (t.shift) parts.push('Shift')
  if (t.alt) parts.push('Alt')
  if (t.meta) parts.push('Meta') // shown for completeness; effectively unused on Windows
  parts.push(codeToDisplayKey(t.code))
  return parts.join('+')
}

// --- Runtime map -------------------------------------------------------------

/**
 * Turn a binding list into a runtime lookup map.
 *
 * Pass 1 inserts every active binding at its trigger key (explicit bindings
 * always win; later duplicate triggers do not overwrite — first claimant holds).
 *
 * Pass 2 inserts a synthetic `suppress` entry for the VACATED default trigger of
 * any rebound pty-sequence binding, but only if no explicit binding already
 * claims that key. This makes a rebound signal binding truly remap: the new key
 * sends the sequence, the old key is swallowed so it doesn't fall through to
 * xterm's native handling. Suppress applies ONLY to pty-sequence bindings —
 * copy/paste rebound intentionally fall through to native behavior (e.g.
 * rebinding copy off Ctrl+C restores the native \x03 interrupt).
 */
export function buildTerminalKeyMap(bindings: TerminalKeyBinding[]): Map<string, ResolvedEntry> {
  const map = new Map<string, ResolvedEntry>()

  for (const b of bindings) {
    if (!isRuntimeActive(b)) continue
    const key = bindingKey(b.trigger)
    if (!map.has(key)) map.set(key, { kind: 'action', binding: b })
  }

  for (const b of bindings) {
    if (!isRuntimeActive(b)) continue
    if (b.action.type !== 'pty-sequence') continue
    const def = DEFAULT_DEF_BY_ID.get(b.id)
    if (!def) continue
    if (triggersEqual(b.trigger, def.trigger)) continue // not rebound
    const vacatedKey = bindingKey(def.trigger)
    if (!map.has(vacatedKey)) map.set(vacatedKey, { kind: 'suppress' })
  }

  return map
}

function isRuntimeActive(b: TerminalKeyBinding): boolean {
  if (APP_HANDLED_DEFAULT_IDS.has(b.id)) return true
  if (b.action.type !== 'pty-sequence') return true
  return isCustomizedTrigger(b)
}

// --- Persistence merge -------------------------------------------------------

/**
 * Merge stored bindings with defaults: any well-known id absent from storage is
 * appended with its default. Stored well-known entries keep their customized
 * trigger. Unknown well-known ids added in a future version are thus backfilled
 * on load.
 */
export function mergeBindings(
  stored: TerminalKeyBinding[] | undefined | null,
  opts: { migrateOldKillWordDefault?: boolean } = {},
): TerminalKeyBinding[] {
  const out: TerminalKeyBinding[] = []
  const list = Array.isArray(stored) ? stored : []

  // Well-known rows first, in canonical order, using stored data when present.
  for (const def of WELL_KNOWN) {
    const s = list.find((b) => b && b.id === def.id)
    if (s && typeof s === 'object' && isValidStoredBinding(s, def.id)) {
      const storedTrigger = sanitizeTrigger(s.trigger) ?? { ...def.trigger }
      const trigger = opts.migrateOldKillWordDefault && def.id === 'kill-word' && triggersEqual(storedTrigger, OLD_KILL_WORD_TRIGGER)
        ? { ...def.trigger }
        : storedTrigger
      out.push({
        id: def.id,
        label: def.label,
        trigger,
        action: sanitizeAction(s.action, def.id) ?? cloneAction(def.action),
      })
    } else {
      out.push({ ...def, trigger: { ...def.trigger }, action: cloneAction(def.action) })
    }
  }

  // Custom text-macro entries after well-known rows, in stored order.
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    if (isWellKnownId(s.id)) continue
    const custom = sanitizeCustomBinding(s)
    if (custom) out.push(custom)
  }

  return out
}

function isValidStoredBinding(s: unknown, id: string): boolean {
  if (!s || typeof s !== 'object') return false
  const obj = s as Record<string, unknown>
  const def = DEFAULT_DEF_BY_ID.get(id)
  if (!def) return false
  return sanitizeTrigger(obj.trigger) !== null && sanitizeAction(obj.action, id) !== null
}

function sanitizeTrigger(t: unknown): Trigger | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if (typeof o.code !== 'string' || !o.code) return null
  return {
    code: o.code,
    ctrl: o.ctrl === true,
    shift: o.shift === true,
    alt: o.alt === true,
    meta: o.meta === true,
  }
}

function sanitizeAction(a: unknown, id: string): TerminalBindingAction | null {
  if (!a || typeof a !== 'object') return null
  const def = DEFAULT_DEF_BY_ID.get(id)
  const defAction = def?.action
  const o = a as Record<string, unknown>
  if (o.type === 'clipboard-copy' || o.type === 'clipboard-paste') return { type: o.type }
  if (o.type === 'pty-sequence') {
    if (defAction?.type === 'pty-sequence') return { type: 'pty-sequence', sequence: defAction.sequence } // sequence is fixed for well-known
    return null
  }
  return null
}

function sanitizeCustomBinding(s: unknown): TerminalKeyBinding | null {
  if (!s || typeof s !== 'object') return null
  const obj = s as Record<string, unknown>
  if (typeof obj.id !== 'string' || !isCustomBindingId(obj.id)) return null
  if (typeof obj.label !== 'string' || !obj.label.trim()) return null
  const trigger = sanitizeTrigger(obj.trigger)
  if (!trigger || !isValidTrigger(trigger)) return null
  const action = sanitizeCustomAction(obj.action)
  if (!action) return null
  return { id: obj.id, label: obj.label.trim(), trigger, action }
}

function sanitizeCustomAction(a: unknown): TerminalBindingAction | null {
  if (!a || typeof a !== 'object') return null
  const o = a as Record<string, unknown>
  if (o.type !== 'text-macro' || typeof o.text !== 'string') return null
  return { type: 'text-macro', text: o.text }
}
