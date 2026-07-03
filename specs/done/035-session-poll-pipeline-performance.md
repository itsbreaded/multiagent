# 035 — Session Poll Pipeline Performance

Covers backlog items **3, 4, 11, 25, 41, 24, 37, 38** from `specs/pending/032-code-improvement-backlog.md`. All claims below were re-verified against the code on 2026-07-03; line numbers are current.

This spec is a handoff. Read `CLAUDE.md` → *Session Indexing* and *Session Detection* first. The 5-second poll cadence, the cwd-override semantics ("app-owned metadata first" — overrides must survive the 5s rescan), and the Codex/Claude detection flows are **invariants**. This spec makes the poll pipeline cheap; it does not change what it computes or when it broadcasts (except to make broadcast detection cheaper and equivalent).

## Problem

Every 5 seconds, `pollSessions` re-scans all Claude + Codex transcripts and upserts every session into SQLite. Along the way it:

- compiles two SQL statements **per session row per tick** and runs each upsert in its own implicit transaction (item 3);
- `fs.existsSync`-stats **every session's cwd** on every `getAll()` — the poll calls `getAll()` every tick (item 4);
- reads each *changed* transcript ~2.5× (partial head pass + full-file tail pass + full-file count pass) (item 11);
- `JSON.stringify`s the **entire index** every tick just to decide whether anything changed (item 25);
- has **no overlap guard** — a scan slower than 5s stacks concurrent scans (item 3);
- drops and rebuilds the FTS index on **every launch** because a one-time migration is written as always-run (item 41).

Independently, the session modules have unbounded caches that never evict deleted-file entries (item 24), dead code in `TranscriptScanner.scanFile` (item 37), and three copies of `walkJsonlFiles` / `deriveProjectName` / `truncate` / `parseRecord` that can silently drift (item 38).

None of this is a correctness bug today; together it is sustained main-process churn every 5 seconds for the lifetime of the app, scaling with total session count, and it grows worse the longer a user keeps using the app.

## Current Behavior (evidence)

### Item 3 — per-call statement prep, per-row implicit transactions, no overlap guard

`src/main/sessions/SessionIndex.ts:176-220` — `upsert()` calls `this.db.prepare(...)` on the big INSERT … ON CONFLICT statement on **every call** (line 183), and first calls `getCwdOverride()` (line 177) which prepares its own SELECT on every call (`SessionIndex.ts:222-227`):

```ts
upsert(session: ScannedSession): void {
  const override = this.getCwdOverride(session.agentKind, session.sessionId)  // prepares SELECT per call
  ...
  const stmt = this.db.prepare(`INSERT INTO sessions ( ... ) ON CONFLICT(agentKind, sessionId) DO UPDATE SET ...`)  // :183, per call
  stmt.run({ ... })
}
```

`src/main/ipc/handlers.ts:170-187` — `pollSessions` upserts every scanned session in a plain loop (each `stmt.run` is its own implicit transaction), and the `setInterval` at line 187 fires regardless of whether the previous async run finished:

```ts
async function pollSessions(forceBroadcast = false): Promise<void> {
  try {
    const sessions = await scanAllSessions()
    for (const session of sessions) {
      index.upsert(session)              // 2 prepares + 1 implicit txn per row
    }
    const all = index.getAll()
    const json = JSON.stringify(all)     // item 25, below
    if (forceBroadcast || json !== lastSessionsJson) { ... }
  } catch (err) { ... }
}
const contentTimer = setInterval(() => { void pollSessions() }, 5000)   // no in-flight guard
```

There is **no skip for unchanged rows**: every session is rewritten every tick even when its transcript `mtimeMs` is identical to what's stored, which also fires the three FTS triggers (`sessions_au` does an FTS delete+insert per update, `SessionIndex.ts:165-170`) for rows whose indexed columns didn't change.

The startup scan at `handlers.ts:155-159` has the same per-row loop.

### Item 4 — `fs.existsSync` per row on every read

