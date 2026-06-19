# Session Restore Remaining Issues

## Status

Abandoned in favor of `007-claude-session-id-at-launch.md` and
`008-codex-filesystem-session-matching.md`.

The remaining session-identification work was split into the focused Claude and Codex specs.
This audit is kept for historical context only.

This spec supersedes the original startup restore audit in this file. The audit is still related and useful, but several items have already been fixed in the current working tree:

- Saved tabs are normalized to `detached: false` during `layout:save` in `src/main/ipc/handlers.ts`.
- Saved tabs are normalized to `detached: false` during primary `applyLayout` in `src/renderer/src/store/panes.ts`.
- Primary startup clears stale `detachedWindowTabIds` and `detachedWindowActiveTabIds`.
- Codex no longer has a global FIFO filesystem watcher. Codex detection now uses the cwd/time-constrained scanner path in `src/main/sessions/SessionSpawner.ts`.
- Restored agent resume failures now preserve `agentKind` and `sessionId` and set `resumeError` instead of rewriting the pane to a shell.
- Claude detection now uses cwd/time-scored matching instead of a global FIFO queue.
- New agent panes persist pending detection state; startup tries exact cwd/time recovery before leaving a visible recovery placeholder.
- Codex detection timeout now emits renderer-visible failure state.

The detailed sections below include both completed audit items and open work. Headings marked `Implemented` are kept for context and manual verification, not as the next implementation target.

## Next Developer Handoff

All implementation items are complete. Manual verification remains:

- Claude/Codex race scenarios from sections 1, 2, and 4.
- Detached window shutdown scenarios for section 3.
- Deleted/moved transcript scenarios for section 5.

Already implemented in this working tree:

- Claude session detection no longer uses FIFO; it uses cwd/time-scored matching in `src/main/sessions/SessionSpawner.ts`.
- New agent panes persist `sessionDetectionState`, `sessionDetectionStartedAt`, and `sessionDetectionCwd`; startup uses `sessions:recover-pending` for exact single-match recovery.
- Codex new/resume detection emits `session:detection-failed` on timeout and the renderer preserves existing session identity.
- `layout:save` and `applyLayout` normalize saved tabs to `detached: false`.
- Primary shutdown collects fresh state from all detached windows before writing `layout.json` (Issue 3).
- `sessions:validate` is called before `session:resume` at startup; missing transcripts produce recoverable UI instead of a doomed CLI spawn (Issue 5).
- `npm run typecheck` passed after all changes.

## Goals

Startup resume should be boring and deterministic:

- The workspace should reopen with the same visible tabs and pane layout the user last saw.
- Existing Claude and Codex sessions should resume in the pane they belonged to.
- External Claude/Codex processes must not be able to claim a MultiAgent pane.
- A transient detection, resume, or shutdown race must not permanently erase recoverable session identity.
- Wrong-session restore is worse than refusing to auto-resume. Prefer a visible fallback over guessing.

## Current Restore Flow

Primary startup:

1. `src/renderer/src/App.tsx` calls `window:get-init-data`.
2. If the window is primary, it calls `layout:load`.
3. `usePanesStore.applyLayout(...)` sanitizes pane runtime data, strips PTY IDs, normalizes `detached: false`, clears stale detached ownership maps, and hydrates only the active tab.
4. `hydrateTabRuntime(...)` calls `session:resume` for restored agent leaves that have `agentKind`, `sessionId`, and no `ptyId`.
5. Inactive restored tabs defer runtime creation until activation.

New agent session flow:

1. Renderer creates an agent leaf immediately.
2. Renderer invokes `session:new`.
3. Main spawns the agent PTY and returns `{ ptyId, sessionId: null }`.
4. Main later emits `session:detected` after associating a newly written transcript with the PTY.
5. Renderer finds the pane by `ptyId` and writes `sessionId` into layout state.

Resume flow:

1. Renderer invokes `session:resume`.
2. Main spawns the agent with the resume command and routes the new PTY.
3. Claude keeps the saved session id.
4. Codex can fork to a new rollout id, so main still watches for a new Codex transcript and emits `session:detected` when it finds a cwd/time match.

Detached window flow:

1. Detached renderers do not write `layout.json`.
2. Detached renderers debounce `tab:state-sync` to the primary renderer.
3. The primary renderer merges that synced state into its in-memory tab list.
4. The primary renderer debounces `layout:save`.
5. Main owns PTY routing and in-memory tab ownership maps through `WindowManager`.

