# 041 — handlers.ts Restructure and Main-Process Hot-Path Fixes

Covers backlog items **28** (ack consolidation + file split), **30** (pty sender-ownership guard), **33** (re-entrant IPC registration / real cleanup), **13** (async VS Code probe), **23** (dead `Buffer.byteLength` on the output hot path), and optional **47** (OSC chunk-boundary tail buffer) from `specs/pending/032-code-improvement-backlog.md`.

This spec touches the most invariant-dense zone in the repo: the cross-window transfer protocol (CLAUDE.md "Multi-Window State Invariants") and the direct PTY output relay (CLAUDE.md "PTY Isolation", no-flow-control note). Everything here is **behavior-preserving**. Ack semantics must remain byte-identical. All line numbers below were verified against the tree at the time of writing; re-verify before editing, they drift.

## Problem

`src/main/ipc/handlers.ts` is ~1180 lines mixing five unrelated concerns: PTY output routing, session indexing, cross-window transfer protocol, layout persistence, and app/window chrome. Inside it:

- Four handlers hand-roll the ack-with-timeout protocol immediately next to the shared `waitForAck` helper that two other handlers already use. One of them leaks a live 1s timer per call.
- The hottest code path in the app (per-chunk PTY output relay) does a full UTF-8 byte scan per chunk to compute an argument the renderer ignores.
- A synchronous, `shell: true`, 3s-timeout VS Code probe runs at module load, before the first window exists.
- `pty:write`/`pty:resize`/`pty:kill` skip the sender-ownership check that `pty:get-ready` enforces, so a stale source renderer can write to, resize, or kill a pty that was already rerouted to another window mid-transfer. Worse, the `pty:kill` handler unroutes **before** checking anything, so a stale kill silently unroutes the pty from its *new* owner even if the kill itself no-ops.
- `registerIpcHandlers` can only ever run once per process (duplicate `ipcMain.handle` throws), and the returned `cleanup()` removes zero IPC handlers — a latent crash on macOS `activate` → `createWindow()`.

## Current Behavior (evidence per item)

All references are `src/main/ipc/handlers.ts` unless noted.

### Item 13 — synchronous VS Code probe at module load

Lines 24–30:

```ts
let vsCodeAvailable = false
try {
  execFileSync('code', ['--version'], { stdio: 'ignore', shell: true, timeout: 3000 })
  vsCodeAvailable = true
} catch { ... }
```

This runs when `./ipc/handlers` is **imported** by `src/main/index.ts:6` — i.e. before `app.whenReady()`, blocking main-process startup for up to 3 seconds (spawns `cmd.exe` due to `shell: true`; on a machine without `code` on PATH it eats the full timeout). The only consumer is the `shell:vscode-available` handler at line 362, which is an async `invoke` from the renderer anyway.

### Item 23 — `Buffer.byteLength` per output chunk

Three call sites compute `Buffer.byteLength(data, 'utf8')` (a full UTF-8 scan of every chunk) as the 4th arg of `pty:data`:

- line 75 in `sendDirectPtyOutput`
- line 89 in `scheduleDirectFlush`'s timer body
- line 115 in `flushDirectOutput`

Per CLAUDE.md, the `pty:data` channel carries `seq`/`byteLength` args "for shape compatibility, but the renderer ignores them" (verified: `src/renderer` never reads the 3rd/4th args). This is dead work on the single hottest path in the app. **This item is dead-work removal, NOT flow control** — the no-flow-control invariant is untouched.

### Item 30 — missing sender-ownership guard on `pty:write`/`pty:resize`/`pty:kill`

`pty:get-ready` (lines 328–334) gates on ownership:

```ts
ipcMain.handle('pty:get-ready', (e, ptyId: string) => {
  if (!windowManager.ownsPty(ptyId, e.sender.id)) return null
  ...
```

But `pty:write` (336–339), `pty:resize` (341–343), and `pty:kill` (345–350) accept any `ptyId` from any window. `pty:kill` is the worst:

```ts
ipcMain.handle('pty:kill', (_e, ptyId: string) => {
  windowManager.unroutePty(ptyId)      // ← unroutes BEFORE any check
  lastPtyCwd.delete(ptyId)
  cleanupDirectOutput(ptyId)
  return ptyManager.kill(ptyId)
})
```

During a cross-window transfer, main reroutes the pty to the destination (`transferPty`) and only then tells the source to remove its pane copy (`pane:remove-remote` / `renderer:remove-pane`). The source-side removal listeners (`src/renderer/src/store/panes.ts:2206`, `:2237`) call `removePaneKeepTab`/`removePaneById` and do **not** kill — by design, since the pty lives on in the destination. But nothing *prevents* a stale or buggy source path from invoking `pty:kill`/`pty:write` on a pty it no longer owns; if it does, the current handler unroutes the pty from its new owner (killing output routing) and kills a live process in another window. The only legitimate kill path today is `closePaneInTab` (`panes.ts:1071`), invoked by the pane's owning window.

`windowManager.ownsPty` exists (`src/main/window/WindowManager.ts:215–217`); it compares against the routed `webContents.id`. Note that a pty can also be legitimately **unrouted**: `ptyManager.on('exit')` (handlers.ts:224) unroutes on process exit, and `WindowManager.unregister` (WindowManager.ts:77–82) drops routes when a window closes. Closing a pane whose process already exited still invokes `pty:kill` — that call arrives with no route entry and must not be rejected.

