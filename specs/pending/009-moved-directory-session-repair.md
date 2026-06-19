# 009 - Moved Directory Session Repair

## Problem

Saved panes and indexed Claude/Codex sessions store absolute `cwd` values. If a project folder is renamed, moved, or restored at a new path, startup can still show the old panes, but runtime behavior is degraded:

- `PtyManager.createDeferred(...)` falls back to `os.homedir()` when the saved cwd no longer exists.
- `hydrateTabRuntime(...)` validates sessions by exact `agentKind + sessionId`, but cwd mismatch is only returned as metadata today; the restored agent can launch from the stale path.
- Recent/session browser entries keep showing the old cwd until the underlying agent transcript is rewritten or a new transcript is created.
- A moved project can look like a deleted project even though the transcript and layout identity are still recoverable.

The user should be able to say "this old directory now lives here" and have all affected conversations for that project repaired safely. When the old cwd is gone, repair should be project-level; restoring one session at a time is the wrong model.

## External References

- Electron supports native directory selection through `dialog.showOpenDialog` with `properties: ['openDirectory']`, which matches the app's existing `dialog:pick-directory` IPC. Source: https://electronjs.org/docs/latest/api/dialog
- Electron's durable app state belongs under `app.getPath('userData')`; this app already keeps `layout.json` and `session-index.db` there. Source: https://electronjs.org/docs/latest/api/app
- VS Code's workspace model is a useful precedent: folders are durable workspace roots, and moved roots require an explicit path update rather than implicit guessing. Source: https://code.visualstudio.com/docs/editing/workspaces/workspaces

## Current Behavior

Durable locations:

- `layout.json` contains `Tab[]`; each `PaneLeaf.cwd` and `Tab.defaultCwd` may point at the moved folder.
- `session-index.db` stores `sessions.cwd`, `projectName`, and `filePath`.
- Claude and Codex transcript JSONL files also contain cwd metadata parsed by `TranscriptScanner` and `CodexSessionScanner`.

Relevant code paths:

- `src/main/ipc/handlers.ts` exposes `dialog:pick-directory`, `layout:load`, `layout:save`, `sessions:validate`, and `sessions:recover-pending`.
- `src/renderer/src/store/panes.ts` applies layout, validates restored sessions, resumes agents, starts shells, and updates pane cwd from OSC 7.
- `src/main/pty/PtyManager.ts` silently substitutes `homedir()` when the requested cwd does not exist.
- `src/main/sessions/SessionIndex.ts` upserts scanner output and overwrites `cwd` with whatever the transcript currently says.

## Intended Behavior

When startup or resume sees a missing saved cwd, the app should present a recoverable path-repair flow:

1. Detect missing cwd values in restored layout and visible session rows.
2. Group missing paths by original root, for example `C:\old\repo`.
3. Prompt the user to locate the replacement directory through the existing native directory picker.
4. Preview the repair scope: number of panes, tab defaults, and session records affected.
5. Apply the mapping atomically to app-owned state and any agent-owned directory structure needed for resume.
6. Validate the selected directory before resuming or spawning anything from it.

After repair, the same conversations should resume from the new directory, and Recent/session browser should display the new cwd.

## Repair Model

Use explicit old-root to new-root mappings:

```ts
interface DirectoryRepairMapping {
  id: string
  oldRoot: string
  newRoot: string
  createdAt: number
  appliedAt?: number
}
```

Path replacement should be prefix-aware:

- Normalize both paths with `path.resolve`/`path.normalize`.
- On Windows, compare case-insensitively.
- Only replace exact root matches or descendant paths on a segment boundary.
- Preserve relative suffixes: `C:\old\repo\subdir` maps to `D:\new\repo\subdir`.
- Never run a plain string replace across arbitrary path text.

Persist accepted mappings in an app-owned file such as `directory-repairs.json` under `app.getPath('userData')`. This lets future transcript rescans reapply known mappings without prompting again.

## Implementation Phases

### Phase 1 - Missing CWD Detection

Add main-process helpers:

- `path:exists(path): boolean` or a richer `directories:audit-missing` IPC.
- A pure utility to collect cwd values from tabs:
  - every `PaneLeaf.cwd`
  - every `PaneLeaf.sessionDetectionCwd`
  - every `Tab.defaultCwd`
- A session audit that groups `SessionIndex.getAll()` rows whose cwd no longer exists.

Renderer startup should not spawn PTYs for panes with missing cwd until repair is handled or skipped. This likely means `applyLayout(...)` marks affected leaves with a recovery field, then hydration skips those leaves.

### Phase 2 - User Repair UI

Create a small modal using the existing overlay language from `CLAUDE.md`.

Required actions:

- `Locate folder`: calls `dialog:pick-directory('Locate moved folder', bestExistingParent(oldRoot))`.
- `Apply`: runs a dry-run then commit.
- `Skip`: leaves affected panes/session rows in recoverable state and does not spawn from `homedir()`.
- `Open shell at home` can be offered per pane only as an explicit fallback.

The selected replacement must pass validation:

- Directory exists.
- If the old path basename was `repo`, the new path does not have to share the basename, but show a warning if it differs.
- Prefer checking for project fingerprints when available:
  - `.git` directory or `git rev-parse --show-toplevel`
  - package files such as `package.json`
  - optional future `projectFingerprint` captured before move

