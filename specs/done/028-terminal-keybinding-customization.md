# 028 — Terminal Keybinding Customization

## Problem

Terminal keybindings are currently split into two hardcoded tiers that cannot be customized together:

1. **App-level hotkeys** (`utils/hotkeys.ts`): 9 actions (new tab, split pane, etc.) — configurable via Settings.
2. **Terminal-level shortcuts** (`Terminal/index.tsx`): Copy (`Ctrl+Shift+C`) and paste (`Ctrl+Shift+V`) — hardcoded, not customizable.

Users who want `Ctrl+C` / `Ctrl+V` for copy/paste have no way to do it, and no way to remap the PTY interrupt signal (`\x03`) that `Ctrl+C` currently sends. There's also no mechanism to rebind other standard terminal signals (EOF, suspend, etc.).

## Current Behavior

- `Ctrl+Shift+C`: copies xterm selection to clipboard (hardcoded in `Terminal/index.tsx:241`)
- `Ctrl+Shift+V`: pastes from clipboard (hardcoded in `Terminal/index.tsx:248`)
- `Ctrl+C` in terminal: xterm passes `\x03` (ETX/interrupt) to the PTY — always, with no interception possible
- All other standard terminal signals (`Ctrl+D`, `Ctrl+Z`, `Ctrl+L`, etc.) pass through xterm natively
- Settings UI shows these three shortcuts in a read-only "Terminal Shortcuts (Fixed)" table

## Intended Behavior

### Default keybinding changes

| Action | Old default | New default |
|---|---|---|
| Copy selection | `Ctrl+Shift+C` | `Ctrl+C` |
| Paste from clipboard | `Ctrl+Shift+V` | `Ctrl+V` |
| Send interrupt (`\x03`) | `Ctrl+C` (xterm passthrough) | `Alt+C` |

The old `Ctrl+Shift+C` and `Ctrl+Shift+V` bindings are removed as defaults. Users who want them back can rebind the `copy`/`paste` triggers to those combos.

### Copy semantics

`Ctrl+C` always consumes the event — `\x03` is never sent. If xterm has a non-empty selection, it copies to clipboard. If nothing is selected, the event is swallowed silently. To interrupt a running process, use `Alt+C`.

### Ctrl+V paste path

`Ctrl+V` is caught by the terminal binding handler. The handler calls `xterm.paste()` and calls `preventDefault()` on the keydown event to suppress the browser's native paste event. The existing double-paste guard in `Terminal/index.tsx:312-320` must be verified to remain correct under this path and is not removed.

### New system: terminal key bindings

A new `terminalKeyBindings` list stored in settings, separate from `hotkeyOverrides`. Bindings are global — they apply identically to all pane types (shell and agent). Each entry maps a key combo to one of three action types:

```ts
type TerminalBindingAction =
  | { type: 'clipboard-copy' }
  | { type: 'clipboard-paste' }
  | { type: 'pty-sequence'; sequence: string }   // well-known signal bindings only
```

- **`clipboard-copy`**: intercept key, copy xterm selection to clipboard (silent no-op if nothing selected). Always consumes event.
- **`clipboard-paste`**: intercept key, call `xterm.paste()` and `preventDefault()`.
- **`pty-sequence`**: intercept key, write a fixed byte sequence to the PTY. Used only by well-known signal bindings (interrupt, eof, suspend, etc.) — users do not edit the sequence, only the trigger key.

App hotkeys (`HotkeyId`) are **not** a terminal binding action type — the existing dispatch table inside `attachCustomKeyEventHandler` already handles that path and is unchanged.

> **Out of scope:** custom text-macro bindings (`text-macro` action, arbitrary literal strings on custom key combos) are deferred to spec **029-terminal-text-macros.md**. This spec covers only the well-known clipboard and signal bindings.

### Well-known bindings

Stable IDs, fixed sequences, user-rebindable triggers:

| ID | Default trigger | PTY sequence |
|---|---|---|
| `copy` | Ctrl+C | — (clipboard) |
| `paste` | Ctrl+V | — (clipboard) |
| `interrupt` | Alt+C | `\x03` |
| `eof` | Ctrl+D | `\x04` |
| `suspend` | Ctrl+Z | `\x1a` |
| `clear-screen` | Ctrl+L | `\x0c` |
| `kill-line` | Ctrl+U | `\x15` |
| `kill-word` | Ctrl+Backspace | `\x17` |
| `line-start` | Ctrl+A | `\x01` |
| `line-end` | Ctrl+E | `\x05` |
| `history-prev` | Ctrl+P | `\x10` |
| `history-next` | Ctrl+N | `\x0e` |