**Resize ordering hazard (must be handled, see plan):** during a cross-window transfer, the destination renderer applies the pane (`addPaneToTab`/`insertPaneAtSplit`/`replacePaneById`), which mounts a `Terminal` that attaches to the existing `ptyId` and fits — sending `pty:resize` — around the same double-`requestAnimationFrame` window as the `*-applied` ack (`panes.ts:2196–2202`, `:2256–2262`, `:2274–2280`). Main performs `transferPty` only after receiving the ack. A destination resize sent *before* its ack therefore arrives at main while the pty is still routed to the **source**, and a strict ownership guard would drop it, leaving the transferred pane mis-sized until the next user resize. This ordering is why the guard cannot be added naively.

### Item 33 — `registerIpcHandlers` cannot run twice; `cleanup()` removes nothing

`src/main/index.ts:196–199`:

```ts
app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
```

`createWindow()` (index.ts:131) calls `await registerIpcHandlers(mainWindow)` unconditionally. On macOS, `window-all-closed` does not quit (index.ts:203–207), so dock-click `activate` re-runs `createWindow` → the second `ipcMain.handle('sessions:search', ...)` throws (`Attempted to register a second handler for 'sessions:search'`). It would also construct a second `SessionIndex` (second SQLite open on the same DB), a second `PtyManager` (second worker process), a second `GitBranchWatcher`, and a second 5s poll interval. Latent on Windows (where all-closed quits), fatal on macOS.

`cleanup()` (handlers.ts:1075–1088) clears the poll interval and direct-output timers and disposes services, but calls neither `ipcMain.removeHandler` nor `ipcMain.removeAllListeners` for any of the ~60 channels registered.

### Item 28 — four hand-rolled ack protocols beside `waitForAck`; 1180-line file

The shared helper (lines 806–823):

```ts
function waitForAck(win: BrowserWindow, channel: string, id: string, trigger: () => void, ms = 1000): Promise<boolean>
```

Semantics: registers `ipcMain.on(channel, onAck)`, calls `trigger()`, resolves `true` on an ack whose first arg equals `id` **and** whose sender window id equals `win.id` (acks from other windows or with other ids are ignored, listener stays armed), resolves `false` on the `ms` timeout; in both settle paths it clears the timer and removes the listener. Used correctly by `pane:split-transfer` (826–852) and `pane:swap-transfer` (855–891).

Four handlers hand-roll the same pattern with variations:

1. **`window:focus-pane`** (624–657) — sends `pane:focus-remote`, listens on `pane:focus-remote-applied`. Two deviations from `waitForAck`: (a) the handler returns `true` synchronously without awaiting; (b) `setTimeout(focusTarget, 1000)` at line 655 is **never cleared**, so every call leaks a live 1s timer even after the ack fires (harmless today only because `focusTarget` is `settled`-guarded — the timer still holds the closure alive for 1s). Semantics to preserve exactly: the OS-level focus (`restore()` + `focus()`) fires **once**, either on ack or on the 1s fallback (yes, it focuses on timeout too), and re-validates `getWindowIdForTab(tabId) === winId` and `getOwnershipGeneration(tabId) === expectedGeneration` at focus time.
2. **`tab:spawn-in-project`** (659–707) — sends `tab:spawn-in-project-remote`, listens on `tab:spawn-in-project-applied`. Deviations: the ack carries a second payload arg (`ok` — `finish(ok !== false)`), and the timeout is **3000ms**, not 1000ms. On success it re-checks tab ownership + generation, then restores/focuses the window; resolves the ack's `ok`.
3. **`pane:transfer`** (755–803) — sends `pane:received`, listens on `pane:received-applied`, 1000ms. Identical shape to `waitForAck`. On failure sends `pane:transfer-rolledback` to the (optimistically applied) destination. On success: `transferPty` + `flushDirectOutput` **before** sending `pane:remove-remote` to the source.
4. **`tab:absorb`** (922–981) — sends `tab:release` (with `releaseId` → two-phase mode in the renderer: ack-only, removal deferred), listens on `tab:release-applied`, 1000ms. Identical shape to `waitForAck`. On success: `unrecordTab` → `recordDetachedTab` (if destination detached) → `transferPty` + `flushDirectOutput` per pty → `tab:absorb-committed` to the source.

Actual section boundaries of `handlers.ts` (for the split):