## Implemented Issue 1: Claude Session Detection Was Global FIFO

### Current Status

Implemented. `SessionSpawner` now batches new Claude JSONL files briefly and only assigns a file to a pending pane when there is a single active candidate with matching normalized cwd and file `mtimeMs >= startedAt - 5000`. Ambiguous candidates are ignored instead of assigned by queue order.

The original problem statement is retained below for verification context.

### Why This Mattered

Claude session detection used to assume that the next new Claude JSONL belonged to the oldest pending MultiAgent pane. The relevant old code was in `src/main/sessions/SessionSpawner.ts`:

- `pendingQueue` stores pending Claude detections.
- `ensureSharedWatcher(...)` watches `~/.claude/projects`.
- On any new `.jsonl`, `readSessionInfo(...)` parses the file.
- The watcher does `pendingQueue.shift()` and emits `session:detected` for that pane.

That can put the wrong session id into the wrong pane. Once saved, startup can faithfully resume the wrong conversation, which looks like duplication or pane mix-up.

### Failure Cases

- User starts two Claude panes close together. Claude writes JSONL files in a different order than MultiAgent spawned panes.
- An external Claude Code process creates a JSONL while MultiAgent has a pending detection.
- A requested cwd does not exist or the launched process falls back to a different cwd, breaking any implicit ordering expectation.
- A restored or newly spawned pane exits quickly, but an unrelated JSONL arrives before cleanup runs.

### Current Constraints

- `readSessionInfo(...)` scans only the first 10 lines because `sessionId` and `cwd` may appear on different JSONL records.
- A previous cwd-only approach was considered fragile when the requested cwd did not match Claude's actual cwd.
- Chokidar v5 is ESM-only, so it must stay dynamically imported if used.
- The app must not mutate user Claude config files.

### Workable Implementation Plan

Implement scored matching instead of FIFO-only matching.

Add richer pending metadata:

- `ptyId`
- target window
- requested cwd
- normalized requested cwd
- `startedAt`
- maybe `agentKind`
- cleanup function

When a Claude JSONL is added:

1. Parse `sessionId`, `cwd`, and file stat times.
2. Build candidate pending detections that are still active.
3. Score candidates:
   - exact normalized cwd match: strong positive
   - file `mtimeMs >= startedAt - graceWindow`: required unless explicitly falling back
   - closest `startedAt` before file mtime: positive
   - already assigned session id: reject
4. If there is one strong match, assign it.
5. If there are multiple plausible matches, do not assign by FIFO unless the ambiguity is explicitly accepted and logged.
6. If there is no match, ignore the file.

Suggested constants:

- `SESSION_DETECTION_GRACE_MS = 5_000`
- `SESSION_DETECTION_TIMEOUT_MS = 60_000`
- Consider a short delayed batch window, for example 300-500ms, so multiple file events can be matched together rather than greedily.

Important: if cwd matching fails because the actual cwd differs, prefer leaving the pane without a detected session and surfacing recovery over assigning a likely-wrong session.

### Alternative Plan

Use CLI output if Claude prints a reliable session id or transcript path. This would be better than filesystem inference, but only if verified against the installed Claude Code behavior on Windows and macOS/Linux.

### Acceptance Criteria

- Starting two Claude panes quickly from different directories assigns each pane the correct `sessionId`.
- An external Claude process writing a JSONL during detection does not claim any MultiAgent pane.
- If matching is ambiguous, no wrong `sessionId` is saved.
- Detection cleanup still runs on PTY exit and timeout.
- `CLAUDE.md` is updated with the new matching rule.

### Verification

1. Start two Claude sessions in different cwd values within one second.
2. Start an external Claude process while one MultiAgent Claude pane is pending detection.
3. Force one pending Claude PTY to exit before detection.
4. Restart the app and confirm each pane resumes the intended transcript.
5. Run `npm run typecheck`.

## Implemented Issue 2: Agent Panes Without Session IDs Were Downgraded On Startup

### Current Status

Implemented. New agent panes now save explicit pending detection state. Startup recovery attempts an exact single `agentKind + cwd + startedAt` transcript match through `sessions:recover-pending`; if recovery is ambiguous or missing, the pane stays an agent recovery placeholder with visible error state instead of silently becoming a shell. Legacy panes with no pending marker still use the conservative shell downgrade.

The original problem statement is retained below for verification context.

