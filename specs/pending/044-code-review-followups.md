# 044 — Code-Review Follow-ups for the IPC / Panes / Settings Refactor

## Implementation Status (2026-07-04)

Implementation is functionally complete, but the full Definition of Done has not yet been met. Do not move this spec out of `pending` until the remaining automated regression tests and manual Windows checks below are complete.

### Completed

- [x] Step 1: `pty:kill` can tear down a PTY regardless of the sender window; `senderMayControlPty` still rejects cross-window input ownership.
- [x] Step 2: `SessionIndex.upsertMany` catches and logs per-session failures while committing valid rows.
- [x] Step 3: the session poller exposes `markDirty`; deletes, latest-for-cwd upserts, Codex recovery upserts, and deep-search hydration mark the index dirty.
- [x] Step 4: a forced refresh arriving during an active poll waits for that poll and a coalesced forced pass.
- [x] Step 5: OSC carry-over retains only an unterminated OSC sequence, bounded to 256 characters.
- [x] Step 6: scrollback input strips non-digits before normalization and restores `inputMode="numeric"`.
- [x] Step 7: rejected `tab:absorb` and `pane:transfer` invokes are caught and logged; rejected tab absorption removes the optimistic local tab.
- [x] Step 8: resume failures only update a matching agent pane that remains PTY-less.
- [x] Step 9: worker `error` events invoke crash fanout; the existing latch prevents duplicate fanout when `exit` follows.
- [x] Step 10: the `panes.ts`/`panesIpc.ts` initialization-order dependency is documented.
- [x] Focused tests added for cross-window PTY teardown, dirty/forced session polling, OSC-tail extraction, and worker error fanout.
- [x] `npm test` passed: 46 files, 404 tests.
- [x] `npm run typecheck` passed.
- [x] `npm run test:e2e` passed: 9 tests.

### Remaining Automated Work

- [ ] Add a direct malformed-session batch regression test proving one invalid row is logged/skipped while valid rows commit and polling still broadcasts.
- [ ] Add router-level OSC tests proving split sequences still parse and `633;D` invokes command completion exactly once across chunk boundaries.
- [ ] Add `ScrollbackSetting` UI tests proving `"500,000"` commits as `500000` and an empty draft normalizes to the default.
- [ ] Add pane-store tests proving a delayed resume rejection cannot stamp `resumeError` after the pane gains a `ptyId` or changes session.
- [ ] Add pane-drag tests proving rejected `tab:absorb` rolls back the optimistic local tab and rejected transfers are caught/logged.
- [ ] Re-run `npm test`, `npm run typecheck`, and `npm run test:e2e` after adding the remaining tests.

### Remaining Manual Windows Checks

- [ ] Detached close kills processes and the tab does not resurrect.
- [ ] A malformed transcript does not blank the session list.
- [ ] External session deletion reaches other windows within one poll tick.
- [ ] Closing an agent pane moves its session to Recent immediately during a polling race.
- [ ] Scrollback input `500,000` commits as `500000`.
- [ ] A rejected transfer logs and rolls back without an unhandled rejection.
- [ ] A delayed resume failure does not add an error banner to a reused/live pane, if the timing can be reproduced manually.
- [ ] Worker spawn failure surfaces pane errors without duplicate fanout if `exit` also fires.

Two independent deep reviews of the `code-review-improvements` branch (handlers.ts decomposition, panes store extraction, settings dedup, spec-024 acks, no-flow-control, buildEnv PATH guard) both came back structurally sound — every load-bearing CLAUDE.md invariant held up — but they surfaced a shared set of real behavior regressions vs master. The reviews agree on every item below; this spec consolidates them into one fix list, ranked by blast radius.

This spec is self-contained. Governing invariants: CLAUDE.md "PTY Isolation", "Multi-Window State Invariants", "Session Indexing", and spec 024's transfer-ack semantics.

## Problem