| Lines | Content |
|---|---|
| 1–30 | imports; sync VS Code probe (item 13) |
| 32–42 | module-scope seq counters (`remoteFocusRequestSeq`, `remoteSpawnRequestSeq`, `focusTargetVersionSeq`, `tabReleaseSeq`); `PTY_ROUTE_RETRY_MS` |
| 44–63 | `registerIpcHandlers` open; service construction (`SessionIndex`, scanners, `DeepSearcher`, `PtyManager`, `SessionSpawner`, `GitBranchWatcher`, `lastPtyCwd`, `pendingDirectOutput`, `directRetryTimers`) |
| 65–122 | direct-output relay: `sendDirectPtyOutput`, `scheduleDirectFlush`, `cleanupDirectOutput`, `flushDirectOutput` |
| 124–187 | `scanAllSessions`, `registerWindowHandlers`, initial scan, `pollSessions` + 5s interval |
| 189–232 | `ptyManager` event wiring: `data` (incl. OSC 633;D re-probe and OSC 7 / OSC 633;P;Cwd scan at 196–206 — item 47), `ready`, `exit`, `error` |
| 236–525 | sessions/pty/shell/git/dirs/dialog/layout-load-save/validate/recover/mcp/agent-provider/gpu handlers (`pty:get-ready` 328, write/resize/kill 336–350, `layoutPath` 384, `layout:load` 386, `layout:save` 394) |
| 527–586 | window chrome: `window:get-id` … `window:snap-apply` |
| 588–981 | cross-window protocol: `tab:tear-off`, `window:focus-for-tab`, `pane:focus-changed`, `focus:target-report`, `window:focus-pane`, `tab:spawn-in-project`, `tab:adopt`, `tab:detached-ready`, `tab:state-sync`, `pane:transfer`, `waitForAck` (806–823), `pane:split-transfer`, `pane:swap-transfer`, `tab:bring-home`, `tab:reattach-home`, `tab:absorb` |
| 986–1072 | `requestWindowResponse`, `performShutdownSave` |
| 1074–1091 | returned `{ cleanup, registerWindowHandlers, performShutdownSave }` |
| 1094–1180 | module-scope pure helpers: `normalizePath`, `normalizeTabsForLayout`, `repairLayoutCwds`, `rewriteLayoutCwds`, `rewriteNodeCwds`, `rewritePathProperty`, `writeJsonAtomic`, `timestampForFilename` |

### Item 47 (optional) — OSC CWD sequences split across chunk boundaries

Lines 196–206 scan each chunk independently with `data.includes('\x1b]633;D')`, `data.includes('\x1b]7;')`, `data.includes('\x1b]633;P;Cwd=')`. A marker straddling two `node-pty` chunks is missed; the failure self-heals at the next prompt, so this is low priority. Any fix must not touch the direct output relay — `sendDirectPtyOutput(ptyId, data)` at line 192 must keep receiving the raw, unmodified chunk.

## Intended Behavior

- Main-process startup is not blocked by the VS Code probe; `shell:vscode-available` resolves the same boolean it does today (just possibly a bit later on first call).
- `pty:data` keeps its 4-arg shape but the 4th arg costs O(1); no UTF-8 scans on the relay path.
- A renderer that does not own a pty's route cannot write to it, resize it, kill it, or (critically) unroute it. A renderer killing an *unrouted* pty (post-exit pane close) still succeeds. All legitimate transfer/kill orderings keep working, including the destination's first fit-resize after a transfer.
- `registerIpcHandlers` is safe against double registration: either it can run twice (idempotent per-app registration) or `cleanup()` fully deregisters every channel it registered; `activate` never throws.
- The four hand-rolled ack blocks use `waitForAck` / `waitForAckWithResult`; no leaked timers; ack matching, sender-window validation, timeout values, focus/rollback/commit side effects, and message ordering all byte-identical.
- `handlers.ts` shrinks to session/pty/shell/settings concerns plus composition; the direct-output relay, the transfer protocol, and layout persistence live in three focused modules with the pure parts unit-testable without Electron mocks.
- (Optional) OSC CWD markers split across chunk boundaries are detected via a small per-pty tail buffer used **only** for the marker scan.

## Implementation Plan

Strictly ordered phases. Each phase is independently shippable and ends with `npm test` + `npm run typecheck` green. Do the phases as separate commits (or PRs) in this order — the quick wins first so the refactor phases rebase over minimal churn.

### Phase 1 — quick wins: items 13 and 23

**13.** Delete the module-load `execFileSync` block (24–30). Inside `registerIpcHandlers` (so importing the module stays side-effect-free for tests), kick off:

```ts
const vsCodeAvailable: Promise<boolean> = promisify(execFile)(
  'code', ['--version'], { shell: true, timeout: 3000 }
).then(() => true, () => false)
```

and change the handler to `ipcMain.handle('shell:vscode-available', () => vsCodeAvailable)`. `invoke` already returns a promise to the renderer, so awaiting the cached probe is shape-compatible. Do not re-probe per call — one probe per app run, same as today.