Users can change the trigger for any row. The PTY sequence shown in the table is informational — it is not editable.

Signal bindings are shown as normal key bindings, but their default triggers are handled by xterm natively where possible. Users do not see or manage this implementation detail. `kill-word` intentionally defaults to `Ctrl+Backspace` and is app-handled so it does not clash with the app-level `Ctrl+W` close-tab hotkey. When a user changes a signal binding's trigger, the app automatically intercepts the new trigger and sends the fixed PTY sequence.

### True remap semantics for signal bindings

When a signal binding is rebound (e.g. `eof` moved from Ctrl+D to Ctrl+Q):

- Ctrl+Q is intercepted → sends `\x04` to PTY.
- Ctrl+D, the vacated original key, is also intercepted and **suppressed** — the event is consumed and nothing is sent to PTY.

This suppression is achieved by inserting a synthetic `suppress` entry for the original trigger into the intercept map alongside the rebound binding. The suppress entry has lower priority than any explicit binding: if another explicit binding already claims the original trigger, that binding wins and the suppress is skipped.

The `buildTerminalKeyMap` utility is responsible for generating these suppress entries automatically from the diff between default triggers and current triggers.

### Key event evaluation order in `attachCustomKeyEventHandler`

The handler runs in this order on every `keydown`:

1. **Shift+Enter** agent newline injection (existing, unchanged)
2. **Terminal key binding lookup** (`buildTerminalKeyMap`) — runs on all keydowns regardless of modifier. This is where copy, paste, interrupt (Alt+C), and any rebound signals are handled. Must be **outside and before** the existing `if (mod)` gate so that Alt-only combos (e.g. Alt+C) are reachable.
3. **App hotkey dispatch** (existing `if (mod)` block, unchanged)
4. **Escape** overlay close (existing, unchanged)

### Clash detection

Two clash categories with distinct UI treatment:

1. **Duplicate trigger within terminal bindings**: two bindings share the same key combo. The newly recorded trigger is refused — recording is cancelled and an inline error is shown (`"Already used by: <label>"`). Nothing is persisted. Matches the existing app hotkey conflict UX.

2. **Terminal binding clashes with app hotkey**: a terminal binding trigger matches a configured `HotkeyId`. Shown as a yellow inline warning on both rows (terminal wins when terminal is focused; app hotkey fires otherwise). Allowed but flagged. Also checked bidirectionally: recording an app hotkey warns if it matches a terminal binding.

There is no user-facing "intercept" toggle. The app keeps an interrupt binding active at all times, so Ctrl+C copy does not leave users without a way to stop a running process.

## Storage Model

`terminalKeyBindings` is added to `SettingsState` in `store/settings.ts`:

```ts
interface TerminalKeyBinding {
  id: string               // stable well-known ID
  label: string            // display name; derived from id
  trigger: {
    code: string           // KeyboardEvent.code
    ctrl: boolean
    shift: boolean
    alt: boolean
    meta: boolean
  }
  action: TerminalBindingAction
}

// In SettingsState:
terminalKeyBindings: TerminalKeyBinding[]
terminalKeyBindingsVersion: number
setTerminalKeyBindingTrigger: (id: string, trigger: TerminalKeyBinding['trigger']) => void
resetTerminalKeyBinding: (id: string) => void
resetAllTerminalKeyBindings: () => void
```

Persisted to localStorage under the existing `multiagent:settings` key. On load, well-known binding IDs absent from storage are merged with their defaults.

`terminalKeyBindingsVersion` is used for one-time migrations. Version 2 migrates the old `kill-word` default from `Ctrl+W` to `Ctrl+Backspace`; after migration, a user can intentionally rebind `kill-word` back to `Ctrl+W` and that choice persists.

## Implementation Phases

### Phase 1: Data model and default behavior change

- Add `TerminalKeyBinding` type and `terminalKeyBindings` to settings store with defaults.
- Implement `buildTerminalKeyMap(bindings): Map<string, TerminalKeyBinding>`:
  - Map key = `ctrl:shift:alt:meta:code`
  - `copy`, `paste`, `interrupt`, and `kill-word` are always active.
  - Default native signal triggers pass through to xterm.
  - For each signal binding whose trigger differs from its default, intercept the new trigger and also insert a suppress entry for the original default trigger (unless another binding already claims that combo).
