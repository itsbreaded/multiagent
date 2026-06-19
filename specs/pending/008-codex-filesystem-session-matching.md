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

## Critical detection timing — file appears on FIRST MESSAGE (must address)

Observed runtime behavior the matching MUST be built around:

- **Codex does not write/finalize its rollout file at spawn — it appears only when the user sends
  the FIRST message in the pane.** There is nothing to match at spawn time; detection can only
  complete after first user interaction (possibly seconds/minutes later, or never if the pane is
  left unused). (`session_meta.timestamp` records session start, but the file does not hit disk
  until the first message.) Any detection that assumes the file exists shortly after spawn is wrong.
- **Same-cwd multi-pane bug (current, reproducible):** open two or more Codex panes in the same cwd
  without messaging them, then send a message in **one**. Only that pane's rollout file appears —
  but the current per-pane watchers each independently match "newest same-cwd file," so **all**
  pending panes get assigned that single session id. Each new rollout file must be claimed by
  **exactly one** pane and correlated to the pane that was actually messaged.
- **Consequence for disambiguation:** files appear in user-driven *message* order, not spawn order,
  so spawn-order/stagger correlation does NOT work for Codex. The correlation signal must be
  **which pane received its first message**.

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
  fields. Disambiguation must come from *which files are new* (snapshot-diff) + *which pane was just
  messaged* (first-message correlation, since the file appears at first message).
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
  entire class of "matched a pre-existing/unrelated session" errors.
- The new file appears at **first message** (see "Critical detection timing"), not at spawn — so the
  watcher must persist from spawn until the file appears (no fixed short window), and the snapshot
  is the baseline taken at spawn.
- Match on `payload.cwd` from `session_meta` (normalized), not just the scanner's derived cwd.

### Phase 2 — Order by meta timestamp, not mtime
- Read each candidate's `session_meta.timestamp` (ms precision) and use it for ordering and for the
  "started at/after this pane" check, replacing the fuzzy `mtimeMs >= startedAt - grace`. mtime
  drifts as the session writes; the meta timestamp is the true session-start instant.

### Phase 3 — Same-cwd disambiguation via the FIRST-MESSAGE event (claim-once)
Because the rollout file appears only when a pane is messaged, and the user messages panes one at a
time, the reliable correlation is **message → file**, not spawn → file:
- Detection must be **claim-once**: replace the independent per-pane watchers (which all grab the
  same newest same-cwd file) with a single shared coordinator that assigns each new rollout file to
  **exactly one** pending pane and removes it from the candidate pool.
- **Correlate the new file to the pane that was just messaged.** The renderer knows which pending
  agent pane received the user's first submitted input; have it notify main (paneId + timestamp)
  when a pending Codex pane sends its first message. When a new same-cwd rollout file then appears,
  claim it for that pane. Since messages are serialized by the user, this is unambiguous even with
  several same-cwd panes open.
  - Open question for the implementer: the cleanest "first message sent" signal. Options: the
    renderer flags the pane on first user submit (Enter with non-empty composer) via a new IPC; or
    main infers it from `pty:write` carrying a carriage return to a still-pending pane. Pick the
    most robust; document it.
- **B (optional, exact): per-pane sessions directory.** If Codex can be pointed at a distinct
  rollout/sessions directory per pane *without* relocating auth (investigate a config key for the
  sessions path, or a `CODEX_HOME` that still loads shared auth+config), each pane's file is alone
  in its dir → exact match with no correlation needed. Pursue only if a clean auth-preserving
  override exists.
- **Never assign one file to two panes**; if correlation is genuinely ambiguous, leave the extra
  pane pending and `log()` it rather than mis-assigning (the bug today is mis-assigning one id to
  all same-cwd panes — that must not happen).

### Phase 4 — Resume fork detection (preserve)
- On `codex resume`, a fork creates a new rollout id in the same cwd. Snapshot-diff makes this
  precise: the forked file is the new one (id ≠ resumed id). Keep this path; it replaces today's
  `_watchForNewCodexSession(mode='resume')` newest-by-mtime heuristic with snapshot-diff.

## Investigation tasks for the implementer
- Decide the "first message sent" signal for a pending Codex pane (drives Phase 3): renderer-side
  flag on first submit vs. main-side inference from `pty:write`. Confirm it fires once, only on a
  real message, and carries the paneId.
- Check `~/.codex/config.toml` schema + `codex -c` keys for a sessions/rollout directory override
  that does **not** move auth (the optional per-pane-directory path in Phase 3). Also re-check
  `codex exec --help`'s "run without persisting session files" flag for relevance.
- Confirm the `session_meta` record is always the first line and always present (Phase 1/2 rely on
  it); handle the file-not-yet-flushed case with a short retry (the scanner already tolerates this).

## Risks
- Detection can stay pending for a long time (until first message) — the UI must represent a pending
  agent pane gracefully and not time out into an error state prematurely.
- Reading `session_meta` per candidate adds file reads; scope to new-since-snapshot files only.
- Codex changing the rollout filename/meta format would break parsing — keep the parse defensive.
- The first-message correlation depends on user messages being serialized; if two panes are somehow
  messaged within the same poll tick, fall back to leaving the later one pending rather than guessing.

## Constraints (non-negotiable)
- **Never write to Codex's stdin** for detection (the reason the `/status` probe was abandoned).
- Do not relocate auth/config in a way that breaks `codex login`.
- Keep detection bounded (timeout) and non-blocking; filesystem scanning stays off the hot path.
- Do not mutate user/project config files.

## Definition of done
A new Codex pane reliably gets its **own** rollout session id once it is messaged. Specifically:
with several Codex panes open in the same cwd and unmessaged, sending a first message in one pane
assigns that session id to **only that pane** (the current "all same-cwd panes get one id" bug is
gone); no false matches against pre-existing/unrelated sessions; resume forks still detected;
nothing written to Codex's stdin; `npm run typecheck` passes.