**23.** At the three sites (75, 89, 115), replace `Buffer.byteLength(data/joined, 'utf8')` with `data.length` / `joined.length` (UTF-16 code-unit length; the renderer ignores the arg, so the value's meaning is irrelevant — only the 4-arg channel shape matters). Add a one-line comment at each site: `// 4th arg kept for pty:data shape compat; renderer ignores it — do not reintroduce per-chunk byte scans or flow control`.

### Phase 2 — item 30: sender-ownership guard on write/resize/kill

1. Add to `WindowManager`: `getPtyOwner(ptyId: string): number | undefined` returning `this.ptyToWebContentsId.get(ptyId)`. The guard predicate is **route-aware, deny-only-when-routed-elsewhere**:

```ts
function senderMayControlPty(ptyId: string, senderWcId: number): boolean {
  const owner = windowManager.getPtyOwner(ptyId)
  return owner === undefined || owner === senderWcId
}
```

   Rationale: an *unrouted* pty (process exited and main unrouted it; or the owning window was unregistered) has no conflicting owner, and rejecting those kills would orphan teardown paths. Only a pty currently routed to a **different** webContents is protected.

2. `pty:write`: guard before both `spawner.notePtyWrite` and `ptyManager.write`; silently drop on failure (it's a `send` channel, no return value).
3. `pty:resize`: same guard, silently drop.
4. `pty:kill`: **check ownership first, before unrouting**. On failure return `false` without touching the route, `lastPtyCwd`, or the direct-output buffers — the current unroute-first order is exactly what lets a stale kill damage the new owner. On success, keep today's order: unroute → `lastPtyCwd.delete` → `cleanupDirectOutput` → `ptyManager.kill`.
5. **Companion change for the resize ordering hazard** (see Current Behavior): in the three destination transfer-apply listeners in `src/renderer/src/store/panes.ts` (`pane:received` :2189, `renderer:insert-at-split` :2242, `renderer:replace-pane` :2265), after sending the `*-applied` ack, schedule one more size re-assertion for the transferred pane's terminal (e.g. a third `requestAnimationFrame` that triggers the pane's fit → `pty:resize`). The ack → `transferPty` hop happens in main within the same task as ack receipt, so a post-ack resize lands after reroute and the possibly-dropped pre-ack resize becomes harmless. If implementing the re-assert cleanly through the xterm fit path proves invasive, the sanctioned fallback is: apply the guard to `pty:write` and `pty:kill` only in this phase and leave `pty:resize` unguarded with a comment referencing this spec — do **not** ship a guarded resize without the re-assert.

Legitimate orderings that must keep working (encode as tests, see Tests):

- Owner window closes a pane → `pty:kill` from owner → allowed.
- Pane's process exits (main unrouted on `exit`) → user closes the pane → `pty:kill` with no route → allowed (no-op kill).
- Cross-window transfer commits → destination closes the pane → kill from destination (new owner) → allowed.
- Cross-window transfer commits → anything from the stale source (`write`/`resize`/`kill`) → denied, and — key assertion — the route to the destination is untouched.

### Phase 3 — item 33: re-entrant registration and real cleanup

1. Inside `registerIpcHandlers`, introduce a tiny registrar wrapper and use it for **every** registration in the function (and, after Phase 5, in the extracted modules):

```ts
// src/main/ipc/ipcRegistrar.ts
export interface IpcLike {
  handle(channel: string, fn: (...a: any[]) => any): void
  on(channel: string, fn: (...a: any[]) => void): void
  removeHandler(channel: string): void
  removeAllListeners(channel: string): void
}
export function createIpcRegistrar(ipc: IpcLike) {
  const handled = new Set<string>(); const listened = new Set<string>()
  return {
    handle(ch, fn) { ipc.handle(ch, fn); handled.add(ch) },
    on(ch, fn) { ipc.on(ch, fn); listened.add(ch) },
    disposeAll() {
      for (const ch of handled) ipc.removeHandler(ch)
      for (const ch of listened) ipc.removeAllListeners(ch)
      handled.clear(); listened.clear()
    },
  }
}
```

   Caution: `ipcRegistrar.on` is for **handler-block** listeners (`pty:write`, `pty:resize`, `tab:state-sync`, `pane:focus-changed`, `focus:target-report`, `tab:detached-ready`). The transient ack listeners created by `waitForAck`/`requestWindowResponse` must keep using raw `ipcMain.on`/`removeListener` — they self-remove, and `removeAllListeners` on an ack channel mid-flight would break an in-progress transfer. `disposeAll` on the six long-lived `on` channels is safe only at shutdown.

2. `cleanup()` calls `registrar.disposeAll()` in addition to its current work. Keep the existing `cleanupPromise` memoization.
3. In `src/main/index.ts`, split window creation from app-scoped IPC setup:
   - Extract the `BrowserWindow` construction + close/shutdown-save wiring into `createPrimaryWindow(): BrowserWindow`.
   - Keep a module flag `ipcInitialized`. First `createWindow()` runs `registerIpcHandlers` as today and sets it.
   - Guard `activate`: if `ipcInitialized`, create only a new primary window and re-bind it (`windowManager.register`, `registerWindowHandlers(win)`, `initUpdater`) — do **not** call `registerIpcHandlers` again.
   - The captured `mainWindow` inside `registerIpcHandlers` is used only as a sender-fallback (`?? mainWindow`) and for `SessionSpawner`. Replace those captures with a `getPrimaryWindow()` lookup via `windowManager.getPrimaryWindow()` (already exists, WindowManager.ts:196) with the original fallback semantics, so a replacement primary window works. If `SessionSpawner`'s window use is deeper than a fallback, add a `spawner.setPrimaryWindow(win)` re-bind called from the activate path instead of restructuring the spawner.
   - Windows/Linux behavior is unchanged (`window-all-closed` quits before `activate` can matter).

### Phase 4 — item 28a: consolidate the four hand-rolled acks onto `waitForAck` / `waitForAckWithResult`

Do this **before** the file split so the split moves already-clean code.

1. Extract the ack protocol into `src/main/ipc/ackProtocol.ts` with injected dependencies (per the CLAUDE.md preference for extraction over `vi.mock` of Electron-importing modules):

```ts
export interface AckIpc {
  on(channel: string, listener: (...a: any[]) => void): void
  removeListener(channel: string, listener: (...a: any[]) => void): void
}
export interface AckDeps {
  ipc: AckIpc
  senderWindowId(event: unknown): number | null  // prod: BrowserWindow.fromWebContents(e.sender)?.id
}
export function createAckProtocol(deps: AckDeps): {
  waitForAck(winId: number, channel: string, id: string, trigger: () => void, ms?: number): Promise<boolean>
  waitForAckWithResult(winId: number, channel: string, id: string, trigger: () => void, ms?: number): Promise<{ acked: boolean; ok: boolean }>
}
```

   `waitForAck` keeps today's exact semantics (default `ms = 1000`; ignore mismatched ids; ignore acks from other windows without settling; clear timer + remove listener on both settle paths). `waitForAckWithResult` is identical except the ack's second arg is captured: on ack resolve `{ acked: true, ok: secondArg !== false }`; on timeout `{ acked: false, ok: false }`.

2. Rewrite the four handlers on the helpers, preserving semantics exactly:
   - **`window:focus-pane`**: keep the synchronous `return true`. Replace the listener + leaked `setTimeout` with `void waitForAck(win.id, 'pane:focus-remote-applied', requestId, () => win.webContents.send('pane:focus-remote', tabId, paneId, requestId)).then(() => focusTarget())` — note `focusTarget()` runs on **both** outcomes (ack and 1s timeout), exactly like today, and keeps its internal re-validation of window id / ownership generation / destroyed / minimized. The timer leak disappears because `waitForAck` clears its timer on ack. `focusTarget` no longer needs the `settled` flag or `removeListener` (the helper owns those), but keep it single-shot anyway since `.then` fires once.
   - **`tab:spawn-in-project`**: `const { ok } = await waitForAckWithResult(win.id, 'tab:spawn-in-project-applied', requestId, () => win.webContents.send('tab:spawn-in-project-remote', tabId, payload, requestId), 3000)` — **3000ms, not the default**. Keep the success-path ownership + generation re-check and restore/focus, and return `ok`.
   - **`pane:transfer`**: swap the inline promise for `waitForAck(toWin.id, 'pane:received-applied', transferId, () => toWin.webContents.send('pane:received', JSON.stringify(payload.pane), payload.targetTabId, transferId))`. Keep everything around it verbatim: the same-window `pane:move-remote` short-circuit, the failure-path `pane:transfer-rolledback`, and the success ordering `transferPty` → `flushDirectOutput` → `pane:remove-remote`.
   - **`tab:absorb`**: swap the inline promise for `waitForAck(sourceWin.id, 'tab:release-applied', releaseId, () => sourceWin.webContents.send('tab:release', tab.id, ownerArg, releaseId))`. Keep verbatim: falsy return on `!released || toWin.isDestroyed()`, then `unrecordTab` → conditional `recordDetachedTab` → per-pty `transferPty`+`flushDirectOutput` → `tab:absorb-committed` with the same conditional owner arg.
3. Keep the request-id formats (`` `${Date.now()}:${++seq}` ``, `` `split:...` `` etc.) unchanged — they are matched only by equality, but changing them churns logs and diffs for no benefit.
4. Leave `requestWindowResponse` (986–1014) as-is in this phase; it is a different shape (returns data, shutdown-scoped). It moves in Phase 5 and may optionally be rebased onto `ackProtocol` later — not required.

### Phase 5 — item 28b: split the file

Three new modules under `src/main/ipc/`, plus the Phase 3/4 extractions (`ipcRegistrar.ts`, `ackProtocol.ts`). `handlers.ts` remains the composition root and keeps its exported signature `registerIpcHandlers(mainWindow) → { cleanup, registerWindowHandlers, performShutdownSave }` so `src/main/index.ts` is untouched by this phase.

**`src/main/ipc/ptyOutputRouter.ts`** — the direct-output relay + `ptyManager` event wiring (current lines 37–42, 55–58 state, 65–122, 189–232):

```ts
export interface PtyOutputRouterDeps {
  ptyManager: PtyManager
  windowManager: { sendToWindowForPty(ptyId: string, channel: string, ...args: unknown[]): boolean; unroutePty(ptyId: string): void }
  onCwdChanged?(ptyId: string, cwd: string): void        // handlers.ts hook (none needed today; pty:cwd is sent internally)
  onCommandComplete?(cwd: string): void                  // wired to gitBranchWatcher.retryUnresolvedCwd
}
export interface PtyOutputRouter {
  flushDirectOutput(ptyId: string): void   // called by handlers on route/create/transfer
  releasePty(ptyId: string): void          // clears tail/lastCwd/buffers/timers (pty:kill success path)
  getLastCwd(ptyId: string): string | undefined
  dispose(): void                          // clears all retry timers + buffers (cleanup path)
}
export function createPtyOutputRouter(deps: PtyOutputRouterDeps): PtyOutputRouter
```

Moves: `PTY_ROUTE_RETRY_MS`, `pendingDirectOutput`, `directRetryTimers`, `lastPtyCwd`, `sendDirectPtyOutput`, `scheduleDirectFlush`, `cleanupDirectOutput`, `flushDirectOutput`, and the four `ptyManager.on(...)` wirings (`data` including the OSC scans, `ready`, `exit` including the nonzero-exit banner + unroute + cleanup, `error`). The `data` handler's git re-probe becomes `onCommandComplete?.(cwd)`. `handlers.ts` call-site changes: `pty:kill` success path calls `router.releasePty(ptyId)`; every current `flushDirectOutput(...)` call (session:new/resume, pty:create, tab:adopt, pane:transfer, split/swap, tab:absorb) calls `router.flushDirectOutput(...)`; `cleanup()` calls `router.dispose()`. Preserve the CLAUDE.md relay invariants: seq stays literally `0`, no coalescing beyond the existing buffered `join('')`, no ack/pause/watermark, buffering **only** while `sendToWindowForPty` returns false. Move the file-top no-flow-control comment block (37–42) with it.

**`src/main/ipc/transferHandlers.ts`** — the cross-window protocol (current lines 32–35 counters and 588–981):

```ts
export function registerTransferHandlers(deps: {
  registrar: IpcRegistrar
  windowManager: WindowManager               // full surface: routing, tab records, generations, detached checks
  ack: ReturnType<typeof createAckProtocol>
  getPrimaryWindow(): BrowserWindow | null   // sender-fallbacks (was captured mainWindow)
  flushDirectOutput(ptyId: string): void     // router.flushDirectOutput
  registerWindowHandlers(win: BrowserWindow): void  // for tab:tear-off's new detached window
}): void
```

Moves exactly these handlers/listeners: `tab:tear-off`, `window:focus-for-tab`, `pane:focus-changed`, `focus:target-report`, `window:focus-pane`, `tab:spawn-in-project`, `tab:adopt`, `tab:detached-ready`, `tab:state-sync`, `pane:transfer`, `pane:split-transfer`, `pane:swap-transfer`, `tab:bring-home`, `tab:reattach-home`, `tab:absorb`; plus the four seq counters (`remoteFocusRequestSeq`, `remoteSpawnRequestSeq`, `focusTargetVersionSeq`, `tabReleaseSeq`) as module state, and the `SpawnInTabPayload` validation. The window-chrome handlers (529–586: `window:get-id` … `window:snap-apply`) **stay in `handlers.ts`** — they are per-window chrome, not transfer protocol; do not creep the scope.

**`src/main/ipc/layoutStore.ts`** — layout persistence + shutdown save (current 384–407, 986–1072, 1099–1180):

```ts
export function createLayoutStore(deps: {
  layoutPath: string                               // path.join(app.getPath('userData'), 'layout.json') — resolved by caller so the module has no `app` import
  windowManager: { getPrimaryWindow(): BrowserWindow | null; isDetachedWindow(id: number): boolean }
}): {
  registerHandlers(registrar: IpcRegistrar): void  // layout:load, layout:save
  repairLayoutCwds(mapping: CwdRepairMapping): { changed: boolean; count: number }
  performShutdownSave(): Promise<void>
}
// also export the pure helpers for tests:
export { normalizeTabsForLayout, rewriteLayoutCwds, writeJsonAtomic, timestampForFilename }
```

Moves: `layout:load`, `layout:save`, `requestWindowResponse`, `performShutdownSave`, `normalizeTabsForLayout`, `repairLayoutCwds`, `rewriteLayoutCwds`, `rewriteNodeCwds`, `rewritePathProperty`, `writeJsonAtomic`, `timestampForFilename`. Cross-module seam: `sessions:repair-cwd` (stays in `handlers.ts`) currently calls `repairLayoutCwds(layoutPath, mapping)` at line 262 — it now calls `layoutStore.repairLayoutCwds(mapping)`. `normalizePath` (1094–1097) stays in `handlers.ts` (session-path concern, not layout). If backlog item 1 (atomic `layout:save`) has not landed by then, do **not** fold it in here — this phase is move-only.

**`handlers.ts` after the split** keeps: service construction, session scanning/polling/index handlers, `session:new`/`session:resume`, `pty:create`/`pty:get-ready`/`pty:write`/`pty:resize`/`pty:kill` (with the Phase 2 guard), shell/git/dirs/dialog handlers, `sessions:validate`/`recover-pending`/`repair-cwd`, mcp + agent-provider + gpu handlers, window chrome (529–586), `registerWindowHandlers`, and composition: create registrar → create router → create ack protocol → create layout store → `registerTransferHandlers(...)` → return `{ cleanup, registerWindowHandlers, performShutdownSave: layoutStore.performShutdownSave }`. Target: well under 700 lines.

### Phase 6 (optional, last) — item 47: OSC tail buffer for the marker scan

In `ptyOutputRouter`'s `data` handler only: keep a `Map<ptyId, string>` of the last ≤64 characters per pty. Scan `tail + data` for the three markers (`\x1b]633;D`, `\x1b]7;`, `\x1b]633;P;Cwd=`) and feed the concatenation to `parseShellIntegrationCwd`/`parseOsc7`; then store `(tail + data).slice(-64)` as the new tail. Non-negotiable: `sendDirectPtyOutput(ptyId, data)` continues to receive the **raw chunk** — the tail buffer exists only for the marker scan and must never delay, mutate, or re-chunk the relay. Clear the tail in `releasePty`/exit. Consider that a 64-char tail can cause the same OSC 7 sequence to be parsed twice across consecutive chunks — the existing `lastPtyCwd.get(ptyId) !== cwd` dedupe already makes that a no-op; keep it. Ship only if cwd-staleness reports justify it; otherwise leave the backlog item open.

## Tests

Follow the buildEnv precedent: extract pure/injectable modules and characterize them, rather than `vi.mock('electron')`. All new files get co-located `*.test.ts` in the `main` Vitest project (node env). Use `vi.useFakeTimers()` for anything timer-driven.

- **`ackProtocol.test.ts`** (Phase 4, the load-bearing suite):
  - resolves `true` on matching ack from the right window; **asserts the timeout timer is cleared** (`vi.getTimerCount() === 0` after settle — this is the regression test for the `window:focus-pane` leak).
  - resolves `false` after `ms` with the listener removed (assert via fake `ipc.removeListener` calls).
  - ignores acks with a mismatched id and acks whose `senderWindowId` differs — listener stays armed and a later correct ack still resolves `true`.
  - default timeout is 1000ms; an explicit `ms` (3000) is honored.
  - `waitForAckWithResult`: `ok` is `true` for second arg `undefined`/`true`, `false` only for literal `false` (matches `finish(ok !== false)`); timeout → `{ acked: false, ok: false }`.
  - `trigger()` is invoked after the listener is registered (an ack fired synchronously from `trigger` must not be missed).
- **`ptyOutputRouter.test.ts`** (Phase 5; write a pre-move characterization version against the extracted functions if extracting first helps): fake `windowManager.sendToWindowForPty` toggled false→true; assert buffering preserves order and flushes as one joined chunk with `seq === 0`; retry timer fires at `PTY_ROUTE_RETRY_MS` and re-arms while unroutable; `releasePty` clears buffers and timers; the 4th `pty:data` arg equals `data.length` (Phase 1 guard); nonzero exit injects the yellow banner, zero exit does not; exit unroutes and cleans up. Phase 6 adds: marker split across two chunks is detected once (`pty:cwd` sent once) and the relay still received two raw chunks.
- **Ownership guard tests** (Phase 2): with a real `WindowManager` instance (it is plain TS, no Electron import beyond types — if the `BrowserWindow` import blocks node-env tests, test through a minimal route-map fake implementing `getPtyOwner`): owner write/resize/kill allowed; non-owner denied; **kill checks ownership before unrouting** — assert via a call-ordering log that a denied kill performs zero `unroutePty` calls and the route still points at the owner; kill of an unrouted pty allowed. Cover the four legitimate orderings listed in Phase 2. For the resize re-assert, add a renderer-project test on the three transfer-apply listeners asserting a `pty:resize` (or fit trigger) is scheduled after the `*-applied` ack.
- **Registrar tests** (Phase 3): registering N handle + M on channels then `disposeAll()` calls `removeHandler`/`removeAllListeners` for exactly those channels; a second full register cycle after dispose does not throw on a strict fake that throws on duplicate `handle` (this simulates the macOS activate double-registration).
- **`layoutStore` tests** (Phase 5): `normalizeTabsForLayout` forces `detached: false` and passes non-arrays through; `rewriteLayoutCwds` counts `defaultCwd`/`cwd`/`sessionDetectionCwd` rewrites across leaf/split trees (complements existing `cwdRepair` tests); `repairLayoutCwds` round-trip in a temp dir writes a `layout.json.bak.*` backup and replaces atomically; unchanged mapping → `{ changed: false }` and no backup.
- **E2E**: `e2e/startup.spec.ts` already covers cold layout restore, `pty:ready` + direct seq=0 output, and **cross-window `tab:absorb`** — it is the black-box guard for this entire spec and must stay green after every phase. Do not weaken or fork it.
- Boy-scout rule: `handlers.ts` itself has no unit test today; the extractions above *are* its tests. Any incidental file touched (e.g. `panes.ts` listeners in Phase 2) gains a test per CLAUDE.md.

## Risks

This is spec-024 territory (a no-op apply that acked once deleted the source pane permanently). The invariants below must not change; treat any diff that touches them as suspect:

1. **Ack timeout values**: 1000ms for `pane:transfer`, `tab:absorb`, `pane:split-transfer`, `pane:swap-transfer`, and the `window:focus-pane` fallback; **3000ms** for `tab:spawn-in-project`. `waitForAck`'s default covers the 1000ms cases; the 3000 must be passed explicitly.
2. **Silent no-op acks**: destination listeners ack only when the store action returned `true` (`panes.ts:2196`, `:2256`, `:2274`). Nothing on the main side may treat a timeout as success, retry an ack, or ack on behalf of a renderer.
3. **Destination-commits-before-reroute**: `transferPty` runs only after the destination's ack, in every handler. Never reroute optimistically.
4. **Source deletes only after commit**: `pane:remove-remote` / `tab:absorb-committed` are sent only on the committed path. `tab:absorb` stays two-phase (renderer acks `tab:release` with a `releaseId` without acting; finalize happens on `tab:absorb-committed`).
5. **Per-handler message ordering is intentionally non-uniform — do not harmonize it**: `pane:transfer` reroutes the pty *before* telling the source to remove (`transferPty` → `flush` → `pane:remove-remote`), while `pane:split-transfer` sends `renderer:remove-pane` *before* `transferPty` (838 vs 840), and `pane:swap-transfer` reroutes both ptys only after **both** windows commit, with one-sided rollback (`${id}:rollback` suffixed ids) on partial commit. Preserve each verbatim.
6. **Rollback messages**: `pane:transfer-rolledback` on transfer timeout; swap's one-sided `renderer:replace-pane` rollback. Both must survive the consolidation.
7. **Ownership generation checks**: `window:focus-pane` and `tab:spawn-in-project` re-validate `getWindowIdForTab` and `getOwnershipGeneration` *at effect time* (after ack/timeout), not just at entry. The consolidation must keep the re-check inside the post-ack continuation.
8. **`window:focus-pane` focuses on timeout too** — the 1s fallback is a feature (renderer may apply without acking in edge cases), not a bug. Only the timer leak is a bug.
9. **No-flow-control invariant** (CLAUDE.md): items 23/47 and the router extraction must not introduce coalescing beyond the existing no-route `join('')`, acks, pause/resume, or watermarks. `seq` stays literally `0`.
10. **Ownership guard regressions** (Phase 2): the two failure modes to fear are (a) blocking the destination's first post-transfer resize (mitigated by the re-assert; verified by the manual matrix) and (b) blocking teardown kills of unrouted ptys, leaking processes (mitigated by deny-only-when-routed-elsewhere; note release 0.3.11 was specifically "reliable process cleanup" — do not regress it).
11. **Phase 3 lifecycle**: `disposeAll` must never run while transfers are in flight in a *surviving* process state — it is shutdown-only today. The transient ack listeners must stay outside the registrar (see Phase 3 caution) or `removeAllListeners` on shared ack channels will detach concurrent waiters.
12. **Module-scope seq counters** moving files resets nothing at runtime (fresh per process) but keep them module-scope, not per-call, so ids stay unique within a process.

## Verification Steps

After **every** phase:

1. `npm run typecheck` — green (also type-checks tests).
2. `npm test` — green, including the new suites for that phase.
3. `npm run test:e2e` — green; `e2e/startup.spec.ts`'s cold restore, seq=0 output, and `tab:absorb` cases are the black-box proof that ack semantics survived.

After Phases 2, 4, and 5 additionally run the **manual cross-window drag matrix** (two windows: primary + one detached, panes with live shells and one live agent):

- Drag a pane to another window's tab (pane:transfer): output continues in destination; scrollback intact; **pane resizes correctly on arrival** (Phase 2's specific risk); closing it in the destination kills the process (Task Manager check).
- Drag a pane onto another window's pane edge (split-transfer) and header-swap two panes across windows (swap-transfer): no lost panes, both terminals still interactive.
- Drag a whole tab into another window's tab bar (tab:absorb): tab moves, PTYs follow, source shows detached/removed correctly; repeat rapidly to probe timeout paths.
- Self-drop and drop-on-vanished-target: pane must never disappear (spec-024 regression).
- Tear off a tab, then bring-home and reattach-home: PTYs re-adopted, no duplicate tabs.
- Close a pane whose process already exited (type `exit` in a shell first): pane closes cleanly (unrouted-kill path).
- Phase 1 sanity: startup feels instant with `code` absent from PATH (temporarily rename it or scrub PATH in a dev run); "Open in VS Code" availability still correct in the UI.
- Phase 3 (macOS only, if available): close all windows, click the dock icon — new window appears, no `second handler` throw, terminals and sessions work. On Windows, at minimum assert cleanup-path logs show handler deregistration on quit.

