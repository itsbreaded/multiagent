# 018 — Recent Directories Combobox

## Problem

Every time a directory-picker form opens, it automatically launches the Electron native
`showOpenDialog`. This is disruptive: users who repeat common directories (same project
folder, same dev root) are forced through a system dialog every time. There is no memory
of previously chosen paths.

## Current Behavior

`DirPicker/index.tsx` accepts an `autoBrowse` prop. When truthy it calls `browse()` on
mount, which immediately fires `window.ipc.invoke('dialog:pick-directory', …)` — popping
the system file picker before the user has done anything.

Even without `autoBrowse`, the only way to choose a directory is the "Browse…" button,
which always opens the system dialog.

## Intended Behavior

1. **No automatic dialog.** Remove all `autoBrowse` auto-launch behavior. The system
   dialog is opened only when the user explicitly clicks "Browse…".

2. **Combobox input.** Replace the plain text input with a combobox: a text field that
   opens a dropdown of recent directories when focused (or when the user clicks a
   chevron). Typing filters the list by substring match (case-insensitive). Selecting a
   recent item fills the input; pressing Confirm acts as normal.

3. **Recents store.** Persist up to 20 recent directories in
   `<userData>/recent-dirs.json`, ordered most-recent-first, deduplicated by
   case-insensitive normalized path. A directory is recorded only on `onConfirm` (not on
   browse/type). This means recents grow naturally as the user actually uses directories.

4. **Scope.** All DirPicker call sites get the combobox, including the repair dialogs
   (SessionBrowser, SessionRow, Terminal pane repair) — recents are useful there too
   since moved projects often land in familiar destinations.

## Components Affected

| Call site | File | Feature |
|---|---|---|
| DirPicker (core) | `src/renderer/src/components/DirPicker/index.tsx` | Combobox + no autoBrowse |
| PaneGrid | `src/renderer/src/components/PaneGrid/index.tsx` | New session in dir |
| PaneHeader | `src/renderer/src/components/PaneHeader/index.tsx` | Split pane in dir |
| TabBar | `src/renderer/src/components/TabBar/index.tsx` | Set tab default dir |
| TabSections | `src/renderer/src/components/Sidebar/TabSections.tsx` | Tab default + spawn |
| SessionBrowser | `src/renderer/src/components/SessionBrowser/index.tsx` | Repair session dir |
| SessionRow | `src/renderer/src/components/Sidebar/SessionRow.tsx` | Repair session dir |
| Terminal | `src/renderer/src/components/Terminal/index.tsx` | Repair pane dir |

## Implementation Phases

### Phase 1 — Main Process: Recents Store

**New file:** `src/main/recentDirs.ts`

```ts
// Reads/writes <userData>/recent-dirs.json
// Exported API:
//   getRecentDirs(): string[]        // most-recent first, max 20
//   addRecentDir(dir: string): void  // dedup + prepend + trim + write
```

- Use `app.getPath('userData')` for the file location.
- Normalize paths with `path.normalize()` before dedup comparison (case-insensitive on
  Windows via `.toLowerCase()`).
- Write is synchronous (`fs.writeFileSync`) — the list is tiny.
- Max 20 entries (trim tail on write).

**IPC handlers** in `src/main/ipc/handlers.ts`:

```ts
ipcMain.handle('dirs:recent-get', () => getRecentDirs())
ipcMain.handle('dirs:recent-add', (_e, dir: string) => addRecentDir(dir))
```

**Type additions** in `src/shared/types.ts`:

```ts
// InvokeChannels
'dirs:recent-get': () => string[]
'dirs:recent-add': (dir: string) => void
```

### Phase 2 — DirPicker Component Rewrite

**Remove:**
- `autoBrowse` prop and the `useEffect` that calls `browse()` on mount.
- All call sites that pass `autoBrowse` (search for `autoBrowse` — remove prop usage).

**Add:**
- On mount, invoke `dirs:recent-get` and store in local state `recentDirs`.
- Replace the `<input type="text">` with a combobox:
  - `<input>` for typed value (same as before, same validation)
  - A chevron button (▾) that toggles the dropdown open/closed
  - A `<ul>` dropdown (absolutely positioned below input) listing `recentDirs` filtered
    by the current input substring, case-insensitive. Show all recents when input is
    empty.
  - Clicking a list item sets `value` to that path and closes dropdown.
  - Keyboard: `ArrowDown`/`ArrowUp` moves highlight, `Enter` selects highlighted,
    `Escape` closes.
  - Click outside closes dropdown (use a `useEffect` + `mousedown` listener on
    `document`).
  - Empty state (no recents, or no filter match): show "No recent directories" as a
    disabled list item.
- On `onConfirm` call: invoke `dirs:recent-add(confirmedDir)` before calling the
  prop callback.

**Props interface change:** Remove `autoBrowse?: boolean`. Keep everything else.

### Phase 3 — Call Site Cleanup

- Remove all `autoBrowse` prop usages across PaneGrid, PaneHeader, TabBar, TabSections,
  SessionBrowser, SessionRow, Terminal.
- No other call-site changes are needed (the combobox is internal to DirPicker).

## Data Shape

```json
// <userData>/recent-dirs.json
["C:\\Code\\myproject", "C:\\Users\\chris\\dev\\other", "D:\\work\\api"]
```

Plain JSON array, most-recent first. Max 20 items. No timestamps or metadata needed.

## Risks

- **Windows path case sensitivity**: normalize + lowercase before dedup to avoid
  `C:\Foo` and `C:\foo` appearing as two entries. Use `path.normalize()` on both sides.
- **Deleted directories in recents**: show them in the list unchanged — the combobox is
  just a text shortcut; validation (does the dir exist?) is unchanged and already handled
  in the existing confirm-path logic at each call site.
- **Dropdown z-index**: DirPicker renders inside an overlay modal. Position the dropdown
  with a high enough `z-index` to clear any modal backdrop layers.
- **Prop removal**: `autoBrowse` is an internal prop not exposed via any external API,
  so removal is safe to do all at once without deprecation.

## Verification Steps

1. Open any DirPicker form (e.g. "Shell in…" from PaneGrid empty state). Confirm the
   system file dialog does **not** pop automatically.
2. Click the "Browse…" button. Confirm the system dialog opens normally.
3. Type a partial path in the input. Confirm the dropdown filters to matching recents.
4. Click a recent in the dropdown. Confirm it fills the input.
5. Confirm a directory. Re-open the picker. Confirm the confirmed directory now appears
   at the top of the recents list.
6. Confirm the same directory again. Confirm it appears only once in recents (no
   duplicates).
7. Confirm 21 different directories. Confirm the list stays at 20 (oldest trimmed).
8. Test repair dialogs (SessionBrowser, SessionRow, Terminal) — recents appear and
   confirming a repair directory adds it to recents.
9. Restart the app. Confirm recents survive the restart.
