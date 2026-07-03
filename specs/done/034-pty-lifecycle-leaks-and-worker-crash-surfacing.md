# 034 — PTY Lifecycle Leaks and Worker Crash Surfacing

Four related PTY-lifecycle defects: bulk tab-close actions leak live PTY processes, a cancelled shell-PTY creation leaks the spawned PowerShell process (and blocks retry after an error), an unexpected ptyWorker crash leaves every pane silently dead, and two dead `PtyManager` methods encode semantics that violate the documented agent-pane invariants. This spec is self-contained; no other spec is required reading. CLAUDE.md's "PTY Isolation" section and agent-pane rules are the governing invariants.

## Problem

The renderer and main process have exactly one well-behaved teardown path for a pane's PTY (`closePaneInTab`), but three other close paths skip it entirely, and the main-process PTY host has no failure surfacing when its worker process dies. Concretely:

1. Closing a tab (or "close others" / "close to the right") disposes the xterms but never kills the underlying PTY processes. Orphaned PowerShell/Claude/Codex processes keep running until app exit, and closed agent sessions never move to the sidebar's Recent list because `sessions:refresh` is never requested. There is no main-side orphan GC to catch this.
2. If the Terminal component unmounts while `pty:create` is in flight, the resolved `ptyId` is dropped on the floor — a live PowerShell process that no pane will ever own or kill. Separately, if `pty:create` rejects, a guard ref is never reset, so the pane can never retry creation.
3. If the ptyWorker child process crashes unexpectedly, `PtyManager` only logs to console. All writes are then silently dropped (`_send` no-ops on a disconnected worker), so every pane in the app looks alive but is dead, with no banner and no recovery affordance.
4. `PtyManager.createClaude`/`createAgent` are dead code whose behavior (interactive shell launch, no deferred spawn, default 80x24) contradicts the documented agent launch invariants — a trap for any future caller.

## Current Behavior

All line numbers verified against the working tree at the time of writing.

### A. Tab-close actions leak live PTYs — `src/renderer/src/store/panes.ts`

`closePaneInTab` (`panes.ts:1066-1102`) is the correct model. It kills the PTY, requests a session rescan for agent panes, and disposes the xterm:

```ts
closePaneInTab: (tabId, paneId) => {
  const tab = get().tabs.find((t) => t.id === tabId)
  const pane = tab?.rootNode ? findLeaf(tab.rootNode, paneId) : null
  if (!pane) return
  if (pane.ptyId && typeof window !== 'undefined' && window.ipc) {
    window.ipc.invoke('pty:kill', pane.ptyId)
      .catch(() => {})
      .finally(() => {
        if (pane.paneType === 'agent' && pane.sessionId) {
          window.ipc.invoke('sessions:refresh').catch(() => {})
        }
      })
  } else if (pane.paneType === 'agent' && pane.sessionId && typeof window !== 'undefined' && window.ipc) {
    window.ipc.invoke('sessions:refresh').catch(() => {})
  }
  xtermRegistry.dispose(paneId)
  ...
```

The three tab-level close actions do only the xterm disposal:

- `closeTab` (`panes.ts:807-825`):

  ```ts
  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    const previousHydrated = get().hydratedTabIds
    if (tab?.rootNode) {
      collectLeafIds(tab.rootNode).forEach((id) => xtermRegistry.dispose(id))
    }
    set((s) => { /* remove tab from state */ })
    ...
  ```

- `closeOtherTabs` (`panes.ts:892-913`) — same pattern, iterating every other tab's leaves through `xtermRegistry.dispose` only.
- `closeTabsToRight` (`panes.ts:915-945`) — same pattern for tabs after the given index.

None of the three invokes `pty:kill` or `sessions:refresh`. `pty:kill` on the main side (`src/main/ipc/handlers.ts:345-350`) is where unrouting, cwd-cache cleanup, direct-output cleanup, and the worker `kill` message happen — skipping it means the shell/agent process stays alive and routed state leaks. `sessions:refresh` (`handlers.ts:281-284`) is what moves a closed agent session from the live pane list to Recent without waiting for the 5s poll (CLAUDE.md, "Session Indexing").

### B. Cancelled/failed shell PTY creation — `src/renderer/src/components/Terminal/index.tsx:397-425`

Effect 2 creates the shell PTY:

```ts
let cancelled = false
shellCreatePaneRef.current = pane.id
setStatus('connecting')
...
window.ipc.invoke('pty:create', pane.cwd, initialSize.cols, initialSize.rows).then((result) => {
  if (cancelled) return                      // <-- ptyId dropped; process leaks
  const ptyId = (result as { ptyId?: unknown } | null)?.ptyId
  if (typeof ptyId !== 'string') throw new Error('pty:create did not return a ptyId')
  ptyIdRef.current = ptyId
  setPtyId(pane.id, ptyId)
}).catch((err) => {
  if (cancelled) return
  setStatus('error')                         // <-- shellCreatePaneRef never reset
  setErrorMsg(err instanceof Error ? err.message : 'Failed to create terminal')
})
return () => { cancelled = true }
```

Two defects:

1. **Leak on cancel.** `pty:create` (`handlers.ts:316-326`) returns after `ptyManager.createShell` has already registered the spawn and routed it — the PowerShell process is (or is about to be) live. The `if (cancelled) return` at `index.tsx:412` discards the `ptyId` without killing it. Because the effect unmounted, no pane state ever records the id, so `closePaneInTab`/`markPtyExited` can never reach it. The process survives until app exit.
2. **Retry blocked on error.** The effect's re-entry guard is `if (shellCreatePaneRef.current === pane.id) return` (`index.tsx:399`), and `shellCreatePaneRef.current = pane.id` is set at `:402`. The `.catch` branch sets error status but never resets the ref, so any later run of the effect for this pane immediately bails at `:399`. A transient failure (e.g. cwd briefly unavailable) permanently bricks the pane's shell creation until remount.

### C. ptyWorker crash is log-only — `src/main/pty/PtyManager.ts:138-150`

```ts
this.worker.on('error', (err) => {
  console.error('[PtyManager] worker error:', err)
})

this.worker.on('exit', (code) => {
  if (!this.destroying) console.error('[PtyManager] worker exited with code', code)
})
```

(Spec 032 cited `:142-148`; the handlers now sit at `:138-144`, with `_send` at `:147-150`.)

When the worker dies unexpectedly, every id in `spawnedIds` (live PTYs) and `pendingSpawns` (deferred agent spawns awaiting first resize, see `createDeferred` at `:152-213`) is dead, but no `exit`/`error` event is emitted for any of them. Downstream consequences:

- The renderer never gets `pty:exit`, so `markPtyExited` (`panes.ts:1178-1201`) never runs — no `agentDisconnected` banner, no `sessions:refresh`.
- `handlers.ts:219-227` (`ptyManager.on('exit')` → exit banner + `pty:exit` + `unroutePty` + `cleanupDirectOutput`) never fires, so routing maps and `lastPtyCwd` entries leak.
- `_send` (`PtyManager.ts:147-150`) checks `this.worker.connected` and silently drops every subsequent write/resize/kill — the user types into panes that swallow input with no feedback.
- Pending deferred spawns leak their fallback `setTimeout` (`:194-199`), which later calls `_spawn` → `_send` → silent no-op, adding a phantom entry to `spawnedIds`.
- New `createShell`/`createDeferred` calls after the crash "succeed" (return an id) but never spawn or error — new panes hang forever at "connecting".

### D. Dead `createClaude`/`createAgent` — `src/main/pty/PtyManager.ts:241-248`

```ts
createClaude(cwd: string): string {
  return this.createDeferred(cwd, this._shellCmd())
}

createAgent(cwd: string, agentKind: AgentKind): string {
  if (agentKind === 'claude') return this.createClaude(cwd)
  return this.createDeferred(cwd, this._shellCmd())
}
```

A repo-wide search confirms the only references to these methods are each other; no production or test code calls them. Their semantics violate the documented agent invariants in CLAUDE.md:

- They launch `_shellCmd()` — an interactive PowerShell with the shell-integration profile — instead of the agent command. CLAUDE.md: "Agent panes must not start an interactive shell and then wait for a prompt before typing `codex`/`claude`."
- They pass `deferSpawn = false` (positional default), so an agent would spawn at 80x24 and take a corrective resize. CLAUDE.md: "Agent PTYs must spawn at the fitted pane size, not at 80x24 followed by a corrective resize."
- They ignore `SessionSpawner`'s agent env, session-id assignment, and MCP injection entirely.