## Handoff Contract

### Non-negotiables

1. Behavior-preserving throughout: no IPC channel names, arg shapes, timeout values, request-id matching rules, or message orderings change. Ack semantics byte-identical (Risks 1–8).
2. No flow control, ever, on the PTY output path. `seq=0`, direct synchronous relay, buffering only while no window is routable. Items 23/47 are dead-work removal / scan-only.
3. The `pty:kill` ownership check happens **before** any unroute/cleanup side effect; a denied call leaves the route untouched. Unrouted-pty kills remain allowed.
4. Do not ship a guarded `pty:resize` without the destination post-ack size re-assertion (or take the sanctioned fallback of leaving resize unguarded, documented in-code).
5. Transient ack listeners (`waitForAck`, `requestWindowResponse`) never go through the registrar's `removeAllListeners` surface.
6. Phases land in order (1 → 2 → 3 → 4 → 5 → optional 6), each independently green on typecheck, unit, and e2e. Phase 5 is move-only — no opportunistic fixes folded in (atomic layout writes are backlog item 1, not this spec).
7. No user/project agent config files touched; no changes to renderer transfer listeners beyond the Phase 2 re-assert.
8. Follow the repo testing doctrine: extraction + dependency injection over `vi.mock` of Electron-importing modules; fake timers for all timeout logic; no mocked Zustand store.