### Why This Mattered

New agent panes are created before session detection completes. The renderer can save a layout that contains:

- `paneType: 'agent'`
- `agentKind: 'claude'` or `'codex'`
- `ptyId`
- no `sessionId`

On the next startup, `applyLayout` strips runtime `ptyId`. If there is no `sessionId`, it converts that pane to a shell because there is no safe session to resume.

That behavior is conservative, but it loses recoverable intent. If the app was closed before `session:detected` arrived or before the debounced layout save captured it, the user sees an agent pane come back as a shell.

### Current Code Paths

- `session:new` returns `sessionId: null`.
- `session:detected` updates the matching pane by `ptyId`.
- `applyLayout` treats restored agent leaves without `sessionId` as unresumable.
- `sessions:latest-for-cwd` exists in `src/main/ipc/handlers.ts`, but blindly using it on startup would risk opening the wrong transcript.

### Workable Implementation Plan

Persist explicit detection state so startup can distinguish a truly blank/unusable agent pane from a pane whose session id was still pending.

Extend `PaneLeaf` with fields similar to:

- `sessionDetectionState?: 'pending' | 'detected' | 'failed'`
- `sessionDetectionStartedAt?: number`
- `sessionDetectionCwd?: string`
- `sessionDetectionPtyId?: string` is not useful across restarts, but can help during the current run if not persisted as authoritative.

When creating a new agent pane:

1. Set `sessionDetectionState: 'pending'`.
2. Set `sessionDetectionStartedAt` from the renderer or from the `session:new` result.
3. Save this state in layout.

When `session:detected` arrives:

1. Set `sessionId`.
2. Set `sessionDetectionState: 'detected'`.
3. Clear stale detection error fields.

On detection timeout:

1. Main should emit an explicit detection failure event, or renderer should infer timeout.
2. Set `sessionDetectionState: 'failed'`.
3. Preserve `agentKind`, cwd, and user-visible recovery state.

On startup for an agent pane with no `sessionId`:

1. If there is no pending marker, keep the current conservative downgrade or show a non-restorable agent placeholder.
2. If there is a pending marker, do not immediately convert to shell.
3. Try a constrained recovery lookup:
   - same `agentKind`
   - same normalized cwd
   - transcript `mtimeMs >= sessionDetectionStartedAt - graceWindow`
   - ideally transcript was created before app shutdown if that timestamp is persisted
4. If exactly one candidate matches, restore that `sessionId`.
5. If zero or multiple candidates match, preserve the pane as an agent recovery placeholder with a retry/open-shell choice.

Avoid a simple "latest for cwd" fallback. It can choose the wrong session if the user or another process created a newer session in the same directory.

### UI Considerations

The terminal component already displays `resumeError` for failed restored agents. Reuse that pattern for detection recovery:

- "Session detection did not finish before shutdown."
- Actions: retry detection lookup, open shell in cwd, discard agent identity.

Do not silently mutate to shell until the user chooses a destructive fallback.

### Acceptance Criteria

- Closing the app shortly after starting Claude/Codex does not silently convert the pane to shell on restart.
- If exactly one matching transcript exists, startup recovers the `sessionId`.
- If matching is ambiguous, the pane remains recoverable and does not guess.
- Layout saves preserve the pending/failed state.

### Verification

1. Start a Claude pane and quit immediately before `session:detected`.
2. Restart and confirm the pane is either recovered or visibly marked as pending recovery, not silently converted.
3. Repeat with Codex.
4. Create two possible same-cwd sessions and confirm startup does not guess.
5. Run `npm run typecheck`.

## Implemented Issue 3: Primary Shutdown Now Merges Detached Window State

### Current Status

Implemented. On primary window `close`, main intercepts the event (preventing default once via
`isShutdownSaveComplete` flag), sends `layout:request-state` to the primary renderer and
`layout:collect-detached-state` to each detached window, waits up to 1000ms for responses,
merges fresh detached snapshots over the primary's potentially-stale copy, and writes a final
`layout.json` before allowing the close. A hung detached renderer is handled by the per-window
timeout; if the primary does not respond, the function returns without overwriting whatever was
last saved by the debounce. The new IPC channels use a per-request `requestId` to prevent
stale/concurrent collision.

The original problem statement and implementation details are retained below for verification context.

## Original Issue 3: Primary Shutdown Still Does Not Authoritatively Merge Detached Window State