The refactor shipped genuine improvements (PTY leak on cancelled shell create fixed, tab-close now kills pane PTYs, stronger deep-search generation counter, awaited `applyLayout` before `layoutReady`) but regressed several narrow paths. Two are near-blockers that break user-visible features the refactor was meant to preserve; the rest are smaller regressions and fragility. Ranked by how likely a user is to hit them.

## Current Behavior

All line numbers verified against the working tree at the time of writing.

### A. Near-blocker — closing a detached tab from the primary sidebar no longer kills its processes

`pty:kill` (`src/main/ipc/handlers.ts:254-261`) now routes through `killPtyIfAllowed` (`src/main/ipc/ptyControl.ts:12-17`), which rejects the kill when `senderMayControlPty(owner, senderId)` is false — i.e. when the PTY's owner window (per `windowManager.getPtyOwner`) differs from the sender. This guard was added (correctly) to stop one window writing/resizing another window's PTY. But it also rejects a legitimate case: the primary window closing a tab whose panes are currently routed to a detached window.

Concretely: drag a tab into a detached window, then close that tab from the **primary** sidebar. The primary's `closePaneInTab`/`closeTab` invokes `pty:kill`, `getPtyOwner(ptyId)` returns the detached window's id, `e.sender.id` is the primary window's id, so the kill returns `false` without unrouting/releasing/killing. The shell/agent processes keep running, and the detached window's next `tab:state-sync` resurrects the tab — "close" silently does nothing. Master had no ownership check on `pty:kill` and killed regardless of sender.

### B. Near-blocker — one malformed transcript blanks the entire session list, permanently

`createSessionPoller.poll` (`src/main/sessions/sessionPoll.ts:13-34`) calls `deps.index.upsertMany(scanned)` (`:23`) for the whole scan in one go. If `upsertMany` runs the batch inside a single SQLite transaction (as the refactor made it), one malformed `ScannedSession` throws, the whole batch rolls back, `poll()` rejects, and the startup catch broadcasts an **empty** `sessions:updated`. Every subsequent 5s poll hits the same bad file and fails identically — the sidebar shows nothing until the file is removed. Master skipped malformed entries per-row inside the loop; that tolerance was lost when the scan moved into one transaction.

### C. Session-poll broadcast suppression — `sessionPoll.ts:29`

The poller only broadcasts when `effectiveForce || changed > 0 || cwdFingerprint !== lastCwdFingerprint`. `changed` reflects only what **this poller's** `upsertMany` detected. Sessions mutated outside the poller — Codex recovery upserts, `sessions:latest-for-cwd`, deep-search hydration upserts, and deletions observed by other windows — change the index without touching `changed`, and only sometimes move the `cwdFingerprint`. Result: the sidebar/Session Browser can go stale indefinitely after a delete in one window until an unrelated change tips `changed` or the fingerprint. (Reviews 1 and 2 both flag this; Review 1 frames it as "detached-window session list goes stale after delete".)

### D. `sessions:refresh` returns stale data when it races the 5s poll — `sessionPoll.ts:14-17`

```ts
if (inFlight) {
  forcePending ||= force
  return
}
```

A `force` call while a poll is in flight just latches `forcePending` and returns immediately — it does not await the in-flight scan or the forced pass it scheduled. This defeats CLAUDE.md's "immediate move to Recent on agent pane close" contract: closing an agent pane right after a poll starts shows the session as still-live for ~5s. The forced pass should await the in-flight scan, then run.

### E. OSC tail carry-over — `src/main/ipc/ptyOutputRouter.ts:13`

```ts
const scan=(oscTails.get(id)??'')+data;oscTails.set(id,scan.slice(-64)); ...
```

The 64-char carry-over is prepended to every incoming chunk before the cwd/command-complete parse. Two effects:

1. A stale `\x1b]633;P;Cwd=<old>` tail can re-match against the new chunk, so a real `cd` update is suppressed for one prompt cycle (the `lastCwd.get(id) !== cwd` guard sees the stale cwd as equal).
2. The `\x1b]633;D` (command-complete) substring test can match entirely inside the carried tail, re-firing `onCommandComplete` (and thus redundant git-branch probes) per keystroke chunk rather than once per command.