### Definition of Done

- Items 13, 23, 30, 33, 28 implemented as specified; item 47 either implemented per Phase 6 or explicitly left open with the backlog entry intact.
- `handlers.ts` is a composition root under ~700 lines; `ptyOutputRouter.ts`, `transferHandlers.ts`, `layoutStore.ts`, `ackProtocol.ts`, `ipcRegistrar.ts` exist with the interfaces above and co-located tests.
- New test suites pass and include, at minimum: the `waitForAck` timer-cleanup assertion, `waitForAckWithResult` `ok !== false` semantics, ownership-guard ordering (deny → zero unroute calls), double-registration-safe registrar, and router buffering/flush/byteLength characterization.
- `npm test`, `npm run typecheck`, `npm run test:e2e` green; the manual drag matrix executed and clean after the final phase.
- CLAUDE.md updated if any durable operational lesson emerged (e.g. the new module boundaries and the "transient ack listeners bypass the registrar" rule); this spec moved to `specs/done/` (keeping the number) or folded into CLAUDE.md if the residual lesson is short. Items 13/23/28/30/33 checked off or removed in `specs/pending/032-code-improvement-backlog.md`.

## Out of Scope

- Backlog item 1 (atomic `layout:save`/shutdown-save writes) — separate change even though `layoutStore.ts` is where it will land.
- Backlog items 20/27 (typed `window.ipc` bridge and `IPCChannels` completion) — the split will make them easier but must not block on them.
- Any flow control, coalescing, or backpressure on `pty:data` (explicitly forbidden).
- Renderer-side refactors (`panes.ts` split is item 29) beyond the three-line post-ack resize re-assertion.
- Rebasing `requestWindowResponse` onto `ackProtocol`, respawning the pty worker (item 14), window-chrome handler relocation, and any change to detached-window creation or snap logic.
- macOS-specific window-state restoration polish beyond making `activate` not throw.