Do not block all startup on a modal if multiple unrelated missing directories exist. Show the restored UI with affected panes marked, then prompt for the active/visible missing root first.

### Phase 3 - Atomic App-State Update

Add a main IPC such as:

```ts
'directories:repair': (
  mappings: DirectoryRepairMapping[],
  options?: { dryRun?: boolean }
) => {
  updatedLayoutPaths: number
  updatedSessionRows: number
  affectedSessionIds: Array<{ agentKind: AgentKind; sessionId: string }>
}
```

Commit behavior:

- Read latest `layout.json` from disk.
- Rewrite matching cwd fields in all tabs.
- Backup `layout.json` to `layout.json.bak.<timestamp>` before write.
- Update in-memory renderer store by applying the same mapping to current `tabs`; avoid waiting for the debounce to rediscover it.
- Update `session-index.db` rows in a transaction:
  - `cwd`
  - derived `projectName`
  - for Codex, leave `filePath` unchanged because rollout files are globally resumable by id.
  - for Claude, update `filePath` to the copied/merged transcript file under the repaired encoded cwd directory.
- Persist the mapping after commit succeeds.

Because the scanner can later upsert old cwd values from transcripts, `SessionIndex.upsert(...)` should apply known directory mappings before writing rows. That preserves repaired cwd display without mutating user transcript files.

### Phase 4 - Claude Project Directory Copy/Merge

Claude Code is directory-scoped through `~/.claude/projects/<encoded-cwd>/`. Repairing a missing Claude cwd should copy/merge the entire old encoded project transcript directory into the new encoded project transcript directory.

Merge rules:

- Copy all regular files from old encoded cwd directory to new encoded cwd directory.
- If the target directory already exists, merge into it instead of renaming over it.
- If a target file already exists:
  - skip when the existing target appears identical enough for the current implementation, for example same byte size.
  - otherwise back up the existing target with a timestamp suffix before copying the old file over.
- Do not rewrite whole JSONL transcripts during normal repair.
- Keep the old Claude project directory intact unless a later explicit cleanup command is added.

This is intentionally copy/merge rather than rename because the target encoded cwd directory may already contain sessions.

### Phase 5 - Resume Semantics

Change startup hydration and manual resume behavior:

- If `sessions:validate(...)` finds a transcript but `cwdMatch === false`, check known directory mappings.
- If the transcript cwd maps to the pane cwd, treat it as valid and resume from the repaired pane cwd.
- If no mapping explains the mismatch, show a recoverable warning instead of silently resuming from a stale or missing path.
- `session:resume` and `session:new` should reject missing cwd with a structured error; only shell panes may offer explicit fallback to home.

This preserves the invariant that wrong-session restore is worse than refusing to auto-resume.

### Phase 6 - Optional Transcript Metadata Repair

Default behavior should not rewrite Claude/Codex transcript JSONL contents. They are external agent-owned data and may be large.

If transcript mutation is ever added, it must be a separate explicit command with:

- preview of exact files and fields to modify
- timestamped backups
- JSONL parser/serializer, not regex replace
- no changes to message content

This is out of scope for the first implementation.

## Risks

- Wrong root selection could make many conversations point at an unrelated project. Mitigate with dry-run preview, path-boundary replacement, and project fingerprint warnings.
- Scanner upserts can undo repaired cwd values unless mappings are applied before `SessionIndex.upsert(...)`.
- Layout state can be dirty in multiple windows. Repair should update the primary store and use existing final shutdown save behavior; detached windows need a broadcast or must be included in the same mapping update.
- Existing `PtyManager` fallback to home hides missing-directory bugs. The repair feature should add a no-fallback agent path before changing shell behavior.
- Case-only renames on Windows need normalized comparison but should preserve the user's chosen display casing.

## Verification Steps

1. Create a Claude pane and Codex pane in a test repo, close the app, move the repo, restart.
2. Confirm affected panes do not spawn in the home directory.
3. Use the repair UI to point the old root to the new root.
4. Confirm pane cwd, tab default cwd, Recent cwd, and Session Browser cwd update.
5. Resume Claude and Codex sessions and confirm they launch from the new directory.
6. Restart again and confirm the repair persists after transcript rescans.
7. Test two missing roots and confirm repairing one does not alter the other.
8. Test an old path prefix collision, such as `C:\src\app` and `C:\src\app-old`, and confirm only segment-boundary matches are changed.
9. Run `npm run typecheck`.

## Handoff Contract

Non-negotiables:

- Do not rewrite transcript JSONL contents in the first implementation.
- Claude project repair may copy/merge transcript files at the directory level because Claude resume is directory-scoped.
- Do not silently map missing paths based only on basename.
- Do not spawn agents from `homedir()` when their saved cwd is missing.
- Do not assign or rewrite session IDs as part of directory repair.
- All multi-path updates must have a dry-run count and an atomic commit path with backup for `layout.json` and a SQLite transaction for `session-index.db`.

Definition of done:

- A moved project directory can be repaired through a user-selected replacement directory.
- Existing panes and Recent/session browser entries show the repaired cwd.
- Claude and Codex conversations resume from the repaired cwd.
- Known mappings survive restart and scanner refresh.
- Ambiguous or skipped repairs remain visibly recoverable without destructive mutation.
- `CLAUDE.md` documents the new missing-cwd invariant after implementation.