The tail exists to catch OSC sequences split across `data` chunks. It should be trimmed to the longest unterminated OSC prefix only, not a blind 64-char window.

### F. Scrollback setting eats commas — `src/renderer/src/components/SettingsPanel/settings/ScrollbackSetting.tsx:4`

```ts
const commit=():void=>{const next=normalizeTerminalScrollbackLines(Number(draft)); ... }
```

`Number("500,000")` is `NaN`, so `normalizeTerminalScrollbackLines` clamps it back to the 250k default — typing `500,000` silently resets to `250000`. Master stripped commas before normalizing. The refactor also dropped `inputMode="numeric"` from the input.

### G. `tab:absorb` / `pane:transfer` invokes lost their `.catch` — `src/renderer/src/utils/paneDrag.ts:31,47`

```ts
void window.ipc.invoke('tab:absorb', ...).then((ok) => { if (!ok) deps.removeTabLocally(tab.id) })
...
else void window.ipc.invoke('pane:transfer', { ... })
```

Neither chain has a `.catch`. A rejected transfer IPC (transfer timed out and rolled back on the main side, window closed mid-drag, etc.) now surfaces as an unhandled promise rejection instead of a logged error, and the optimistic local mutation is never rolled back. No state is corrupted (main owns truth) but the failure is louder and less recoverable than master, which `.catch`-logged both.

### H. Stale `resumeError` can stamp onto a live pane — `src/renderer/src/store/panes.ts:490-495`

```ts
} catch (err) {
  console.error('session:resume IPC failed', err)
  get().updatePane(paneId, {
    resumeError: agentIpcErrorMessage(err, 'Session resume failed'),
    ...opts.extraFailurePatch,
  })
}
```

A slow failed startup resume can resolve after the user has already reused the pane (started a new session in it, or it got re-hydrated with a live `ptyId`). The catch unconditionally writes `resumeError` to `paneId` with no current-state check, stamping an error banner on a pane that is now live. The success branch at `:482` guards with `current?.sessionId === sessionId && !current.ptyId`; the catch has no equivalent guard. Master guarded the catch against the current pane state.

### I. Worker spawn-failure hang — `src/main/pty/PtyManager.ts:140-148`

```ts
this.worker.on('error', (err) => {
  console.error('[PtyManager] worker error:', err)
})

this.worker.on('exit', (code) => {
  if (this.destroying) return
  console.error('[PtyManager] worker exited with code', code)
  this._handleWorkerCrash(code)
})
```

The crash fanout (`_handleWorkerCrash`, added in spec 034) fires only from the `exit` handler. If the worker process fails to spawn at all (ENOENT on the worker script, broken node binary), Node emits `error` and on some platforms does **not** emit `exit`. The `workerDead` latch never sets, `_send` keeps no-op-ing on `worker.connected`, and every pane hangs silently with no banner and no recovery — exactly the failure mode spec 034 set out to eliminate. One-line fix: call `_handleWorkerCrash` from the `error` path too (the `workerDead` latch makes this safe even when `error` and `exit` both fire).

### J. Fragile module-init ordering between `panes.ts` and `panesIpc.ts`

The IPC listeners are wired at module load in `panesIpc.ts` against the store exported from `panes.ts`, with a module-level "already wired" flag. It is correct today because `panesIpc.ts` is only ever imported as a side effect after `panes.ts`. But a future direct import of `panesIpc.ts` (e.g. a tree-shake change, a test importing it for its types) would hit a TDZ `ReferenceError` at startup. Not a current bug; worth a defensive comment or moving the wired flag so the ordering dependency is explicit.

## Intended Behavior