### Why This Matters

The current cold-start orphan bug is reduced because saved tabs are normalized to primary ownership. However, shutdown can still lose the latest detached-window state.

Detached windows do not save layout. They send debounced state to the primary renderer. If the primary window closes before the latest detached sync is sent, received, merged, and saved, `layout.json` can contain stale pane order, focused pane ids, or missing recently moved panes.

Normalizing `detached: false` ensures stale detached tabs are visible on next startup, but it does not guarantee the saved tab tree is the most recent detached-window tree.

### Current Code Paths

- `App.tsx` detached sync debounce: 300ms.
- `App.tsx` primary layout save debounce: 1000ms.
- `mainWindow.on('closed')` closes remaining windows.
- `WindowManager.unregister(...)` can send `tab:return` to the primary, but primary may already be closed.
- `layout:save` writes whatever the primary renderer last sent.

### Workable Implementation Plan A: Renderer-Owned Final Save

Intercept primary close before the renderer is destroyed.

1. In main, on primary `close`, prevent default once.
2. Ask all detached windows for immediate tab snapshots.
3. Wait for replies with a short timeout, for example 750-1500ms.
4. Send the snapshots to the primary renderer or merge in main.
5. Save one final normalized layout.
6. Continue closing all windows.

This needs new IPC:

- `layout:collect-detached-state`
- `layout:detached-state-response`
- `layout:save-final` or reuse `layout:save`

Make the protocol tolerant:

- If a detached renderer is hung, timeout and save the best known primary state.
- If a detached window has already closed, use `WindowManager`'s last known tab ids only as ownership metadata, not as full tab state.

### Workable Implementation Plan B: Main-Owned Layout Authority

Move durable layout persistence to main.

Main would track:

- latest tab tree for each window
- primary tab list
- active tab per window
- sidebar state from primary
- tab ownership

Then `layout:save` becomes an update to main's authoritative state, and main writes `layout.json`. This is cleaner long-term but larger in scope.

### Recommended First Step

Implement Plan A first. It is smaller and directly targets shutdown loss.

### Acceptance Criteria

- Changes made in a detached window immediately before closing the primary are present after restart.
- Focused pane id in a detached tab survives primary shutdown.
- Pane moves inside a detached tab survive primary shutdown.
- A hung detached renderer does not block app close indefinitely.
- Saved layout still normalizes every tab to `detached: false`.

### Verification

1. Detach a tab, split/move/focus panes, immediately close the primary window, restart.
2. Repeat with multiple detached windows.
3. Close a detached window during shutdown collection.
4. Simulate no response from a detached window and confirm timeout fallback.
5. Run `npm run typecheck`.

## Implemented Issue 4: Codex Resume Fork Detection Had No Visible Timeout Semantics

### Current Status

Implemented. `_watchForNewCodexSession(...)` emits `session:detection-failed` on timeout with mode `new` or `resume`. Renderer state records `sessionDetectionError`; resume-mode failures keep the existing saved `sessionId` rather than erasing identity.

The original problem statement is retained below for verification context.

### Why This Mattered

Codex detection is safer now because it only accepts cwd/time-constrained scanner matches. But Codex resume can fork to a new rollout id. If detection misses the fork, the pane can keep the old saved `sessionId` while the live process is actually writing to a new session.

That can cause future startup to resume the parent session instead of the latest live fork, or make Recent/session status look wrong.

### Current Code Paths

- `spawnResume('codex', ...)` starts `codex resume ...`.
- `_watchForNewCodexSession(...)` scans all Codex sessions every second.
- It accepts the newest session with matching cwd and `mtimeMs >= startedAt - 5000`.
- On timeout, cleanup runs silently after 60 seconds.
- Renderer only knows about success through `session:detected`; it does not know that fork detection timed out.

### Workable Implementation Plan

Add explicit detection status for Codex resume.

Main should emit a detection failure event when `_watchForNewCodexSession(...)` times out:

- channel: `session:detection-failed`
- payload: `ptyId`, `agentKind`, reason, maybe `mode: 'new' | 'resume'`

Renderer should update the matching pane:

- keep old `sessionId`
- set a non-destructive warning such as `sessionDetectionError`
- do not overwrite with any later unrelated session

If Codex output exposes the actual rollout id or file path, prefer that over scanner inference in a later phase.

### Acceptance Criteria

