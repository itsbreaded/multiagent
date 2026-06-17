# 003 — Codex resume session detection

## Problem

Open Codex sessions leak into the sidebar **Recent** list while they are still open. Claude sessions do not. An open session should never appear in Recent; it should only reappear there once closed.

## Root cause

The Recent list is filtered entirely in the renderer. `SessionIndex` always reports every indexed session as `resumable` (it never marks anything live). `useSessions` (`src/renderer/src/hooks/useSessions.ts`) builds `liveIds` from the `agentKind:sessionId` of every open agent pane and excludes from `resumable` any indexed session whose key is in `liveIds`. So an open session is hidden from Recent **only if its pane's `sessionId` exactly matches the indexed session id.**

That match holds for Claude but breaks for Codex:

- **Claude** `claude --resume <id>` appends to the same JSONL under the same `sessionId`. The pane keeps a valid id, so it matches the index and is filtered out — even though `spawnResume` sets up no detection watcher.
- **Codex** interactive `codex resume <id>` (what the app runs, `SessionSpawner.ts:269`) **forks a brand-new rollout file with a new session id**, replaying prior history. Verified empirically against `~/.codex/sessions`: clusters of rollout files created seconds apart share an identical first user message (one prompt heads 52 separate files, another 18). Note `codex exec resume` (non-interactive) *appends* instead — do not use it as a behavioral reference for the interactive path.

When a Codex session is resumed:

1. Renderer sets `pane.sessionId = OLD id` (`panes.ts:1001`; on startup hydration `panes.ts:198`).
2. `session:resume` → `SessionSpawner.spawnResume` (`SessionSpawner.ts:109-113`) spawns codex and **sets up no detection watcher** — it returns only `ptyId`.
3. Codex writes a new rollout file with a NEW id (the actually-live session).
4. The 5s poller indexes that new id as `resumable`. It is not in `liveIds` (the pane still holds OLD) → it shows in Recent while open.
5. The OLD id *is* in `liveIds`, so the original correctly disappears — but the live fork takes its place in Recent under the new id.

### Current behavior

- New Codex sessions: correct. `spawnNew` → `_watchForNewCodexSession` (`SessionSpawner.ts:150-200`) polls by cwd+mtime and fires `session:detected`, so the pane gets the right id.
- Resumed Codex sessions (including every restored pane on startup, `panes.ts:198`): the pane keeps the stale resumed-from id; the live forked session appears in Recent. Every resume also leaves another orphaned rollout file, polluting Recent with near-duplicate sessions.

### Intended behavior

After resuming a Codex session, the pane's `sessionId` is updated to the id of the forked rollout file that Codex actually created, so `liveIds` tracks the live session and it is filtered out of Recent — matching Claude.

## Implementation phases

### Phase 1 — Re-detect the forked id on Codex resume
- In `SessionSpawner.spawnResume`, when `agentKind === 'codex'`, start the same forked-session detection used by `spawnNew`. Reuse `_watchForNewCodexSession` (cwd + `mtimeMs >= startedAt - 5_000`, newest wins) so the watcher catches the newly created rollout file and fires `session:detected(ptyId, 'codex', newId)`.
- Capture `startedAt` before issuing the resume command so the mtime window is correct.
- Claude resume must stay watcher-free — its id is stable; adding a watcher there would risk mis-detecting an unrelated new JSONL.

### Phase 2 — Renderer updates pane id from `session:detected` on resume
- Confirm the existing `session:detected` handler (`panes.ts:1439`) updates the matched pane's `sessionId` for resumed panes, not just freshly-spawned ones. The pane is matched by `ptyId`, which is set after resume via `setPtyId`, so verify there is no ordering gap where `session:detected` arrives before the pane has its `ptyId`. If a race exists, buffer/retry the id assignment.
- Once the pane id flips to the fork id, `liveIds` updates and Recent filtering corrects itself with no further change to `useSessions`.

### Phase 3 — Verify startup hydration path
- Restored Codex panes resume via `panes.ts:198` and must benefit from the same re-detection so they do not reappear in Recent after restart.

## Risks

- **Wrong-id match.** Multiple Codex sessions in the same cwd are common in this repo; the cwd+mtime+newest heuristic could pick a different recently-touched rollout. Mitigate by constraining the mtime window to after the resume command was issued and preferring the newest match, as `spawnNew` already does.
- **Detection race on resume.** `session:detected` could fire before the pane has its `ptyId`. Verify ordering; the renderer matches the pane by `ptyId`.
- **Claude regression.** Do not attach the watcher to Claude resume.
- **Orphaned fork files.** This spec does not clean up the accumulated duplicate rollout files; it only fixes live-session tracking. Cleanup is out of scope.

## Verification steps

1. Resume a Codex session from Recent. While it is open, confirm it does **not** appear in Recent (no entry under either the old or the new id).
2. Close that Codex pane. Confirm the session reappears in Recent (under the fork id Codex actually wrote).
3. Restart the app with a restored Codex pane (lazy hydration). After hydration, confirm the restored session is absent from Recent while open.
4. Repeat 1–3 for Claude and confirm no regression (Claude resume continues to append to the same id and stays out of Recent while open).
5. Start a brand-new Codex session and confirm it is still correctly absent from Recent while open.

## Handoff contract

**Non-negotiables**
- Do not write to user/project agent config files. Detection must stay process-scoped and filesystem-read-only (consistent with existing `_watchForNewCodexSession`).
- Do not attach resume-time new-session detection to Claude.
- Backend continues to report all sessions as `resumable`; liveness stays a renderer-side derivation from open panes.

**Definition of done**
- Open Codex sessions (newly spawned, resumed, and startup-hydrated) never appear in Recent.
- Closed Codex sessions appear in Recent under the id of the rollout file Codex actually wrote.
- Claude behavior unchanged; verification steps 1–5 pass.