(Spec 032 additionally claimed these methods take the homedir fallback; that is no longer accurate — `allowCwdFallback` defaults to `false` in `createDeferred:157`, so they would fail loudly on a missing cwd. The interactive-shell and no-defer violations stand.) The real agent path is `SessionSpawner.spawnNew`/`spawnResume` → `PtyManager.createDeferred(..., deferSpawn: true)`. These two methods are a trap for any future caller and should be deleted.

## Intended Behavior

1. **Every close path tears down PTYs identically.** Closing a tab, closing other tabs, or closing tabs to the right kills every live PTY in the removed tabs via `pty:kill`, and — if any removed pane was an agent with a known `sessionId` — triggers one `sessions:refresh` after the kills settle, so closed agent sessions promptly appear under Recent. The teardown logic is shared with `closePaneInTab`, not re-duplicated.
2. **A cancelled shell creation kills the PTY it won.** If Effect 2's invoke resolves after cancellation, the renderer immediately issues `pty:kill` for the returned id (fire-and-forget, error-swallowed). A failed creation resets the re-entry guard so a later effect run can retry.
3. **A worker crash is loud and consistent.** On unexpected worker exit (or worker `error` that coincides with exit), `PtyManager` emits `exit` for every spawned id and `error` for every pending deferred spawn, clears all bookkeeping maps (including pending-spawn timers), and marks itself dead so subsequent create calls fail with an emitted `error` instead of hanging. Renderers then show the existing process-exited/agent-disconnected treatment through the already-wired `handlers.ts` exit/error relays. Respawning the worker is explicitly out of scope; surfacing the failure is the fix.
4. **`createClaude`/`createAgent` no longer exist.**

## Implementation Plan

### Step 1 — Extract shared pane teardown in `src/renderer/src/store/panes.ts`

Add a module-level helper (not a store action — it has no state to set) near the other module-level helpers in `panes.ts`:

```ts
/** Kill a pane's PTY and dispose its xterm. Returns true when the pane was an
 *  agent with a known sessionId (caller should schedule a sessions:refresh). */
function teardownPaneRuntime(pane: PaneLeaf): { killPromise: Promise<unknown> | null; needsSessionRefresh: boolean } {
  const hasIpc = typeof window !== 'undefined' && !!window.ipc
  const killPromise = pane.ptyId && hasIpc
    ? window.ipc.invoke('pty:kill', pane.ptyId).catch(() => {})
    : null
  xtermRegistry.dispose(pane.id)
  return { killPromise, needsSessionRefresh: pane.paneType === 'agent' && !!pane.sessionId }
}

/** Tear down every leaf of a tab's tree. Returns the kill promises + refresh flag. */
function teardownTabRuntime(tab: Tab): { killPromises: Promise<unknown>[]; needsSessionRefresh: boolean }
```

Implementation notes:

- To enumerate leaves you need `PaneLeaf` objects, not ids. `collectLeafIds` lives in `src/shared/paneTree.ts:153`, but the leaf-collecting variant `collectLeaves` currently lives in `src/renderer/src/utils/tabLabels.ts:14`. Preferred: add/move `collectLeaves(node: PaneNode): PaneLeaf[]` into `src/shared/paneTree.ts` (re-export from `tabLabels.ts` or update its import) — `paneTree.ts` is the documented home for tree ops and this also fixes the layering inversion. A minimal local recursive walk inside `panes.ts` is acceptable if you want to avoid touching `tabLabels.ts`, but the shared move is cheap.
- Rewrite `closePaneInTab` (`panes.ts:1066`) to use `teardownPaneRuntime` and preserve its exact ordering: kill → (after kill settles) refresh-if-agent → dispose xterm → state update. Note `closePaneInTab` currently refreshes even when the agent pane has no `ptyId` (the `else if` branch at `:1078-1080`) — keep that behavior: an agent pane whose PTY already exited (`agentDisconnected`) still needs its session moved to Recent on close.
- In `closeTab` (`:807`), `closeOtherTabs` (`:892`), and `closeTabsToRight` (`:915`), replace the bare `collectLeafIds(...).forEach((id) => xtermRegistry.dispose(id))` loops with `teardownTabRuntime(tab)` over each removed tab. Collect all kill promises and the OR of `needsSessionRefresh` flags, then after the `set(...)` state update:

  ```ts
  if (needsSessionRefresh && typeof window !== 'undefined' && window.ipc) {
    Promise.allSettled(killPromises).then(() => {
      window.ipc.invoke('sessions:refresh').catch(() => {})
    })
  }
  ```

  One refresh per close action, not one per pane — `sessions:refresh` triggers a full forced poll (`handlers.ts:281-284`); N panes must not fan out N scans.
