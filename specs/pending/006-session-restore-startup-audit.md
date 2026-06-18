# Session Restore Startup Audit

## Status

Audited against current code and ready for implementation planning. This spec records restore-loss risks found in the Codex and Claude Code session restore paths. Do not treat the findings as historical notes; each item should be verified again immediately before implementation if the restore, window, or session-detection code has changed.

## Audit Scope

Reviewed code paths:

- `src/renderer/src/App.tsx` startup restore, detached sync, and debounced layout save
- `src/renderer/src/store/panes.ts` `applyLayout`, tab hydration, `session:detected`, and multi-window tab merge logic
- `src/main/ipc/handlers.ts` layout persistence, session spawn/resume IPC, and tab/window transfer IPC
- `src/main/window/WindowManager.ts` detached-window ownership and close-time return behavior
- `src/main/sessions/SessionSpawner.ts` Claude and Codex session detection
- `src/main/sessions/TranscriptScanner.ts` and `src/main/sessions/CodexSessionScanner.ts` session metadata scanning

## Problem

App startup is intended to restore the previous workspace automatically: tab metadata should load eagerly, only the active tab should hydrate immediately, and restorable agent panes should resume their Claude or Codex session when hydrated.

Several current paths can make a session look lost on startup even when transcript files still exist:

- saved tabs can remain marked `detached` even though detached windows are not recreated on app launch
- closing the primary window can destroy detached windows before their latest state is merged and saved by the primary renderer
- agent panes saved before a reliable `sessionId` is detected are converted to shell panes on the next startup
- restored agent panes with a valid saved `sessionId` can be converted to shell panes after a transient resume failure
- Claude and Codex session detection still has global FIFO/watch heuristics that can assign the wrong session id or miss the intended one

## Priority Findings

1. **P0 - Stale detached ownership can orphan tabs on fresh startup.** `applyLayout` preserves `tab.detached`, but startup never recreates detached windows or main-process ownership maps. Normalize all saved tabs to primary-owned during primary startup.
2. **P0 - Primary shutdown can persist stale detached state.** Only the primary renderer saves layout, but `mainWindow.on('closed')` closes detached windows after the primary renderer is gone or shutting down. Add an explicit final save/merge path or move ownership persistence to main.
3. **P0 - Detection races can persist wrong `sessionId`s.** Claude uses global FIFO; Codex has a global watcher that can beat the cwd/time-constrained poller. Detection must validate cwd/time/source strongly enough that unrelated JSONL writes cannot claim a pane.
4. **P1 - Missing or late session ids turn agent panes into shells.** Newly started panes save as agents with no `sessionId` until `session:detected` arrives. Startup currently treats that as unresumable.
5. **P1 - Resume failures can permanently downgrade valid restored agents.** `hydrateTabRuntime` catches `session:resume` errors and rewrites the pane to shell; the normal debounced layout save can then persist the downgrade.

## Current Behavior

### Stale detached flags are restored from disk

`App.tsx` loads `layout.json` in the primary window and passes saved tabs directly to `usePanesStore.applyLayout(...)`. `applyLayout` sanitizes pane runtime state and `ptyId`, but it preserves `tab.detached`.

On a fresh app launch there are no detached BrowserWindows and no `WindowManager` tab ownership records. A saved tab with `detached: true` is still treated as detached in the renderer:

- the tab bar filters out detached tabs
- the sidebar may show a detached tab that no live window owns
- `activeTabId` can still point at a detached tab
- `applyLayout` can hydrate that active tab even though it is not visible in the primary tab strip

This is a direct startup lost-session risk after quitting with detached tabs.

### Detached state is saved only by the primary renderer

Detached windows never call `layout:save`; only the primary renderer writes layout after `layoutReady`. The primary receives detached tab updates through debounced `tab:state-sync`, then saves its merged `tabs` array.

On primary window close, `src/main/index.ts` closes all windows from `mainWindow.on('closed')`. `WindowManager.unregister(...)` can send `tab:return` when a detached window closes, but by then the primary renderer may already be closed or unable to receive the return and issue a final `layout:save`.

Result: the durable layout can remain stale, with old detached flags, old focused pane ids, or missing recent pane moves that only existed in the detached renderer.

### Agent panes without session ids are discarded as restorable agents

`applyLayout` converts any restored `paneType: 'agent'` leaf without `sessionId` into a shell pane. That is correct for truly blank/unstarted agent panes, but risky when detection was delayed, missed, or misassigned during the previous run.

