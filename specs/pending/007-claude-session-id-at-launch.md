# 007 — Claude: Assign Session ID at Launch (eliminate detection)

> Companion to `008-codex-filesystem-session-matching.md`. Claude and Codex are split because
> Claude can be told its session ID up front and Codex cannot — see "Why two specs" below.

## Problem

We need to know the session ID of a freshly spawned Claude pane so we can resume it on restart,
show it in the session browser, and disambiguate panes. Today we *detect* it after the fact by
watching `~/.claude/projects/**/*.jsonl` for a new file and matching it to the pane by cwd + mtime
(`SessionSpawner.ts`: `ensureSharedWatcher`, `processClaudeBatch`, `scoreClaudeCandidate`). That
matching is unreliable:

- **Same-cwd ambiguity.** Two Claude panes in the same directory produce two JSONL files that both
  match on cwd, and mtime can't reliably separate them → the code deliberately bails on ties, so
  one or both panes never get their session ID.
- **Timing races.** mtime-window matching can miss a file written slightly outside the window, or
  false-match an unrelated session that happened to write inside it.
- **Detection only happens on first message.** The transcript file is written/finalized when the
  user sends the first message, not at spawn — so detection can't complete until then, and the
  matching has to stay pending in the meantime.
- **New tab from the "default" directory is flaky.** Starting a new Claude session in a new tab
  from the default/home cwd (where many sessions share the same directory) is an especially
  unreliable case for cwd-based matching — observed intermittently failing.

All of these are **timing/ambiguity problems inherent to detecting-after-the-fact**. Passing the id
at launch removes the entire problem class: we never watch, match, or wait for a file — even the
"only on first message" timing is irrelevant because the id is known at spawn regardless of when
(or whether) the transcript file is written.

(A previous attempt — `specs/done/007`/`008`, now reverted — injected `/status` into the CLI and
scraped the UUID off the rendered terminal. That was abandoned: writing to the agent's stdin during
startup collides with trust/onboarding prompts and required PTY resizing that corrupted rendering.)

## Key finding

`claude --help` (v2.1.183) documents:

```
--session-id <uuid>   Use a specific session ID for the conversation (must be a valid UUID)
```

So we can **generate the UUID ourselves and pass it at launch** — the app then *knows* the session
ID with zero detection, zero watching, zero ambiguity. Claude writes its transcript to
`~/.claude/projects/<project>/<our-uuid>.jsonl`, so the existing `SessionIndex`/session browser
continue to find it by that id.

## Intended behavior

- On **new** Claude pane: generate a v4 UUID (`crypto.randomUUID()`), pass `--session-id <uuid>` in
  the launch command, and set the pane's `sessionId` immediately (return it from `spawnNew` so the
  renderer marks `sessionDetectionState: 'detected'` right away — no pending state, no watcher).
- On **resume**: unchanged — `claude --resume <sessionId>` already uses the known id. Do **not**
  pass `--fork-session` (that intentionally creates a *new* id on resume); we want the same id back.
- The Claude filesystem watcher and its scoring become unnecessary and should be **removed**
  (`ensureSharedWatcher`, `pendingClaudeDetections`, `claudeFileCandidates`, `scheduleClaudeBatch`,
  `processClaudeBatch`, `scoreClaudeCandidate`, and the Claude branch of `_watchForNewSession`).
  Codex keeps its filesystem detection (spec 008).

## Implementation phases

### Phase 1 — Pass `--session-id` and return the id
- In `SessionSpawner.spawnNew`, when `agentKind === 'claude'`, generate `const sessionId = randomUUID()`
  and include `--session-id ${sessionId}` in the launch args (alongside the existing `--mcp-config`).
  Return `{ ptyId, sessionId, detectionStartedAt }` with the **real** sessionId (not null).
- In the renderer (`panes.ts` `newSession`), when the result has a `sessionId`, set
  `sessionId` + `sessionDetectionState: 'detected'` immediately (this path already exists for the
  case where `session:new` returns a sessionId).
- `claudeCliArgs()` / `newSessionCommand()` need the id threaded in. Keep MCP `--mcp-config` intact.

### Phase 2 — Remove the Claude detection machinery
- Delete the Claude chokidar watcher + batch/scoring code paths. Keep `_watchForNewCodexSession`.
- `_watchForNewSession` becomes Codex-only (or callers branch before it).
- Keep `readSessionInfo`/`normalizePath` only if still used by Codex/scanner; otherwise remove.

### Phase 3 — Verify the id is honored end to end
- Confirm Claude actually creates `~/.claude/projects/<project>/<uuid>.jsonl` for the passed id and
  that `SessionIndex`/the session browser list it. Confirm `--resume <uuid>` resumes it.

## Risks / edge cases
- **UUID validity.** Claude requires a valid UUID; `crypto.randomUUID()` (v4) satisfies it.
- **Collision.** Random v4 collision is effectively impossible; no need to check for an existing file.
- **Flag stability.** `--session-id` is a documented, stable flag; far less fragile than scraping
  the terminal. If a future Claude removes it, revisit — but that's a known, narrow dependency.
- **`--fork-session` interaction.** Only relevant on resume; ensure we never pass it unless the user
  explicitly wants a fork.
- **Restored panes on startup.** They already have a `sessionId`; `hydrateTabRuntime` resumes via
  `--resume`. Unaffected (and now there's never a "pending detection" Claude pane to recover).

## Constraints (non-negotiable)
- Do **not** write to the agent's stdin for detection (the reason the probe was abandoned).
- Do not mutate user/project config files.
- Keep the direct agent-launch path (no interactive-shell prompt wait).

## Definition of done
New Claude panes have their session ID known at spawn (no watcher, no pending state); multiple
Claude panes in the same cwd — created sequentially or concurrently — each have the correct, distinct
id and resume correctly; the Claude filesystem-watcher code is removed; `npm run typecheck` passes.

## Why two specs (Claude vs Codex)
`codex --help` (v0.141.0) has **no** equivalent of `--session-id` for new interactive sessions (only
`resume`/`fork` of existing ones). Codex assigns its own rollout id and we can only learn it by
reading the rollout file it writes — so Codex must keep filesystem detection, just tightened. That
work is `specs/pending/008-codex-filesystem-session-matching.md`.