`src/main/sessions/SessionIndex.ts:15-32` — `scannedToSession` computes `cwdExists: fs.existsSync(row.cwd)` (line 20). It is mapped over every row by `getAll()` (`:280-287`), `getByProject()` (`:289-294`), `search()` (`:296-312`), `get()` (`:273-278`), and `repairCwd()` (`:263-266`). Because `pollSessions` calls `getAll()` every 5s, this is a synchronous stat per session row per tick on the main thread — worse on network drives — and many sessions share the same cwd, so most stats are duplicates. `cwdExists` only drives the "severed directory" UI marker.

### Item 11 — each changed transcript read ~2.5×

`src/main/sessions/TranscriptScanner.ts:111-213` — on every cache miss (i.e. every 5s for any actively-written transcript), `scanFile` does three passes:

1. **Head pass** (`:146`): `readLines(filePath, 40)` — streams the first 40 lines for sessionId/cwd/gitBranch/firstActivity/firstMessage.
2. **Tail pass** (`:170`): `readLastLines(filePath, 15)` — despite the name, `readLastLines` (`:55-73`) streams the **entire file** through readline keeping a 15-line rolling buffer.
3. **Count pass** (`:187` → `countUserMessages`, `:216-232`): streams the **entire file again**, `parseRecord` (`JSON.parse`) per line.

So a large active transcript is fully read twice plus a partial head read, with two full JSON-parse sweeps, every 5 seconds while the agent is producing output.

### Item 37 — dead code in `scanFile`

`src/main/sessions/TranscriptScanner.ts`:

- `:112` — `let stat: fsPromises.FileHandle | undefined` is declared, never assigned (the actual stat result goes to `mtimeMs` at `:116-117`), and disposed of with a bare `void stat` at `:133`. Both lines are dead.
- `:158-159` — the head-pass `messageCount++` is dead: `messageCount` is unconditionally overwritten by `countUserMessages` at `:187` (the comment at `:185-186` even says so).
- `:160-165` — `extractText(record)` is called twice per real user message in the head pass (once inside the `if (!firstMessage)` block, once after it).

### Item 25 — whole-index stringify for change detection

`src/main/ipc/handlers.ts:168`, `:176-181` — `lastSessionsJson` holds a JSON snapshot of the entire session list; each tick stringifies `index.getAll()` and string-compares. `sessions:repair-cwd` manually re-primes this snapshot at `handlers.ts:265-267` (`lastSessionsJson = JSON.stringify(all)`) so the next poll doesn't re-broadcast — a coupling that must be dissolved when the mechanism changes.

Note a subtlety the replacement must preserve: because `cwdExists` is computed live inside `getAll()`, the JSON-compare currently *also* detects a cwd directory appearing/disappearing between ticks (no row changed, but the serialized output did). See Risks.

### Item 41 — FTS index dropped and rebuilt on every launch

`src/main/sessions/SessionIndex.ts:67-73` — `migrate()` starts by unconditionally dropping all three FTS triggers and the `sessions_fts` table, then recreates them and runs `INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')` at `:172`. This was a one-time schema migration (external-content FTS adoption) written as always-run: every launch pays a full FTS rebuild proportional to the sessions table.

### Item 24 — unbounded caches

- `src/main/sessions/TranscriptScanner.ts:32-33` — module-level `scanCache = new Map<string, ScannedSession>()` keyed `filePath:mtimeMs`. `scanFile` evicts *older mtime* entries for the same path (`:127-131`) but nothing ever removes entries for **deleted** files.
- `src/main/sessions/CodexSessionScanner.ts:36` — identical pattern, identical leak (`:172-174` for same-path eviction).
- `src/main/sessions/SessionSpawner.ts:48` — `claimedCodexFiles = new Set<string>()` grows monotonically: `_claimCodexCandidate` adds (`:244`), nothing removes, even after the rollout file is deleted.

### Item 38 — triplicated helpers