- Do not change which tabs each action removes, the `activeTabId`/`hydratedTabIds`/`sidebarSectionOpen` computations, or the `hydrateTabForActivation` calls — this change adds teardown, nothing else.
- All IPC use must stay behind the existing `typeof window !== 'undefined' && window.ipc` guard so the store keeps working in tests and non-IPC contexts (see the header comment in `panes.test.ts:11-18`).

### Step 2 — Fix cancelled/failed shell creation in `src/renderer/src/components/Terminal/index.tsx` (Effect 2, `:397-425`)

In the `.then` branch:

```ts
.then((result) => {
  const ptyId = (result as { ptyId?: unknown } | null)?.ptyId
  if (cancelled) {
    // The pane unmounted while pty:create was in flight; nothing will ever own
    // this PTY, so kill it immediately.
    if (typeof ptyId === 'string') window.ipc.invoke('pty:kill', ptyId).catch(() => {})
    return
  }
  if (typeof ptyId !== 'string') throw new Error('pty:create did not return a ptyId')
  ptyIdRef.current = ptyId
  setPtyId(pane.id, ptyId)
})
```

In the `.catch` branch, reset the guard so a later effect run can retry (only if this pane still owns the guard):

```ts
.catch((err) => {
  if (shellCreatePaneRef.current === pane.id) shellCreatePaneRef.current = null
  if (cancelled) return
  setStatus('error')
  setErrorMsg(err instanceof Error ? err.message : 'Failed to create terminal')
})
```