`session:new` returns `{ ptyId, sessionId: null }` for both agents and relies on later `session:detected` to fill the pane id. If the app is closed before detection updates renderer state and the debounced layout save persists it, startup strips `ptyId` and downgrades the pane to a shell. From the user's perspective, the app did not restore the agent session.

### Restored agents are downgraded after resume errors

`hydrateTabRuntime(...)` resumes restored agent leaves by calling `session:resume`. If that IPC call rejects, the catch handler immediately mutates the pane to `{ paneType: 'shell', agentKind: undefined, sessionId: undefined }`.

Because the primary renderer saves layout on a normal 1s debounce after state changes, a transient resume failure can erase a valid saved agent pane from `layout.json`. This is broader than the missing-`sessionId` case: the pane had a restorable id, but a temporary failure during launch can make the next startup see only a shell.

The same caution applies to restored Codex panes while resume-time fork detection is pending. `session:resume` returns a new PTY immediately, then `session:detected` may later replace the old saved session id with the live fork id. If detection misses or races, the pane can keep saving the stale parent id while the live process is actually running a forked rollout.

### Claude detection is global FIFO only

`SessionSpawner` documents and implements a single global FIFO `pendingQueue` for Claude new-session detection. It no longer routes by cwd. `CLAUDE.md` has been updated to describe the current global FIFO behavior and to point back to this spec for the restore-correctness risk.

The current global FIFO can be wrong when:

- two Claude sessions are started close together and one writes its JSONL first out of order
- an external Claude Code process creates a JSONL while MultiAgent has a pending detection
- a launched shell falls back to a different cwd and the ordering assumption breaks

Wrong assignment means a pane can persist the wrong `sessionId`, causing the wrong transcript to resume on next startup.

### Codex has two competing detection mechanisms

`_watchForNewCodexSession(...)` both:

- pushes a pending entry into a global `codexPendingQueue` consumed by `ensureCodexWatcher(...)` on any new Codex JSONL add
- polls `CodexSessionScanner.scanAll()` for the newest session matching the requested cwd and `mtimeMs >= startedAt - 5000`

The polling path is cwd/time constrained. The watcher path is global FIFO and ignores cwd, start time, and whether the JSONL belongs to this app. If the watcher wins first with an unrelated file, it cleans up the pending entry and emits `session:detected` for the wrong Codex id. That wrong id can be saved and later resumed on startup.

Codex resume needs detection because interactive `codex resume` forks a new rollout id. That makes this path especially sensitive: a restored Codex pane may start from an old id, then save an unrelated fork id if detection races.

## Intended Behavior

- A fresh app launch must never preserve `detached: true` from the previous process. All saved tabs should start owned by the primary window unless detached windows are explicitly restored in the future.
- Primary-window shutdown must perform a final coherent layout save that includes the latest detached-window tab state, or main must own durable layout persistence for all windows.
- A pane should only be downgraded from agent to shell when the app can prove there is no restorable session, not merely because the last renderer save happened before detection completed.
- A resume failure must not permanently rewrite a saved restorable agent pane into a shell without a visible/user-actionable fallback.
- Session detection should be scoped strongly enough that unrelated Claude/Codex file writes cannot claim a MultiAgent pane.
- Codex resumed panes should persist the newly forked live id only after detection is tied to the actual spawned PTY/session, not to any recent file in the sessions directory.

## Implementation Phases

### Phase 1 - Normalize startup ownership

In `applyLayout`, strip `detached` from every saved tab during primary-window startup. Recompute `activeTabId` from non-empty restored tabs after normalization. If future detached-window restoration is desired, design it explicitly; do not infer live detached ownership from stale disk state.

Also clear any detached-window ownership maps in renderer state during primary `applyLayout`.

### Phase 2 - Make shutdown persistence coherent

Choose one durable-save owner:

- renderer-owned: intercept primary close, request/merge final detached states, save once, then allow shutdown
- main-owned: move layout persistence into main with an authoritative window/tab ownership model

The minimal fix should prevent the primary renderer from closing before detached tabs are either returned and saved or normalized as primary-owned in the saved layout.

### Phase 3 - Harden session id detection

Claude:

- If global FIFO remains after implementation, document why it is an accepted invariant; otherwise restore/constrain cwd-aware matching and update `CLAUDE.md` with the new rule.
- Prefer matching JSONL files by cwd plus creation/mtime window when possible.
- Do not let external file creation claim a pending pane.

Codex:

- Remove or constrain the global `ensureCodexWatcher` FIFO path so it cannot beat the cwd/time polling path with an unrelated file.
- Consider using only the polling/scanner path for Codex detection, or include cwd/start-time validation before shifting `codexPendingQueue`.
- Keep Codex resume detection, because interactive resume forks a new rollout id.

### Phase 4 - Avoid silent agent-to-shell loss

Add a pending/restoring state or retry path for restored agent panes missing `sessionId` when there is enough evidence that the pane was an agent session. Candidate strategies:

- persist a `sessionDetectionPending` marker for newly spawned agent panes until detection completes
- on startup, try `sessions:latest-for-cwd` for pending agent panes before downgrading
- persist an explicit `startedAt`/agent marker so the app can distinguish blank panes from detection misses

Do not blindly resume the latest session for every agent pane; that could open the wrong transcript.

### Phase 5 - Make resume failure non-destructive

Do not mutate a restored agent pane into a shell only because `session:resume` rejected. Instead:

- keep the saved `agentKind`, `sessionId`, and `cwd` in layout state
- mark the pane as `restoreFailed`/`needsManualResume` or similar, so the UI can show a retry/open-shell choice
- suppress layout saves that would erase the agent identity while the pane is in a transient restore-error state
- for Codex resumed panes, distinguish the persisted parent id from a detected live fork id until detection completes or times out visibly

Only permanently convert an agent pane to shell after an explicit user action or after validation proves the transcript/session id no longer exists.

## Risks

- Normalizing all `detached` flags on startup may surprise users who expected detached windows to reopen. That is still safer than orphaning tabs with no owning window.
- Cwd-based matching can fail when the requested cwd does not exist and the PTY falls back to the home directory. Any cwd matching needs a fallback that is explicit and testable.
- Codex rollout behavior may change across CLI versions. Keep the resume detection behavior verified against the installed interactive Codex CLI, not `codex exec resume`.
- Delaying shutdown to collect detached state can deadlock if a renderer is hung. Use timeouts and a fallback save that normalizes tabs back to primary ownership.
- Preserving failed restored agents without starting a shell may leave an inert pane. That is preferable to erasing a recoverable session id; make the retry/recover affordance clear.

## Verification Steps

1. Create a Claude tab, detach it, quit the app from the primary window, restart. The tab must be visible in the primary tab bar/sidebar and hydrate/resume correctly when focused.
2. Repeat with a Codex tab. Confirm the restored pane updates to the live forked Codex id and does not appear in Recent while open.
3. Detach a tab, move/focus panes inside the detached window, immediately close the primary window, restart. The latest detached tab state should not be lost.
4. Start two Claude sessions in quick succession from different directories. Confirm each pane receives the correct session id and resumes the correct transcript after restart.
5. Start or resume a Codex session while an external Codex process creates a JSONL. Confirm MultiAgent does not assign the external id to the pane.
6. Force a delayed/missed `session:detected` path and verify startup does not silently convert a genuinely restorable agent pane into a shell without an explicit fallback decision.
7. Force `session:resume` to reject for a saved Claude pane with a valid `sessionId`. Restart or wait for layout save; confirm the saved layout still preserves agent identity and offers retry/recovery instead of persisting a shell downgrade.
8. Repeat the resume-failure test for Codex, including the fork-id detection timeout path.
9. Run `npm run typecheck`.

## Handoff Contract

Non-negotiables:

- Fresh startup must not orphan tabs behind stale `detached: true` flags.
- Closing the primary window with detached tabs must not lose those tabs from the next launch.
- Do not reintroduce a startup restore prompt.
- Do not mutate user Claude/Codex config files.
- Do not remove Codex resume-time id re-detection unless interactive Codex resume is verified to stop forking new rollout ids.
- Wrong-session restore is worse than refusing to auto-resume; prefer a visible fallback over guessing.
- A transient resume or detection failure must not erase a previously saved `agentKind`/`sessionId`.

Definition of done:

- Saved layouts from old builds with `detached: true` restore into visible primary-owned tabs.
- New shutdown saves cannot persist orphaned detached ownership.
- Claude and Codex panes restore the intended sessions after restart under normal and quick-close scenarios.
- Detection cannot be claimed by unrelated external JSONL files in the common race cases above.
- Failed restored sessions remain recoverable and do not get saved over as shells without explicit user intent.
- Durable lessons are reflected in `CLAUDE.md` if implementation changes alter startup, detached-window, or session-detection invariants.