- `walkJsonlFiles` exists verbatim (modulo import aliasing) in `CodexSessionScanner.ts:61-79` and `DeepSearcher.ts:36-53`.
- `deriveProjectName` exists in **three** places with identical bodies: `transcriptParse.ts:70-77` (the canonical, tested one), `SessionIndex.ts:51-56`, and `CodexSessionScanner.ts:42-47`.
- `truncate` exists in `transcriptParse.ts:61-63` (`maxLen = 200` default), `CodexSessionScanner.ts:49-51` (identical), and `deepSearch.ts:37` (**different signature**: `maxLen` required, no default — used for snippet truncation at `SNIPPET_MAX_LEN`).
- `parseRecord` exists in `transcriptParse.ts:25-31` (typed `JsonlRecord`) and `CodexSessionScanner.ts:53-59` (typed `CodexRecord`) — same try/`JSON.parse`/null body, different cast.

`TranscriptScanner` already imports the canonical helpers from `transcriptParse.ts` (`TranscriptScanner.ts:7-13`); the other files predate that extraction and drifted.

## Intended Behavior

- One poll tick performs: one scan, one **batched transaction** of upserts using **prepared-once** statements, skipping rows whose stored `mtimeMs` is unchanged; SQLite work per tick is O(changed rows), not O(all rows).
- A tick that starts while the previous tick is still running is **skipped** (in-flight guard). Cadence stays 5s.
- `cwdExists` is computed with at most one `fs.existsSync` per **distinct cwd** per `getAll()`/read call (per-call dedupe map).
- A changed transcript is read in **one streaming pass** that produces identical `ScannedSession` output (head fields still resolved first-wins, tail fields last-wins, exact same `messageCount` per `isRealUserMessage`).
- Change detection is a **changed-row report from `upsertMany`** plus a cheap cwd-existence fingerprint — no whole-index `JSON.stringify`. `sessions:updated` still fires on every real change, including transcript updates and cwd appear/disappear transitions.
- The FTS drop/rebuild runs **once**, guarded by `PRAGMA user_version`; subsequent launches skip it.
- After each `scanAll()`, scanner caches drop entries whose file path was not in the walked set; `claimedCodexFiles` prunes paths that no longer exist on disk during `_readNewCodexCandidates`.
- Exactly one copy each of `walkJsonlFiles`, `deriveProjectName`, `truncate`, and the JSONL-line parser, with byte-identical behavior at every call site.

Nothing about *what* gets indexed, *when* sessions are detected, or *how* cwd overrides are applied changes.

## Implementation Plan

### Phase A — SQLite (items 3, 41)

