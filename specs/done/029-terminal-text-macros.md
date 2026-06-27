# 029 — Terminal Text Macros (Custom Key Bindings)

Status: **DONE.** Custom macros can be created, edited, rebound, persisted, and deleted.

## Problem

Spec 028 (Terminal Keybinding Customization) shipped customizable copy/paste and well-known PTY-signal bindings, but explicitly deferred the "custom text macro" feature. Users still cannot bind an arbitrary key combo to send a fixed literal string to the PTY (e.g. `Ctrl+G` → `git status\n`, `Ctrl+J` → `exit\n`).

## Pre-implementation Behavior

- The terminal key-binding system (`src/renderer/src/utils/terminalKeyBindings.ts`) handles only the well-known bindings: `clipboard-copy`, `clipboard-paste`, and `pty-sequence` (interrupt, eof, suspend, etc.).
- There is no `text-macro` action type, no custom-binding storage, and no UI to add one.
- The `TerminalKeyBinding.id` field is populated only by stable well-known IDs.

## Intended Behavior

Add a fourth binding action type:

```ts
type TerminalBindingAction =
  | { type: 'clipboard-copy' }
  | { type: 'clipboard-paste' }
  | { type: 'pty-sequence'; sequence: string }
  | { type: 'text-macro'; text: string }   // <-- new
```

A `text-macro` binding intercepts its trigger key and writes a literal UTF-8 string to the PTY. The input field accepts plain text exactly as typed — **no escape-sequence parsing**. `\n` typed in the field is two characters (backslash, n); to send a real newline the user presses Enter in the field.

### Custom binding lifecycle

- Added via an **Add custom macro** button under a new **Custom Macros** sub-section in Settings → Hotkeys → Terminal Key Bindings (below Terminal Signals).
- Each custom entry has:
  - A **label** (free text, required).
  - A **trigger** key combo, recorded via the same full-modifier recorder used by the well-known rows (supports Ctrl/Alt/Shift + key).
  - A **plain text** payload sent on trigger.
- Custom entries get `id: 'custom-<uuid>'`.
- Custom rows have **edit** and **delete** buttons. Editing uses an inline form and
  atomically updates the label, trigger, and literal payload. No reset button is
  shown because custom entries have no default to restore.
- Custom bindings participate in clash detection identically to well-known bindings:
  - Duplicate trigger within terminal bindings → recording refused, inline error, nothing saved.
  - Trigger matching an app hotkey → yellow warning (allowed).

### Key event evaluation

`text-macro` is handled in the existing terminal-binding lookup in `Terminal/index.tsx` `attachCustomKeyEventHandler` (step 2, before the app-hotkey gate). On match: write the literal text to the PTY via `pty:write` and consume the event.

## Storage Model

Extend the existing `terminalKeyBindings` list in `SettingsState` (`store/settings.ts`). Custom entries are persisted alongside well-known ones under the same `multiagent:settings` localStorage key.

New store actions (re-add what 028 deferred):

```ts
addCustomTerminalKeyBinding: (label: string, trigger: Trigger, text: string) => void
updateCustomTerminalKeyBinding: (id: string, label: string, trigger: Trigger, text: string) => void
removeTerminalKeyBinding: (id: string) => void
```

`mergeBindings` (load-time) must preserve custom entries (`id` not in the well-known set) verbatim, in stored order, after the well-known rows. Validate shape on load: a custom entry must have a string `id`, string `label`, valid `trigger`, and `action.type === 'text-macro'`.

## Implementation Phases

### Phase 1: Data model + runtime

- Re-add `{ type: 'text-macro'; text: string }` to `TerminalBindingAction`.
- Extend `buildTerminalKeyMap` to handle `text-macro` (custom macro entries are active whenever present; just ensure the action is dispatched).
- Re-add the custom-entry preservation path to `mergeBindings` + validation helpers.
- Add the `text-macro` case to the terminal handler switch in `Terminal/index.tsx`:
  ```ts
  case 'text-macro': {
    const ptyId = ptyIdRef.current
    if (ptyId) window.ipc.send('pty:write', ptyId, b.action.text)
    return stop()
  }
  ```
- Re-add `addCustomTerminalKeyBinding` / `removeTerminalKeyBinding` to the settings store.
- Add `updateCustomTerminalKeyBinding` for atomic edits. Store mutations reject
  blank labels, unknown/non-custom IDs, and duplicate triggers even when called
  outside the settings UI.

### Phase 2: UI

- Add a **Custom Macros** sub-section below Terminal Signals in `TerminalBindingsSection`.
- **Add custom macro** button → inline form: label input, trigger recorder, plain-text input. Confirm validates label non-empty + trigger set + not clashing.
- Render custom rows: label, bounded text preview (e.g. `JSON.stringify(text)`), trigger badge, edit button, and delete button.
- **Edit** opens the same fields with current values. Saving validates conflicts
  while excluding the macro's own trigger, then persists all fields together;
  cancelling leaves the stored macro unchanged.

## Risks

- **Literal text**: emphasize in the UI that the payload is sent verbatim. Multi-line payloads require real newlines (Enter in the field), not `\n`.
- **Suppress interaction**: custom macros are not signal bindings, so they never generate suppress entries (that logic is `pty-sequence`-only). A custom macro on a vacated signal default key correctly overrides the suppress entry because explicit bindings are inserted in pass 1 of `buildTerminalKeyMap`, before suppress entries in pass 2.
- **Meta on Windows**: the recorder captures `meta` but it is inert on Windows; do not present it as a viable modifier.
- **Reset collisions**: a macro may intentionally occupy the vacated default of a
  rebound signal. Individual and reset-all operations must refuse a reset that
  would create a duplicate trigger, leaving both bindings unchanged.

## Verification

- [ ] Add custom macro `Ctrl+G` → `git status` + real newline: triggering types the full command and submits it.
- [ ] Payload is literal — `\n` in the field is two characters, not a newline.
- [ ] Duplicate trigger refused with inline error; nothing saved.
- [ ] Custom macro on a vacated signal default key (e.g. Ctrl+D after rebinding `eof`) sends the macro text (suppress overridden).
- [ ] Custom rows can be deleted individually.
- [ ] Existing custom rows can edit label, trigger, and payload; Cancel makes no changes.
- [ ] Editing to a duplicate trigger is refused; editing without changing the trigger succeeds.
- [ ] Custom bindings persist across reload; well-known defaults still merge correctly.