Reset the ref *before* the `cancelled` early-return so a cancelled-then-failed create also unblocks a future mount of the same pane id (Effect 1's cleanup detaches rather than disposes, so the same component instance can re-run Effect 2).

**Testability extraction (preferred).** Effect 2's body is self-contained and has no xterm dependency beyond the initial fit. Extract it into `src/renderer/src/components/Terminal/createShellPty.ts`:

```ts
export interface CreateShellPtyDeps {
  ipc: Pick<Window['ipc'], 'invoke'>
  getInitialSize: () => { cols: number; rows: number }
  onPtyId: (ptyId: string) => void
  onError: (message: string) => void
  releaseGuard: () => void
}
/** Starts pty:create; returns a cancel() that guarantees any late-resolving ptyId is killed. */
export function createShellPty(cwd: string, deps: CreateShellPtyDeps): { cancel: () => void }
```

The effect then becomes a thin adapter (guard ref check/set, `setStatus('connecting')`, wire deps, return the cancel from cleanup). This follows the repo convention of extracting pure logic instead of mocking modules that drag in xterm at load time, and makes the cancel-kill and retry-unblock behavior unit-testable.

### Step 3 — Surface worker crash in `src/main/pty/PtyManager.ts`

1. Add a private field `private workerDead = false` and a private method:

   ```ts
   private _handleWorkerCrash(code: number | null): void {
     if (this.destroying || this.workerDead) return
     this.workerDead = true
     const exitCode = typeof code === 'number' ? code : 1
     // Pending deferred spawns never reached the worker — fail them as spawn errors.
     for (const [id, entry] of this.pendingSpawns) {
       if (entry.timeout !== null) clearTimeout(entry.timeout)
       this.emit('error', id, new Error(`Terminal host process exited unexpectedly (code ${exitCode})`))
     }
     this.pendingSpawns.clear()
     // Spawned PTYs are dead — emit exit so panes show the disconnected banner.
     const ids = [...this.spawnedIds]
     this.spawnedIds.clear()
     this.readyIds.clear()
     this.readyEvents.clear()
     this.pendingResizes.clear()
     for (const id of ids) this.emit('exit', id, exitCode)
   }
   ```

2. Call it from the existing `exit` handler (`:142-144`), keeping the log line:

   ```ts
   this.worker.on('exit', (code) => {
     if (this.destroying) return
     console.error('[PtyManager] worker exited with code', code)
     this._handleWorkerCrash(code)
   })
   ```

   Leave the `worker.on('error')` handler as a log; on Windows a spawn failure of the worker also fires `exit`, and double-emission is prevented by the `workerDead` latch. (If `error` can fire without `exit` in some edge case, calling `_handleWorkerCrash(1)` from it is safe thanks to the latch.)

3. Fail fast on post-crash creates. In `createDeferred` (`:152`), before any registration:

   ```ts
   if (this.workerDead) {
     const id = randomUUID()
     setImmediate(() => this.emit('error', id, new Error('Terminal host process is not running')))
     return id
   }
   ```

   The `setImmediate` preserves the existing contract that callers attach listeners before events fire (see the comment at `:163-166`). `write`/`resize`/`kill` need no change — `_send` already no-ops, and after the crash the maps are empty.

4. Order of emissions matters downstream: `handlers.ts:219-227` handles each `exit` by writing the yellow `[process exited with code N]` banner, sending `pty:exit`, unrouting, and cleaning direct-output buffers — exactly the surfacing we want, per pane, with zero handler changes. `markPtyExited` in the renderer (`panes.ts:1178`) then flips agent panes to `agentDisconnected` and triggers `sessions:refresh`. Shell panes receive `pty:exit` and the banner through the same relays. Do **not** add new IPC channels or renderer changes for this step.

5. Emit `exit` (not `error`) for spawned ids: the `error` relay in `handlers.ts:229-232` only logs and prints red text — it does not unroute, does not send `pty:exit`, and would leave pane state live. `error` is correct only for `pendingSpawns`, matching the existing missing-cwd spawn-error path (`PtyManager.ts:183`) which the renderer already renders as a spawn failure.

### Step 4 — Delete dead methods in `src/main/pty/PtyManager.ts`

- Delete `createClaude` (`:241-243`) and `createAgent` (`:245-248`).
- Delete the now-unused `import type { AgentKind } from '../../shared/types'` (`:19`) — `AgentKind` has no other use in this file. Run `npm run typecheck` to confirm nothing else references them (a repo grep already shows no callers).

## Tests

Repo conventions apply: unit tests co-located beside source; renderer store tests use the **real** zustand store with the auto-reset mock (`__mocks__/zustand.ts`, activated in `tests/setup.renderer.ts`); Vitest does not type-check, so keep `npm run typecheck` green.

### `src/renderer/src/store/panes.test.ts` (extend)

Add a `usePanesStore — tab close tears down PTYs` describe block. The existing tests run with `window.ipc` absent; these tests instead install a stub per test and remove it in `afterEach`:

```ts
const invoke = vi.fn().mockResolvedValue(undefined)
beforeEach(() => { (window as any).ipc = { invoke, on: vi.fn(), send: vi.fn() } })
afterEach(() => { delete (window as any).ipc; invoke.mockClear() })
```

Plant tabs whose leaves carry `ptyId`/`paneType`/`sessionId` (extend the `plantTab` helper or set state directly). Assert:

- `closeTab(tabId)` invokes `pty:kill` once per leaf with a `ptyId` in the closed tab, and does **not** kill PTYs belonging to remaining tabs.
- `closeTab` on a tab containing an agent leaf with a `sessionId` invokes `sessions:refresh` exactly once, and only after the kill promises settle (use `await vi.waitFor(...)` or flush microtasks; assert call counts).
- `closeTab` on a tab with only shell leaves (or agent leaves without `sessionId`) invokes `pty:kill` but **not** `sessions:refresh`.
- `closeOtherTabs(keepId)` kills every PTY outside the kept tab and none inside it; one `sessions:refresh` at most.
- `closeTabsToRight(tabId)` kills only PTYs in tabs after the index.
- With `window.ipc` absent, all three actions still update tab state without throwing (guard regression).
- `closePaneInTab` behavior is unchanged: agent-with-sessionId-but-no-ptyId still triggers `sessions:refresh` (pin the `:1078` branch).

### `src/shared/paneTree.test.ts` (extend, if `collectLeaves` moves)

- `collectLeaves` returns all leaves in order for a nested split and a single leaf; `collectLeafIds(node)` equals `collectLeaves(node).map(l => l.id)`.

### `src/renderer/src/components/Terminal/createShellPty.test.ts` (new, renderer project)

Testing the extracted helper (Step 2) with a fake `ipc.invoke`:

- Resolve after `cancel()`: `pty:kill` is invoked with the returned ptyId; `onPtyId` is not called.
- Resolve before cancel: `onPtyId` called with the id; no kill.
- Reject: `releaseGuard` called, `onError` called with the message.
- Reject after cancel: `releaseGuard` still called; `onError` not called.
- Resolve with a malformed result (`{}` / `null`): treated as error path (guard released, `onError` called), no kill attempted for a non-string id.

If the team opts not to extract the helper, these assertions must instead be covered by a component-level test of `Terminal` with a stubbed `window.ipc` and mocked xterm registry — substantially more setup; the extraction is the recommended route.

### `src/main/pty/PtyManager.crash.test.ts` (new, main/node project)

`PtyManager` imports only `child_process`, `crypto`, `fs`, `os`, `path`, and local pure modules — no Electron at load time — so mock `child_process.spawn` with `vi.mock('child_process', ...)` returning a fake worker (an `EventEmitter` with `send: vi.fn()`, `connected: true`, `stderr: new EventEmitter()`, `exitCode: null`, `signalCode: null`, `kill: vi.fn()`). Use `vi.useFakeTimers()` where deferred-spawn timers are involved. Assert:

- **Spawned ids get exit.** Create a shell (`createShell`), drive it past pending (fire `setImmediate`s via timers or use a real temp cwd), simulate the worker replying `ready`, then emit `exit` on the fake worker: `PtyManager` emits `exit(id, code)` for the id, and `spawnedIds`-dependent behavior is gone (a subsequent `resize`/`write` sends nothing).
- **Pending spawns get error.** Create a deferred agent spawn (`createDeferred(..., deferSpawn: true)`) that has not received its first resize; crash the worker: `error(id, ...)` is emitted, and the deferred fallback timer is cleared (advance timers past `DEFERRED_SPAWN_TIMEOUT_MS`, assert no `spawn` message is sent and no duplicate events fire).
- **Latch.** Emitting worker `exit` twice emits pane events only once.
- **Destroy suppression.** `destroy()` then worker exit emits nothing (existing `destroying` behavior preserved).
- **Post-crash create fails loudly.** After a crash, `createDeferred` emits `error` for the returned id on the next tick and never leaves a silent pending entry.
- **No regression to normal paths.** A normal per-pty worker `exit` message (the `ParentMessage` route at `:100-105`) still emits a single `exit` and cleans that id only.

Note for the implementer: if mocking `child_process` proves brittle, the alternative sanctioned by CLAUDE.md is extracting the crash-fanout into a pure function (e.g. `computeCrashFanout(spawnedIds, pendingSpawns)` returning `{ exitIds, errorIds }`) in a sibling module and unit-testing that; keep at least one integration-shaped test of the event emission either way.

### Dead-code removal (Step 4)

No test — deletion is verified by `npm run typecheck` and grep. Do not add tests that would resurrect the methods' semantics.

## Risks

- **Double-kill and kill-vs-exit races.** `pty:kill` for a PTY that already exited is already tolerated (`PtyManager.kill` deletes from maps and sends a worker `kill`; node-pty's `AttachConsole failed` stderr race is explicitly filtered at `PtyManager.ts:86-93`). The new bulk teardown can only add kills for ids the app created, so no new race class — but keep the `.catch(() => {})` on every kill invoke.
- **`sessions:refresh` cost on bulk close.** Closing many tabs triggers one forced poll, same cost as closing one agent pane today. Ensure the refresh is deduplicated per action (Step 1) — per-pane refreshes would stack scans.
- **Crash fanout ordering.** Emitting `exit` for many ids synchronously in a loop drives many `sendToWindowForPty` calls; this is bounded by pane count and is the same relay used per-pane today. If a renderer window is mid-teardown, `sendToWindowForPty` already handles missing routes (output falls into `pendingDirectOutput` or is dropped by `unroutePty` in the exit relay).
- **Behavioral change for detached windows.** `closeTab` also runs in detached-window renderers; PTY kills issued from any window are accepted by `pty:kill` (no ownership check today — do not add one here; that is spec-032 item 30's scope and touches the transfer protocol).
- **Effect 2 dependency array.** Do not "fix" the unusual dep expression at `index.tsx:425` (`status === 'mounting' ? 'mounting' : 'ready'`) in this PR; it is pinned by other behavior (spec-032 item 48 covers it). Only the promise-body changes described in Step 2 are in scope.
- **Latent callers of deleted methods.** Grep says none exist; typecheck is the backstop. If an out-of-tree branch calls them, the correct migration is `SessionSpawner`, never a re-add.

## Verification Steps

Automated:

1. `npm test` — all projects green, including the new/extended tests above.
2. `npm run typecheck` — green (also proves Step 4 deleted cleanly and test files type-check).
3. `npm run test:e2e` — the startup suite still passes (cold restore, `pty:ready`, deferred Claude spawn are all adjacent to the touched code).

Manual (Windows, `npm run dev`):

1. **Tab close kills processes.** Open a tab with a shell pane and an agent pane; note the PowerShell/agent PIDs (`Get-Process powershell`, or Process Explorer child tree under the app). Close the whole tab (tab context menu → Close). Confirm: the processes exit within a second or two, and the agent's session appears under the sidebar Recent section without waiting ~5s… then repeat for "Close Other Tabs" and "Close Tabs to the Right".
2. **Cancel leak.** Rapidly split a shell pane and close it while it is still on the "connecting" overlay (or add a temporary artificial delay to `pty:create` in dev). Confirm no orphan `powershell.exe` remains under the app's process tree.
3. **Create-retry after failure.** Point a new shell pane at a cwd that fails creation (e.g. temporarily rename the directory so `pty:create` errors), observe the error overlay, restore the directory, and confirm a re-triggered creation (e.g. remount via tab switch) succeeds instead of silently doing nothing.
4. **Worker crash surfacing.** With several shell and agent panes open, kill the ptyWorker process (find the `electron.exe` child running `ptyWorker.js` in Process Explorer, or `taskkill /F /PID <pid>`). Confirm every pane immediately shows the yellow `[process exited with code N]` banner / agent-disconnected treatment instead of a silent dead terminal, agent panes show their disconnected recovery UI, and opening a *new* shell pane shows an error rather than an eternal "connecting" spinner.
5. **Shutdown regression.** Quit the app normally; confirm no `[PtyManager] worker exited` crash-fanout noise in the log during a clean `destroy()`.

## Handoff Contract

### Non-negotiables (CLAUDE.md invariants — violating any of these fails review)

1. **No flow control.** Do not add coalescing, acks, seq handling, pause/resume, or watermarks anywhere in the PTY output path. This spec touches lifecycle only.
2. **Keep deferred agent spawn.** `SessionSpawner` → `createDeferred(..., deferSpawn: true)` and the first-resize/timeout handshake must be preserved exactly; the crash handling must clear pending-spawn timers but must not alter the spawn-size handshake for live workers.
3. **Keep worker isolation.** node-pty stays in the `ELECTRON_RUN_AS_NODE=1` child process. No respawn logic, no in-main-process fallback.
4. **No homedir fallback for agents.** Do not change `allowCwdFallback` semantics; agent spawns keep failing loudly on missing cwd. Deleting `createClaude`/`createAgent` must not be "fixed" by making them correct — delete them.
5. **No PATH rewrite** of any kind in `buildEnv` or the spawn path (spec 012/013 root cause).
6. **No config-file mutation, no new IPC channels.** The fix reuses `pty:kill`, `pty:exit`, `sessions:refresh`, and the existing PtyManager `exit`/`error` events.
7. **Store discipline.** Renderer IPC use stays behind the `window.ipc` guard; store tests use the real store with the auto-reset mock; no mocking of the zustand store itself.

### Definition of Done

- All four steps implemented; `createClaude`/`createAgent` and the orphaned `AgentKind` import removed.
- Tests listed above added and passing; `npm test`, `npm run typecheck`, and `npm run test:e2e` green.
- Manual checks 1–5 performed on Windows and behaving as described (state which were run in the PR description).
- No changes to: which tabs each close action removes, focus/hydration/sidebar computations in those actions, `handlers.ts` exit/error relays, the Effect 2 dependency array, or any timeout constants.
- `specs/pending/032-code-improvement-backlog.md` updated to mark items 2, 14, 15, and 34 as superseded by this spec (one-line note each), so the backlog does not double-assign them.

## Out of Scope

- **Worker auto-respawn / pane reconnection** after a crash — surfacing only. A future spec may add opt-in respawn with explicit pane re-attachment.
- **Main-side orphan PTY GC** (reaping PTYs no renderer claims) — the renderer close paths are made correct instead.
- **Sender-ownership checks on `pty:write`/`pty:resize`/`pty:kill`** (spec-032 item 30) — touches the cross-window transfer protocol.
- **Effect 2 dep-array cleanup** (spec-032 item 48) and the broader `panes.ts` extraction (spec-032 item 29) — only `teardownPaneRuntime`/`teardownTabRuntime` (and optionally `collectLeaves`' move to `paneTree.ts`) are extracted here.
- Any other spec-032 backlog item.