1. **A tab closed from any window kills its PTYs.** The `pty:kill` ownership guard stays for `pty:write`/`pty:resize`, but `pty:kill` is treated as a teardown primitive: the primary window closing a tab whose panes are routed to a detached window must still kill those PTYs (and unrout/release them). The kill either bypasses the owner check, or is relayed to the owning window, or the owner check is scoped to allow the primary window to kill any PTY. Pick the simplest correct option (see Implementation).
2. **One bad transcript never blanks the list.** `upsertMany` (or the poller driving it) skips malformed entries per-row inside the transaction loop, so a single bad file is dropped while the rest of the batch commits. A poll never rejects solely because one entry was unparseable.
3. **The poller broadcasts on any index change.** Sessions upserted or deleted outside the poller still reach the renderer. Either expose a "dirty" signal the poller checks, or have the external mutators request a forced broadcast.
4. **`sessions:refresh` is fresh.** A forced poll that arrives while a poll is in flight awaits that scan and then runs a forced pass, returning only after the fresh state is broadcast.
5. **OSC tail only carries unterminated sequences.** The carry-over is the tail of the chunk starting at the last incomplete ESC sequence, not a blind 64-char window. A stale completed `Cwd=` is not re-matched; `633;D` fires once per command.
6. **Scrollback accepts comma input.** Commas are stripped before `Number(...)`; `inputMode="numeric"` is restored.
7. **Transfer invokes log and roll back on rejection.** `tab:absorb`/`pane:transfer` get `.catch` handlers; the optimistic local mutation is rolled back on rejection.
8. **`resumeError` only stamps on the pane that is still waiting.** The catch guards against the current pane state — only write `resumeError` when the pane is still the same session and still has no `ptyId`.
9. **A worker that fails to spawn is surfaced, not hung.** The `error` handler calls `_handleWorkerCrash`; the latch prevents double-fanout.
10. **The `panes.ts`/`panesIpc.ts` init ordering is explicit** (comment or moved flag).

## Implementation Plan

### Step 1 — Let tab close kill detached-window PTYs (A)

The owner guard's purpose is to stop one window **inputting** into another's pane. `pty:kill` is a teardown, not input. Two viable options; pick one:

- **Preferred (simplest):** in `src/main/ipc/ptyControl.ts`, drop the owner check from the kill path only. `killPtyIfAllowed` already exists as a distinct function from the `pty:write`/`pty:resize` `senderMayControlPty` guard — make `killPtyIfAllowed` always proceed (unroute/release/kill), and keep `senderMayControlPty` enforcing on `pty:write`/`pty:resize` in `handlers.ts:242-246`. Update `ptyControl.test.ts` accordingly: the kill test now expects the kill to proceed regardless of owner, while a new test pins that `senderMayControlPty` still rejects cross-window writes.
- **Alternative:** relay the kill to the owning window via a new event and have it issue `pty:kill`. More moving parts and a new IPC channel; only choose this if there is a reason the primary window must not kill detached PTYs directly (there is not — `ptyManager.kill(id)` is window-agnostic, and `unroutePty`/`releasePty` already clean cross-window routing state).

Verify against spec 024: killing a PTY whose tab is mid-transfer must not corrupt the ack/rollback flow. The kill path already calls `unroutePty` + `releasePty`, which is exactly what a finalized transfer's teardown does; a kill during a pending transfer is equivalent to the source finalizing early, which spec 024's source-finalize-deferred-until-ack rule already tolerates.

### Step 2 — Restore per-row malformed-entry tolerance (B)

In `upsertMany` (or wherever the transaction loop lives — find via `SessionIndex.upsertMany`), wrap each entry's upsert in its own try/catch inside the transaction. On a per-row parse/insert failure, log and `continue` rather than throwing. The transaction still commits the surviving rows. Confirm:

- The startup path (`sessionPoll.poll` rejection → empty broadcast) no longer fires for a single bad file.
- `poll()` resolves (does not reject) when N-1 of N entries are good.
- A genuinely empty scan still broadcasts normally.

If the transaction is per-statement (not a single wrapping transaction), the fix is the same shape: catch per row.

### Step 3 — Broadcast on external mutations (C)