- Successful Codex resume still updates the pane to the live fork id.
- If no fork id is detected within timeout, the pane shows a warning instead of silently pretending the saved id is definitely current.
- The warning does not erase the existing saved session id.
- External Codex JSONL writes still cannot claim the pane.

### Verification

1. Resume a Codex session and confirm `session:detected` updates to the live fork id.
2. Force `_watchForNewCodexSession` timeout and confirm the pane shows a recoverable warning.
3. Start an external Codex process during resume and confirm it does not claim the pane.
4. Restart and confirm no wrong session id was persisted.
5. Run `npm run typecheck`.

## Implemented Issue 5: Session Identity Is Validated Before Resume

### Current Status

Implemented. `hydrateTabRuntime` in `src/renderer/src/store/panes.ts` now calls
`sessions:validate(agentKind, sessionId, cwd)` before `session:resume`. If the transcript is not
found, the pane is updated with a `resumeError` message and no CLI process is spawned. If found
(even with a cwd mismatch), resume proceeds normally — Claude/Codex use the session ID as the
primary key, so the saved cwd is still used for the pane's context. The handler in
`src/main/ipc/handlers.ts` scans the relevant transcript directory for the exact `agentKind +
sessionId` combination and returns `{ found, cwdMatch, transcriptPath, transcriptCwd }`.

The original problem statement is retained below for verification context.

## Original Issue 5: Session Identity Is Not Validated Before Resume

### Why This Matters

When a restored pane has `agentKind` and `sessionId`, `hydrateTabRuntime(...)` calls `session:resume` directly. If the transcript was deleted, moved, malformed, or belongs to another cwd, the resume command may fail or resume something surprising depending on CLI behavior.

Resume failures are now non-destructive, which is good. But the app can be more deliberate before launching a CLI process.

### Workable Implementation Plan

Add a validation IPC before resume or inside `session:resume`:

- `sessions:validate(agentKind, sessionId, cwd)`
- returns found/missing, transcript path, transcript cwd, and maybe last activity

Before `session:resume`:

1. Scan/index for the exact `agentKind + sessionId`.
2. If missing, do not launch. Mark pane as recoverable missing session.
3. If cwd differs, show a warning or resume using transcript cwd only if that is the intended product behavior.
4. If valid, launch as today.

This is especially useful for startup hydration because it avoids spawning failing processes for known-missing sessions.

### Acceptance Criteria

- Deleted transcript does not cause repeated startup spawn failures.
- Cwd mismatch is visible and not silently ignored.
- Valid sessions resume as before.
- Recovery UI preserves the original session id.

## Cross-Cutting Data Model Suggestions

Consider extending `PaneLeaf` with explicit recovery fields rather than overloading `resumeError`:

```ts
sessionDetectionState?: 'pending' | 'detected' | 'failed'
sessionDetectionStartedAt?: number
sessionDetectionError?: string
restoreState?: 'idle' | 'resuming' | 'failed' | 'missing'
restoreError?: string
```

Keep the fields optional so old saved layouts migrate naturally.

Do not persist PTY IDs as meaningful restore identity. PTY IDs are runtime-only.

## Implementation Order

Recommended remaining order:

1. Add final detached shutdown save. This addresses latest layout loss from detached windows.
2. Add pre-resume session validation. This improves startup reliability and error quality.
3. Run the manual race/restart verification for implemented detection changes.

If the user reports "detached tab changes disappear after quit", prioritize issue 3.
If the user reports repeated startup resume failures or deleted-session loops, prioritize issue 5.

## Non-Negotiables

- Do not reintroduce a startup restore prompt.
- Do not mutate `~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`, or other user/project agent config files.
- Do not assign a session id when matching is ambiguous.
- Do not remove Codex resume-time id re-detection unless interactive Codex resume is verified to stop forking rollout ids.
- Do not persist runtime PTY IDs as durable identity.
- A transient failure must not erase a saved `agentKind`/`sessionId` without explicit user action.

## Definition Of Done

- Claude and Codex panes restore the intended sessions after restart under normal, quick-close, and external-process race cases.
- Newly started panes cannot be silently downgraded to shells when detection was merely late.
- Detached-window state immediately before app shutdown is preserved or deliberately falls back with a logged timeout.
- Codex resume fork detection success and failure are both represented in renderer state.
- Missing/deleted sessions produce recoverable UI instead of repeated destructive mutation.
- `CLAUDE.md` documents any changed invariants.
- `npm run typecheck` passes.
