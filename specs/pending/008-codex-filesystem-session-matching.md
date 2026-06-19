# 008 — Codex: Tighten Filesystem Session Matching

> Companion to `007-claude-session-id-at-launch.md`. Claude can be told its session ID at launch
> and so needs no detection; **Codex cannot**, so it must keep detecting its rollout id from the
> filesystem — this spec makes that reliable.

## Problem

Codex assigns its own rollout (session) id and writes it to
`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`. We learn a new pane's id by scanning
that tree and matching by cwd + mtime (`SessionSpawner._watchForNewCodexSession` +
`CodexSessionScanner.scanAll`). This is unreliable for:

- **Same-cwd concurrent panes.** Two Codex panes started in the same directory produce two new
  rollout files that both match on cwd with near-identical timestamps; the watcher picks "newest by
  mtime" and can assign the **same** file to both panes (or the wrong one to each).
- **Timing races / false matches.** mtime is fuzzy (it advances as the session writes); an unrelated
  Codex session writing within the grace window can be mis-matched, or the target file can be missed
  if it appears late.

`codex --help` (v0.141.0) confirms there is **no** launch-time session-id flag for new interactive
sessions (only `resume`/`fork`), so the Claude approach (spec 007) does not apply here.

## Current behavior (reverted-to baseline)

`_watchForNewCodexSession(ptyId, cwd, startedAt, mode, resumedSessionId?)` polls
`CodexSessionScanner.scanAll()` every ~1s and selects a session where
`normalizePath(cwd) === pane cwd && mtimeMs >= startedAt - 5000` (and, in resume mode, id ≠ resumed
id), preferring newest mtime. There is no "which of these new files is mine" disambiguation.

## What the rollout file gives us (investigated)

A real rollout file's **first record** is `session_meta`:
```json
{"type":"session_meta","payload":{
  "id":"019edd59-4a16-7041-bde6-cd5b75499f69",
  "timestamp":"2026-06-19T00:47:56.998Z",   // millisecond precision — better than mtime
  "cwd":"C:\\Users\\cdhan\\Desktop\\multiagent",
  "originator":"codex-tui","cli_version":"0.141.0","source":"cli", ...
}}
```
- The **filename** encodes start time to *second* precision + the uuid; the **meta `timestamp`** is
  millisecond precision. Use the meta timestamp for ordering, not mtime.
- There is **no PID and no app-injectable marker** in the meta (`originator` is the generic
  `"codex-tui"`), so exact content-based matching of same-cwd panes is not possible from existing
  fields. Disambiguation must come from *which files are new* + *creation order*.
- `CODEX_HOME` relocates the **entire** `~/.codex` (auth + config + sessions), so per-pane session
  isolation via `CODEX_HOME` would break login unless auth is shared in — heavy; see Option C.

## Intended behavior

A newly spawned Codex pane reliably gets its own rollout id, including when several Codex panes are
created in the same cwd at nearly the same time, with no false matches against pre-existing or
unrelated sessions — without writing anything to Codex's stdin.

## Implementation phases

### Phase 1 — Snapshot-diff detection (kills false matches)
- At spawn, snapshot the set of existing rollout file paths (cheap: the scanner already enumerates
  them). The pane's session is among files that appear **after** the snapshot. This removes the
  entire class of "matched a pre-existing/unrelated session" errors and makes single-pane detection
  exact (exactly one new file in the cwd → that's it).
- Match on `payload.cwd` from `session_meta` (normalized), not just the scanner's derived cwd.

### Phase 2 — Order by meta timestamp, not mtime
- Read each candidate's `session_meta.timestamp` (ms precision) and use it for ordering and for the
  "started at/after this pane" check, replacing the fuzzy `mtimeMs >= startedAt - grace`. mtime
  drifts as the session writes; the meta timestamp is the true session-start instant.

### Phase 3 — Same-cwd concurrent disambiguation
The hard case: two new files, same cwd, both new since snapshot. Options, best-first:
- **A (recommended): deterministic spawn order + creation-order assignment.** Ensure Codex panes in
  the same cwd are spawned in a known order with a small stagger (e.g. 150–300ms between PTY
  spawns) so their rollout files are created in that order with distinguishable meta timestamps.
  Then assign new files to pending panes by (creation order ↔ spawn order). The stagger belongs in
  the spawn path, not as a render workaround. Verify a stagger this small is enough separation.
- **B: per-pane sessions directory.** If Codex can be pointed at a distinct rollout/sessions
  directory per pane *without* relocating auth (investigate a config key for the sessions path, or
  a `CODEX_HOME` that symlinks/loads shared auth+config), each pane's file is alone in its dir →
  exact match, no ordering needed. Only pursue if a clean auth-preserving override exists.
- **C: accept graceful degradation.** If A/B aren't reliable, when two same-cwd files are
  genuinely indistinguishable, assign deterministically by creation order and `log()` the
  ambiguity rather than silently mis-assigning; never assign the same file to two panes.

### Phase 4 — Resume fork detection (preserve)
- On `codex resume`, a fork creates a new rollout id in the same cwd. Snapshot-diff makes this
  precise: the forked file is the new one (id ≠ resumed id). Keep this path; it replaces today's
  `_watchForNewCodexSession(mode='resume')` newest-by-mtime heuristic with snapshot-diff.

## Investigation tasks for the implementer
- Confirm whether two Codex spawns ~150–300ms apart reliably yield distinct, correctly-ordered meta
  timestamps and creation order (drives Phase 3A).
- Check `~/.codex/config.toml` schema + `codex -c` keys for a sessions/rollout directory override
  that does **not** move auth (drives Phase 3B). Also re-check `codex exec --help`'s
  "run without persisting session files" flag for relevance.
- Confirm the `session_meta` record is always the first line and always present (Phase 1/2 rely on
  it); handle the file-not-yet-flushed case with a short retry (the scanner already tolerates this).

## Risks
- A tiny spawn stagger trades a little latency for correctness; keep it small and only between
  same-cwd agent spawns. Don't reintroduce a user-visible serialization delay.
- Reading `session_meta` per candidate adds file reads; scope to new-since-snapshot files only.
- Codex changing the rollout filename/meta format would break parsing — keep the parse defensive.

## Constraints (non-negotiable)
- **Never write to Codex's stdin** for detection (the reason the `/status` probe was abandoned).
- Do not relocate auth/config in a way that breaks `codex login`.
- Keep detection bounded (timeout) and non-blocking; filesystem scanning stays off the hot path.
- Do not mutate user/project config files.

## Definition of done
A new Codex pane reliably gets its rollout session id — including multiple Codex panes created in
the same cwd concurrently — with no false matches against pre-existing/unrelated sessions, resume
forks still detected, nothing written to Codex's stdin, and `npm run typecheck` passing.