Cheapest correct option: track an `externalDirty` flag in the poller closure, set by a new `markDirty()` the external mutators call (Codex recovery, `sessions:latest-for-cwd`, deep-search hydration, and the `sessions:delete` handler). The poll broadcasts when `effectiveForce || changed > 0 || externalDirty || cwdFingerprint !== lastCwdFingerprint`, and clears `externalDirty` after broadcasting. This avoids widening the broadcast condition to "always broadcast" (which would defeat the whole point of the change-suppression) while guaranteeing external changes reach the renderer within one poll tick.

Alternatively, have `sessions:delete` and the external upserts call `poll(true)` directly (forcing a broadcast). This is simpler but couples those paths to the poller; weigh against the dirty-flag approach. The dirty flag is preferred because it coalesces multiple external changes into one broadcast.

### Step 4 — Make `sessions:refresh` await an in-flight poll (D)

In `createSessionPoller`, when `force` arrives and `inFlight` is true, do not return immediately. Instead, await the in-flight poll and then run a forced pass. Concretely: store the in-flight promise, and have a forced call chain `await inflight; then poll(true)`. Clear `forcePending` once the explicit forced pass is queued so the in-flight poll does not also force. Ensure no unbounded promise chain: the forced pass is a single extra poll, not a recursive fan-out.

### Step 5 — Trim OSC tail to unterminated prefix only (E)

In `ptyOutputRouter.ts:13`, replace the blind `scan.slice(-64)` with a function that returns the tail starting at the last incomplete OSC sequence (an ESC `\x1b` not followed by a BEL `\x07` or ST `\x1b\\` terminator). A completed `633;P;Cwd=...` terminated by BEL is dropped from the tail entirely, so it cannot re-match. Keep a small upper bound (e.g. 256 chars) to bound memory. Add the parser as a pure helper in `shellIntegration.ts` so it is unit-testable, and test: split-sequence carry-over still works, completed sequences are not re-matched, and `633;D` fires exactly once per command even across chunk boundaries.

### Step 6 — Strip commas + restore numeric input (F)

In `ScrollbackSetting.tsx:4`, change `commit` to strip non-digit characters before `Number(...)`: `Number(draft.replace(/[^\d]/g, ''))`. Restore `inputMode="numeric"` on the input. Optionally add a small test asserting `commit` on `"500,000"` yields `500000` (test the `normalizeTerminalScrollbackLines(Number(draft.replace(/[^\d]/g,'')))` shape, or extract a `parseScrollbackDraft` helper).

### Step 7 — Re-add `.catch` on transfer invokes (G)

In `paneDrag.ts:31` and `:47`, append `.catch((err) => { console.error('tab:absorb/pane:transfer failed', err); /* rollback optimistic local mutation */ })`. For `tab:absorb`, the rollback is `deps.removeTabLocally(tab.id)` (same as the `!ok` branch). For `pane:transfer`, the cross-window path does an optimistic `deps.movePaneToTab`; on rejection there is no cheap local rollback (the pane was moved optimistically and main owns truth) — at minimum log the error so it is not an unhandled rejection; if a rollback action is available in `deps`, call it.

### Step 8 — Guard `resumeError` against a live pane (H)

In `panes.ts:490` catch block, re-read the current pane and only patch `resumeError` when the pane is still the same session and still PTY-less — mirror the success branch's guard at `:482`:

```ts
} catch (err) {
  console.error('session:resume IPC failed', err)
  const current = get().findPaneInAnyTab(paneId)
  if (current?.paneType === 'agent' && current.agentKind === agentKind && current.sessionId === sessionId && !current.ptyId) {
    get().updatePane(paneId, {
      resumeError: agentIpcErrorMessage(err, 'Session resume failed'),
      ...opts.extraFailurePatch,
    })
  }
}
```

### Step 9 — Surface worker spawn failure (I)

In `PtyManager.ts:140-142`, call the crash handler from the error path:

```ts
this.worker.on('error', (err) => {
  console.error('[PtyManager] worker error:', err)
  this._handleWorkerCrash(null)
})
```