- Refactor `Terminal/index.tsx` `attachCustomKeyEventHandler`:
  - Remove hardcoded Ctrl+Shift+C/V blocks entirely
  - Insert the terminal binding lookup **before** the `if (mod)` gate (step 2 in evaluation order above)
  - On match: execute action (clipboard-copy, clipboard-paste with `preventDefault`, pty-sequence write), return `stop()`
  - On miss: fall through to existing logic unchanged
- Bindings are read from `useSettingsStore.getState()` at event time — no re-attachment needed.

### Phase 2: Settings UI

- Replace the read-only "Terminal Shortcuts (Fixed)" table with an editable **Terminal Key Bindings** section.
- Two sub-sections: **Clipboard** (copy, paste), **Terminal Signals** (interrupt + 9 signal rows).
- Each well-known row: label, PTY sequence chip (read-only), current trigger badge (click to record), reset-to-default button (shown when trigger differs from default).
- Clash badge inline per row (error / yellow warning) per categories above.
- Clash detection: duplicate trigger refuses recording (same UX as app hotkeys). App hotkey cross-check shown as yellow warning, not a block.

### Phase 3: Bidirectional app hotkey clash check

- When recording an app hotkey (`SettingsPanel` recording flow), also check the new trigger against `terminalKeyBindings` and show yellow warning if matched.
- Check both Ctrl and Meta terminal triggers because app hotkeys fire with either Ctrl or Meta.

## Risks

- **Ctrl+C behavior change is a breaking default**: existing users lose Ctrl+C interrupt immediately. Mitigated by the always-active Alt+C interrupt binding. Consider a one-time migration toast on first launch post-update.
- **Suppress entry collisions**: `buildTerminalKeyMap` must not insert a suppress entry for a vacated key if another binding already claims it. Failure silently kills the other binding. Needs a unit test covering this case.
- **Ctrl+V double-paste**: `preventDefault` on keydown suppresses the native paste event in Chrome/Electron in most cases, but verify in the existing double-paste guard path (`Terminal/index.tsx:312-320`) remains correct. If the guard checks for a native paste event it may need updating since that event is now suppressed.
- **Agent Shift+Enter ordering**: the existing Shift+Enter agent newline block must remain before the terminal binding lookup (step 1 before step 2). A terminal binding rebound to Shift+Enter would be silently shadowed by the agent block. Document this in a code comment; do not remove the ordering without verifying Codex/Claude newline behavior.
- **Meta key on Windows**: `e.metaKey` is always false in Electron on Windows. Supported in the data model but must not be presented as a viable modifier in the trigger recorder UI.
- **Passthrough default signals**: default signal keys such as Ctrl+D and Ctrl+Z should continue to be handled by xterm natively. Rebound signal keys are intercepted automatically.

## Verification

- [ ] Default: `Ctrl+C` copies selected text; no `\x03` sent to PTY.
- [ ] Default: `Ctrl+C` with no selection swallows event silently; no `\x03` sent.
- [ ] Default: `Alt+C` sends `\x03` to PTY (visible as `^C` in shell).
- [ ] Default: `Ctrl+V` pastes clipboard via `xterm.paste()`; browser native paste event does not also fire.
- [ ] Default: `Ctrl+D` sends EOF (xterm passthrough, not intercepted by the app).
- [ ] Default: `Ctrl+Z` suspends process (xterm passthrough, not intercepted).
- [ ] Default: `Ctrl+Backspace` sends kill-word (`\x17`) without clashing with app close-tab (`Ctrl+W`).
- [ ] Rebinding `eof` from Ctrl+D to Ctrl+Q: Ctrl+Q sends `\x04`; Ctrl+D sends nothing (suppress entry).
- [ ] Rebinding `copy` trigger to `Ctrl+Shift+C`: `Ctrl+C` falls through to xterm and sends `\x03`.
- [ ] Duplicate trigger in terminal bindings: recording is refused with inline error; nothing saved.
- [ ] Terminal binding matching an app hotkey: yellow warning on both rows; both still function.
- [ ] With `copy` on Ctrl+C, `interrupt` remains available on Alt+C.
- [ ] All well-known bindings reset individually and collectively via reset buttons.
- [ ] Default signal rows do not intercept — xterm handles the key natively.