1. **Prepared statements as class fields** (`SessionIndex.ts`). In the constructor (after `migrate()`), prepare and store: the upsert statement, the cwd-override SELECT, and a `SELECT agentKind, sessionId, mtimeMs FROM sessions` statement for change-skip lookups. Rewrite `upsert()` and `getCwdOverride()` to use them. Keep `upsert(session)` public — `DeepSearcher.search` calls it for on-demand hydration (`DeepSearcher.ts:215`).
2. **`upsertMany(sessions: ScannedSession[]): { changed: number }`** wrapped in `this.db.transaction(...)`. Before the transaction, load the stored `(agentKind:sessionId) → mtimeMs` map once; inside, skip any row whose stored `mtimeMs` strictly equals the incoming one, run the prepared upsert for the rest, count them. Return the changed count (see Phase C for how it's consumed). Skipping by mtime is safe with respect to cwd overrides: `repairCwd` updates the `sessions` rows itself in the same transaction that writes the overrides (`SessionIndex.ts:238-261`), so an unchanged-mtime row never carries a stale pre-override cwd.
3. **`PRAGMA user_version` guard** (item 41). In `migrate()`, read `this.db.pragma('user_version', { simple: true })`. If `< 1`: run the existing drop-FTS block, the legacy `sessions_old` migration, the `CREATE ... IF NOT EXISTS` block, and the `'rebuild'` insert, then set `user_version = 1`. If already `>= 1`: run only the idempotent `CREATE TABLE/TRIGGER IF NOT EXISTS` block (cheap no-ops) and **skip** the drop and the rebuild. Bump `user_version` again in the future whenever FTS shape changes.
4. **Testability**: give the constructor an optional `dbPath` parameter defaulting to the current `app.getPath('userData')`-derived path, so tests can pass a temp path or `':memory:'` without mocking Electron (per the CLAUDE.md "extract/inject instead of vi.mock Electron" guidance). Move the `app.getPath` call from module scope (`SessionIndex.ts:9`) into that default so importing the module in tests doesn't touch Electron — verify nothing else in the module reads `app` at load time.

### Phase B — scanner single-pass + dead code (items 11, 37, and the cwd-stat dedupe, item 4)

1. **Delete dead code first** (`TranscriptScanner.ts:112`, `:133`, the head-pass `messageCount++` at `:158-159`, and the duplicated `extractText` call at `:160-165` — call once, use for both `firstMessage` and `lastMessage`).
2. **Merge the three passes into one stream.** Replace `readLines` + `readLastLines` + `countUserMessages` with a single readline pass over the file that accumulates, per line: first-wins `sessionId`/`cwd`/`gitBranch`/`firstActivity`/`firstMessage`; last-wins `lastActivity`/`lastMessage`; `messageCount++` per `isRealUserMessage`. This is exactly what `CodexSessionScanner.scanFile` (`CodexSessionScanner.ts:176-243`) already does — mirror its shape. Semantics check before deleting the old code: in the current code the tail pass takes `lastActivity` from *any* record's timestamp and `lastMessage` from real user messages, and the full count pass counts all real user messages — a single pass over all lines computes the identical values (the head/tail split was an optimization attempt, not a semantic filter; note the head pass caps `firstMessage` discovery at 40 lines, so a transcript whose first real user message is after line 40 currently gets `firstMessage: null` — the single pass fixes this; treat as a strictly-better bugfix and cover it with a test). One pass = one full read + one `parseRecord` per line, down from ~2.5 reads and 2 full parse sweeps.
3. **cwd-stat dedupe** (item 4, lives in `SessionIndex.ts`): in each of `getAll`/`getByProject`/`search`/`repairCwd`, build a per-call `Map<string, boolean>` and pass a `cwdExists(cwd)` lookup into `scannedToSession` (make the exists-fn a parameter). Do **not** introduce a long-lived TTL cache in this phase — per-call dedupe alone removes the duplicate stats and keeps `cwdExists` fresh per read. (If profiling later shows distinct-cwd stats still matter, a short-TTL memo can be added, but it interacts with Phase C's fingerprint — keep it out of scope now.)

### Phase C — change detection + overlap guard (items 25, remainder of 3)

1. **Extract a testable poller.** `pollSessions` lives inside the 1180-line `handlers.ts` closure. Create `src/main/sessions/sessionPoll.ts` exporting `createSessionPoller(deps: { scanAll(): Promise<ScannedSession[]>; index: Pick<SessionIndex, 'upsertMany' | 'getAll'>; broadcast(sessions: Session[]): void })` returning `{ poll(force?: boolean): Promise<void> }`. `handlers.ts` wires it with `scanAllSessions`, the real index, and `windowManager.broadcastAll('sessions:updated', ...)`, keeping the `setInterval(..., 5000)` where it is.
2. **In-flight guard**: a boolean latch inside the poller — if `poll()` is called while a previous run is unfinished, return immediately (do not queue). Mirror `SessionSpawner._pollCodexDetections`'s `codexPollInFlight` pattern (`SessionSpawner.ts:183-196`). A `force` call that is skipped due to overlap should set a `forcePending` flag consumed by the next tick, so `sessions:refresh` (`handlers.ts:281-284`) never silently loses its forced broadcast.
3. **Dirty-flag change detection**: broadcast when `upsertMany(...).changed > 0`, or `force`, or the **cwd-existence fingerprint** changed. The fingerprint preserves the one signal the JSON-compare provided beyond row changes: after `getAll()` (which Phase B already made dedupe-stat per distinct cwd), derive a small string/Map of `distinctCwd → exists` and compare with the previous tick's. This keeps "directory deleted/restored while rows unchanged" pushing `sessions:updated` so the severed-directory UI marker stays live.
4. **Delete `lastSessionsJson`** and the manual re-prime at `handlers.ts:265-267`. `sessions:repair-cwd` already broadcasts directly; with row-change detection, the next poll only re-broadcasts if the rescan actually changes rows (and if it does, that broadcast is correct, not spurious — the override-aware upsert produces the same repaired values, hence `changed = 0`). Also route the startup scan (`handlers.ts:155-159`) through `upsertMany`.

### Phase D — cache eviction + helper consolidation (items 24, 38)

1. **Scanner cache eviction**: in both `TranscriptScanner.scanAll` and `CodexSessionScanner.scanAll`, collect the set of walked file paths and, after the scan loop, delete every cache key whose `filePath` prefix is not in that set. Prefer converting the module-level caches to instance fields while touching them (both scanners are singletons constructed in `handlers.ts`, so behavior is unchanged, and tests can construct fresh instances). Keep the existing `filePath:mtimeMs` key shape.
2. **`claimedCodexFiles` pruning**: in `SessionSpawner._readNewCodexCandidates` (`SessionSpawner.ts:198`), after `listCodexSessionFilePaths()` returns, remove from `claimedCodexFiles` any path not present in the returned list (the file was deleted; it can never be re-claimed anyway, and this bounds the set). Do **not** touch `baselinePaths`, the pending-detection lifecycle, the originator/source filters, or `selectCodexAssignments` — the baseline-snapshot-diff semantics are an invariant.
3. **`src/main/sessions/fsWalk.ts`**: move `walkJsonlFiles` there (one recursive implementation, `export async function walkJsonlFiles(dir: string): Promise<string[]>`); import in `CodexSessionScanner.ts` and `DeepSearcher.ts`; delete both copies.
4. **Consolidate into `transcriptParse.ts`**:
   - `deriveProjectName`: delete the copies in `SessionIndex.ts:51-56` and `CodexSessionScanner.ts:42-47`; import the canonical one. Bodies are already identical — confirm with the characterization tests below before deleting.
   - `truncate`: delete the `CodexSessionScanner` copy (identical). For `deepSearch.ts:37`, its signature differs (required `maxLen`); the canonical `truncate(text, maxLen = 200)` is call-compatible with every `deepSearch` call site (all pass an explicit `maxLen`) — delete the `deepSearch` copy and import, or leave it if `deepSearch.ts`'s exports are load-bearing for its tests; either way there must be one implementation.
   - `parseRecord`: add a generic `parseJsonLine<T>(line: string): T | null` to `transcriptParse.ts`; keep the existing typed `parseRecord` as a thin alias for Claude records; replace the `CodexSessionScanner` copy with `parseJsonLine<CodexRecord>`.

Phases are independent PRs in order A → B → C → D (C depends on A's `upsertMany`; B and D are standalone).

## Tests

All main-process tests below run in the **`main` Vitest project (node env)** defined in `vitest.config.ts` — better-sqlite3 is a native module and works there (it is rebuilt for Electron by postinstall but loads fine under plain Node for the ABI-compatible dev toolchain; if the ABI mismatch bites on a given machine, construct against a temp file DB and note that CI runs `windows-latest` with the same toolchain). Co-locate beside source per convention.

- **`src/main/sessions/SessionIndex.test.ts`** (new, Phase A):
  - Construct with a temp `dbPath` (scratch dir + `fs.mkdtempSync`).
  - `upsertMany` round-trip: N scanned sessions in → `getAll()` returns N with correct fields.
  - Skip-unchanged: call `upsertMany` twice with identical input → second call returns `{ changed: 0 }`; bump one row's `mtimeMs` → `{ changed: 1 }`.
  - Override survival: `repairCwd(old, new)` then `upsertMany` with the *old* cwd and a **newer** `mtimeMs` → row still reports the repaired cwd/projectName (this pins the "cwd overrides survive rescans" invariant).
  - `user_version` guard: open the same DB file twice; assert `user_version === 1` after first open and that the second open does not error and FTS `search()` still returns results (proving no rebuild was needed).
  - cwd-dedupe: spy/count via an injected exists-fn — `getAll()` over 10 rows sharing 2 cwds calls it exactly twice.
- **`src/main/sessions/TranscriptScanner.test.ts`** (new, Phase B): write JSONL fixtures to a temp dir, pin mtimes with `fs.utimesSync` (determinism rule). Characterization: single-pass output (`sessionId`, `cwd`, `gitBranch`, `firstMessage`, `lastMessage`, `firstActivity`, `lastActivity`, `messageCount`) matches hand-computed expectations for: a normal transcript, one with `<command`-prefixed and `isMeta` records (excluded from count), one whose first real user message is past line 40 (`firstMessage` now non-null — the fixed case), and a malformed-JSON-line file. Cache: same mtime → second `scanFile` returns the cached object; `scanAll` after deleting a fixture file → cache no longer holds the deleted path (Phase D eviction).
- **`src/main/sessions/CodexSessionScanner.test.ts`** (new, Phase D): scanAll cache-eviction mirror of the above; `deriveProjectName`/`truncate`/`parseJsonLine` imports produce identical metadata to a snapshot taken before consolidation.
- **`src/main/sessions/sessionPoll.test.ts`** (new, Phase C): with stub deps —
  - broadcast fires when `upsertMany` reports `changed > 0`; does not fire when `changed === 0` and fingerprint unchanged.
  - broadcast fires on cwd-existence fingerprint change with `changed === 0`.
  - `force` broadcasts even with no changes.
  - overlap: `poll()` while a slow `scanAll` promise is pending resolves without a second `scanAll` call; a skipped forced poll re-forces the next tick.
- **`src/main/sessions/transcriptParse.test.ts`** (extend, Phase D): add `deriveProjectName` characterization cases pinned to current output — `C:\Code\multiagent` → `Code/multiagent`, `/home/u/proj` → `u/proj`, single-segment `C:\` and `/x`, trailing-slash, UNC-ish `\\server\share\proj` — asserted **before** deleting the duplicate copies, so consolidation is provably behavior-preserving. Add `parseJsonLine` malformed/valid cases and `truncate` boundary cases (len === 200, > 200).
- **`src/main/sessions/codexDetection.test.ts`** (extend, Phase D): existing detection-selector tests must stay green untouched; add one case asserting that pruning `claimedCodexFiles` of a deleted path does not let a still-existing claimed file be re-claimed.

## Risks

- **Sessions must still push to the renderer on transcript updates.** This is the highest-risk change (Phase C). The old JSON-compare was crude but complete. The replacement must broadcast on: any row change (covered by `upsertMany` changed-count — a transcript update changes `mtimeMs`, so the row is not skipped), forced refresh (`sessions:refresh`, pane-close refresh), repair-cwd (its own direct broadcast), and cwd appear/disappear (the fingerprint). Backlog item 3/25 risk note applies verbatim: verify end-to-end that sending a message in a live agent pane updates Recent within ~5s. The e2e FTS test plus the new `sessionPoll.test.ts` cover this; do the manual check anyway.
- **Codex detection baseline-snapshot semantics** (Phase D): `walkJsonlFiles` consolidation changes which module the detection scanner imports its walker from — it must not change walk *ordering or filtering* (recursive, `.jsonl` only, silent on unreadable dirs), because `baselinePaths` snapshots and `_readNewCodexCandidates` diffs are built from its output. Keep the implementation byte-equivalent; the `codexDetection.test.ts` suite plus a manual new-Codex-pane detection check gate this. Do not "improve" the walker (e.g. sorting, symlink handling) in this spec.
- **mtime-skip false negatives**: a transcript rewritten within the same mtime resolution with identical `mtimeMs` would be skipped. This matches the scanners' existing `filePath:mtimeMs` cache-key behavior (such a file already returns the cached `ScannedSession` today), so no regression — but the skip must compare against the **stored DB row's** mtime, not the scan cache, so a fresh DB always upserts everything.
- **`user_version` on existing installs**: first launch after upgrade sees `user_version = 0` and performs one final drop/rebuild, then never again. If a future dev changes FTS shape without bumping the version, stale FTS results silently persist — the migrate function must carry a comment stating the bump rule.
- **Single-pass scanner regressions** silently corrupt session metadata (the exact hazard `transcriptParse.ts`'s header warns about). The characterization fixtures are the gate; write them against the *old* implementation first, then swap.
- **`repairCwd` interplay with skip-unchanged**: after a repair, rows were updated directly with unchanged file mtimes; the next poll's upsert for those rows is *not* skipped (incoming scan mtime equals stored mtime → skipped, which is correct: the stored row already holds the override-applied values). The override-survival test pins this.

## Verification Steps

1. `npm test` and `npm run typecheck` green after each phase.
2. `npm run test:e2e` after Phases A and C (covers the real SQLite FTS index on startup).
3. Manual, after Phase C: open the app with existing Claude/Codex history; send a message in a live Claude pane → sidebar Recent/last-message updates within ~5s. Close the pane → session moves to Recent promptly (`sessions:refresh` path). Rename/delete a session's project directory on disk → severed marker appears within ~5s (fingerprint path); restore it → marker clears.
4. Manual, after Phase A: relaunch the app twice; second launch should not pay an FTS rebuild (verify `user_version` = 1 via `sqlite3` on `session-index.db`, and that Session Browser summary search still returns results).
5. Manual, after Phase D: open a new Codex pane, send a message → session detected and attached as before; repair a missing cwd via the UI → sessions and layout update, and the next poll does not revert or double-broadcast.
6. Perf sanity (informal): with a large session history, observe main-process CPU during idle — the 5s tick should no longer show a stringify/stat spike (Task Manager or `--inspect` profile before/after is sufficient; no formal benchmark required).

## Handoff Contract

### Non-negotiables

1. **The 5s poll cadence stays.** Do not change the interval, replace polling with fs-watchers, or add adaptive scheduling in this spec.
2. **Cwd overrides survive rescans.** `session_cwd_overrides` must keep winning over scanned values in every upsert path (`upsert` and `upsertMany`), exactly as today.
3. **Detection flows untouched.** No changes to `SessionSpawner`'s Claude launch-time `--session-id` path, the Codex baseline-snapshot/poll/claim lifecycle, `selectCodexAssignments`, or detection timing — except the single additive `claimedCodexFiles` prune described in Phase D.2.
4. **`deriveProjectName` output must not change** when consolidated: pin current behavior with characterization tests before deleting duplicates; any intentional future change is a separate spec.
5. **`sessions:updated` still fires for every user-visible change** (transcript updates, forced refresh, repair, cwd-existence transitions). Losing pushes is worse than the perf win.
6. **No mutation of user agent config files, no new PATH/env behavior** — this spec is entirely inside the session pipeline.

### Definition of Done

- All four phases merged; `npm test`, `npm run typecheck`, `npm run test:e2e` green.
- Grep-clean: exactly one definition each of `walkJsonlFiles`, `deriveProjectName`, `truncate` (modulo the documented deepSearch decision), and the JSONL line parser under `src/main/sessions/`.
- `handlers.ts` no longer contains `lastSessionsJson` or an inline `pollSessions` body; the poller lives in `sessionPoll.ts` with its unit tests.
- `SessionIndex` prepares its hot statements once, exposes `upsertMany`, and `migrate()` is guarded by `user_version`.
- `TranscriptScanner.scanFile` performs one streaming read; the dead `stat` handle, dead head-pass count, and duplicate `extractText` call are gone.
- New/extended test files listed above exist and pass; manual verification steps 3-5 performed and noted in the PR description.
- CLAUDE.md's Session Indexing section updated only if observable behavior notes changed (e.g. the firstMessage-past-line-40 fix); otherwise untouched.

## Out of Scope

- DeepSearcher performance (backlog item 12: early stream close, concurrency pool, mtime-ordered walk) — same files, separate change.
- FTS5 query escaping (item 7) and `SessionIndex.search` fallback behavior.
- Any fs-watcher-based replacement for polling; adaptive poll intervals.
- Long-lived TTL caching of `cwdExists` (per-call dedupe only; revisit only with profiling data).
- Splitting `handlers.ts` generally (item 28) — Phase C extracts only the poller.
- Changing `ScannedSession` shape, index schema (beyond `user_version`), or IPC channel contracts.
- Walker "improvements" (sorting, symlink traversal, depth limits).
