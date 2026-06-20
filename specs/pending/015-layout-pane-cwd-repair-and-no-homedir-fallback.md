# 015 - Layout/Pane CWD Repair and No-Homedir Fallback

## Background

Spec 009 (moved-directory session repair) shipped a **session-centric** repair path:
severed sessions can be repaired from the Session Browser / sidebar, the fix is
committed atomically to `session-index.db` (with a `session_cwd_overrides` row so
the 5s scanner cannot undo it), and Claude transcript directories are copied/merged
into the new encoded-cwd directory. See `specs/done/009-moved-directory-session-repair.md`.

The broader layout-level design from 009 was intentionally **not** implemented. This
spec captures the deferred gaps so they are not lost.

## Problem

A moved project folder is only repaired at the session-index level. Two paths still
behave badly:

1. **`layout.json` pane/tab cwds are never rewritten.** `SessionIndex.repairCwd`
   touches only `session-index.db`. A `PaneLeaf.cwd`, `PaneLeaf.sessionDetectionCwd`,
   or `Tab.defaultCwd` saved in `layout.json` still points at the moved folder after a
   repair, so restored panes and tab defaults show / spawn from the stale path. There is
   no `layout.json.bak` written for this case.
2. **Agents still fall back to `homedir()` when their saved cwd is missing.** See
   `src/main/pty/PtyManager.ts:132`, `src/main/pty/ptyWorker.ts:44`, and
   `src/main/sessions/SessionSpawner.ts:64`. The Session Browser blocks this by disabling
   resume on severed sessions, but a **startup-restored agent pane** whose cwd moved can
   still silently spawn from home. This violates the 009 handoff non-negotiable
   *"Do not spawn agents from homedir() when their saved cwd is missing."*

Minor gaps also deferred from 009:

3. No dry-run preview count before commit (repair validates the new dir, then commits).
4. No project-fingerprint (`.git`, `package.json`) or basename-mismatch warning when the
   chosen replacement directory looks unrelated to the old one.

## Current Behavior

- `src/main/sessions/SessionIndex.ts` — `repairCwd(oldCwd, newCwd)` updates session rows
  + overrides only; no layout awareness.
- `src/main/ipc/handlers.ts` — `sessions:repair-cwd` validates the new dir exists and is a
  directory, then commits; no dry-run, no fingerprint check.
- `src/renderer/src/store/panes.ts` — `hydrateTabRuntime` validates the transcript exists
  (`sessions:validate`, line ~233) but does not check whether the pane's `cwd` exists, and
  resumes with the saved (possibly stale) cwd.
- `PtyManager.createDeferred` / `ptyWorker` / `SessionSpawner` substitute `homedir()` for a
  missing cwd.

## Intended Behavior

1. A directory repair updates **all** affected app-owned state in one operation:
   - matching `PaneLeaf.cwd`, `PaneLeaf.sessionDetectionCwd`, and `Tab.defaultCwd` in the
     in-memory renderer store **and** the on-disk `layout.json`;
   - `session-index.db` rows (already done in 009).
2. `layout.json` is backed up to `layout.json.bak.<timestamp>` before the rewrite.
3. Path replacement is **prefix-aware** (segment-boundary, case-insensitive on Windows,
   `path.resolve`/`normalize` first) — never a plain string replace. Reuse the rules from
   009's Repair Model so `C:\src\app` and `C:\src\app-old` do not collide.
4. Restored agent panes do **not** spawn from `homedir()` when their cwd is missing. Add a
   no-fallback agent spawn path that surfaces a recoverable `resumeError` instead. Shell
   panes may keep an explicit home fallback.
5. (Optional) Dry-run count of affected panes / tab defaults / session rows shown in the
   repair modal before commit; project-fingerprint / basename-mismatch warning.

## Implementation Notes

- A repair should probably broadcast the prefix mapping (old root → new root) so the
  renderer store and `layout.json` writer can both apply it, rather than re-deriving from
  session rows. Consider extending `sessions:repair-cwd` to also return/apply the mapping,
  or add a `directories:repair` IPC as 009 originally proposed.
- Multi-window: the primary store + the final shutdown-save path must both see the mapping;
  detached windows need the broadcast or inclusion in the same update (see 009 Risks).
- The no-fallback path is the one real behavioral fix; the layout rewrite is the
  correctness/UX fix. Items 3-4 are nice-to-have.

## Verification Steps

1. Create a Claude pane + Codex pane in a test repo, close app, move the repo, restart.
2. Confirm restored agent panes do **not** spawn in the home directory (they show a
   recoverable error instead).
3. Repair via the UI; confirm pane cwd, `Tab.defaultCwd`, Recent, and Session Browser all
   update, and that `layout.json` was rewritten (with a `.bak`).
4. Restart and confirm the layout repair persists.
5. Test the `C:\src\app` vs `C:\src\app-old` prefix-collision case.
6. `npm run typecheck`.

## Handoff Contract

Non-negotiables (carried over from 009):

- Prefix-aware, segment-boundary path replacement only; never plain string replace.
- Back up `layout.json` before rewrite; atomic commit.
- Do not spawn agents from `homedir()` when their saved cwd is missing.
- Do not rewrite transcript JSONL contents; do not reassign session IDs.

Definition of done:

- A directory repair updates `layout.json` pane/tab cwds (with backup) in addition to the
  session index.
- Startup-restored agent panes with a missing cwd remain visibly recoverable instead of
  spawning from home.
- The prefix-collision case is handled.
- `CLAUDE.md` updated if the no-homedir-fallback invariant changes agent spawn behavior.