The `workerDead` latch inside `_handleWorkerCrash` makes this a no-op if `exit` already fanned out, and a correct single fan-out if `error` is the only event. Confirm `createDeferred`'s post-crash fail-fast (`workerDead` check) still triggers, so new panes error loudly instead of hanging.

### Step 10 — Document/init-order hygiene (J)

Add a header comment to `panesIpc.ts` stating it must be imported only as a side effect after `panes.ts`, and/or move the "already wired" flag so a TDZ import fails loudly with a clear message. No behavior change.

## Tests

Repo conventions apply: unit tests co-located beside source; renderer store tests use the real zustand store with the auto-reset mock; Vitest does not type-check, so keep `npm run typecheck` green.

- **`src/main/ipc/ptyControl.test.ts` (extend).** Pin: `killPtyIfAllowed` proceeds (unroute/release/kill called) regardless of owner if Step 1 takes the preferred route; `senderMayControlPty` still rejects cross-window writes (regression guard for the `pty:write`/`pty:resize` path).
- **`src/main/sessions/sessionPoll.test.ts` (extend or create).** Plant a scan that throws on one entry: `poll()` resolves, the good entries are upserted, broadcast fires. Plant an external `markDirty()` (Step 3): broadcast fires even when `changed === 0`. Force-while-in-flight (Step 4): the forced caller does not resolve until the in-flight scan and a forced pass have both completed; assert ordering via `vi.useFakeTimers()` + awaited promises.
- **`src/main/pty/shellIntegration.test.ts` (extend).** OSC tail helper: split `633;P;Cwd=...` across two chunks still parses; a completed+terminated sequence is not re-matched from the tail; `633;D` fires once per command across chunk boundaries.
- **`src/renderer/src/components/SettingsPanel/settings/ScrollbackSetting.test.tsx` (new or extend).** `commit` on `"500,000"` → `500000`; on `""` → default.
- **`src/renderer/src/store/panes.test.ts` (extend).** The resume catch no longer stamps `resumeError` when the pane has since gained a `ptyId` or changed session (plant a pane, simulate a slow rejected resume, mutate the pane mid-flight, assert no `resumeError`).
- **`src/main/pty/PtyManager.crash.test.ts` (extend, per spec 034's test shape).** Worker `error` with no `exit` still fans out (spawned ids get `exit`, pending spawns get `error`, `workerDead` latched, post-crash create fails loudly). Worker `error` followed by `exit` fans out exactly once.
- **`paneDrag` (extend if a test exists).** A rejecting `tab:absorb` invoke triggers `removeTabLocally` (or at minimum logs) instead of an unhandled rejection.

## Risks

- **Removing the `pty:kill` owner check (Step 1).** This broadens who can kill a PTY. The only callers of `pty:kill` are renderer teardown paths (`closePaneInTab`/`closeTab`/`closeOtherTabs`/`closeTabsToRight`); none are user-input-driven, so there is no new "type into another window's pane" exposure. `pty:write`/`pty:resize` keep the guard. Verify no other `pty:kill` caller depends on the rejection.
- **Per-row tolerance changing transaction semantics (Step 2).** Wrapping each row's try/catch must not silently swallow legitimate errors (e.g. a corrupted index). Log every skipped row at warn level so a real corruption is still visible.
- **`externalDirty` flag staleness (Step 3).** If a mutator forgets to call `markDirty()`, the stale-list bug returns for that path. Centralize the call (e.g. wrap all external upserts) rather than sprinkling.
- **OSC tail trimming (Step 5).** An over-aggressive trim could drop a legitimately split sequence and miss a cwd update. Bound the tail generously (≥256 chars) and test split-sequence parsing explicitly.
- **Awaiting in-flight poll (Step 4).** Do not create a recursive promise chain; the forced pass is one extra poll, awaited once.
- **`resumeError` guard (Step 8).** The guard must use the same `findPaneInAnyTab` shape as the success branch so a pane moved between tabs mid-resume is handled identically.

## Verification Steps

Automated:

1. `npm test` — all projects green, including the new/extended tests above.
2. `npm run typecheck` — green.
3. `npm run test:e2e` — startup suite still passes (cold restore, `pty:ready`, deferred Claude spawn, cross-window `tab:absorb`).

Manual (Windows, `npm run dev`):

1. **Detached close kills processes.** Drag a tab into a detached window with a shell + agent pane; note the PIDs; close the tab from the **primary** sidebar. Confirm the processes exit and the tab does not resurrect on the next `tab:state-sync`.
2. **Malformed transcript tolerated.** Drop a syntactically broken `.jsonl` into `~/.claude/projects/<encoded-cwd>/`; confirm the session list still populates and a poll does not blank it.
3. **External change reaches sidebar.** Delete a session from the Session Browser in one window; confirm a detached window's sidebar updates within one poll tick (or on `markDirty`).
4. **Immediate Recent move.** Close an agent pane immediately after triggering a poll (or with a poll in flight); confirm the session moves to Recent without the ~5s wait.
5. **Scrollback commas.** Type `500,000` into the scrollback field, blur; confirm it commits `500000`, not `250000`.
6. **Transfer rejection logs.** Force a `tab:absorb` to time out (e.g. close the target window mid-drag); confirm a logged error and local rollback, not an unhandled rejection.
7. **Slow resume no longer stamps a live pane.** (Hard to time manually; rely on the unit test, but if reproducing: cause a resume to fail slowly, reuse the pane before the failure resolves, confirm no stale `resumeError` banner.)
8. **Worker spawn failure surfaced.** Make the worker script unspawnable in dev (e.g. temporarily rename the worker entry) and launch; confirm panes show the crash banner instead of hanging, with no duplicate fan-out if `exit` also fires.

## Handoff Contract

### Non-negotiables (CLAUDE.md invariants — violating any fails review)

1. **No flow control.** Do not add coalescing/acks/seq/pause/resume/watermarks to the PTY output path. The OSC tail fix (Step 5) is a parser change, not output flow control.
2. **No PATH rewrite** in `buildEnv` or the spawn path.
3. **No config-file mutation, no new IPC channels** unless Step 1 takes the relay alternative (which is discouraged). The dirty-flag (Step 3) and await-in-flight (Step 4) changes are internal to the poller.
4. **Spec 024 transfer-ack semantics intact.** A kill during a pending transfer (Step 1) must not break ack/rollback — it is equivalent to early source finalize.
5. **Store discipline.** Renderer IPC use stays behind the `window.ipc` guard; store tests use the real store with the auto-reset mock.
6. **Per-row tolerance (Step 2) must not mask real index corruption** — log skipped rows.

### Definition of Done

- Steps 1–9 implemented (Step 10 is a comment/flag move). `npm test`, `npm run typecheck`, and `npm run test:e2e` green.
- Tests listed above added and passing.
- Manual checks 1–8 performed on Windows and behaving as described (state which were run in the PR description).
- No changes to: the `pty:write`/`pty:resize` owner guard, deferred agent spawn, no-homedir-fallback for agents, `handlers.ts` exit/error relays, or any timeout constants.

## Out of Scope

- **macOS-only:** recreated primary window never re-registered with `WindowManager` (latent; master crashed on that path anyway).
- **`browser_set_cookies` silently drops `sameSite`** and other undocumented cookie fields.
- **Dead `src/main/mcp/tools/*` modules** worth deleting.
- **O(n²) cache eviction in `CodexSessionScanner`.**
- **Unbounded `pendingResizes` growth after a worker crash** (the crash fanout clears `pendingResizes` once; a slow leak across many crashes is theoretical).
- **`byteLength` is now code units, not bytes** (unread per the no-flow-control contract — `seq`/`byteLength` are shape-only).
- **Stricter browser MCP arg validation** now rejecting string coordinates agents previously got away with (intentional tightening, spec 039).
- Worker auto-respawn / pane reconnection (spec 034 out-of-scope carry-forward).
