# 036 — Session Search Correctness and Deep-Search Performance

Covers items **5**, **7**, and **12** from `specs/pending/032-code-improvement-backlog.md`. Three independent fixes to the session-search surface: a renderer stale-response bug in the Session Browser deep mode, a main-process crash on ordinary summary-search queries, and a performance/ordering defect in the full-transcript deep searcher. All claims below were re-verified against the code on 2026-07-03; line numbers are current.

## Problem

1. **Stale deep-search results repopulate a cleared query (backlog item 5).** Clearing the deep-search box while a search is in flight does not invalidate that in-flight request. When its response lands, it passes the generation check and fills `deepResults` under an empty query — the UI shows results for a query the user already deleted.

2. **FTS5 `MATCH` throws on ordinary user queries (backlog item 7).** `SessionIndex.search()` feeds raw user input into an FTS5 `MATCH` expression. FTS5 query syntax treats `"`, `:`, `*`, `(`, `)`, `-`, `AND`/`OR`/`NOT`/`NEAR` as operators. An unbalanced quote, a trailing `AND`, or — the most likely query in this app — a Windows path like `C:\Code\multiagent` (the `:` is FTS5 column-filter syntax, and `sessions_fts` has no column named `C`) throws `SqliteError`, which rejects the `sessions:search` invoke. Summary search silently breaks for exactly the queries users type.

3. **DeepSearcher wastes I/O and fills its candidate cap in filesystem walk order (backlog item 12).** After a file hits the per-session match cap, the searcher keeps streaming the rest of the file (multi-MB transcripts read to EOF for nothing). Files are searched strictly sequentially, and the search loop breaks at `limit * 2` candidates in raw `readdir` walk order — so on a machine with many old transcripts, stale sessions can consume the entire candidate pool before recent sessions are ever opened, and recent matches never appear in deep-search results at all.

## Current Behavior

### Item 5 — `src/renderer/src/components/SessionBrowser/index.tsx:60-78`

```ts
const runDeepSearch = useCallback(async (q: string) => {
  if (!q.trim()) {
    setDeepResults([])
    setDeepSearching(false)
    return                                     // <-- returns WITHOUT bumping searchGenRef
  }
  const gen = ++searchGenRef.current
  setDeepSearching(true)
  try {
    const results = (await window.ipc.invoke('sessions:search-deep', { query: q })) as SessionSearchResult[]
    if (searchGenRef.current !== gen) return   // <-- stale check passes: gen is still current
    setDeepResults(results)
```

Sequence that reproduces the bug: user types `foo` → debounce (300ms, `index.tsx:80-87`) fires `runDeepSearch('foo')` with `gen = 1` → user clears the input → debounce fires `runDeepSearch('')`, which resets `deepResults` but leaves `searchGenRef.current === 1` → the in-flight `foo` response resolves, `searchGenRef.current !== gen` is false, and `setDeepResults(results)` repopulates results under an empty query. The empty-state prompt is replaced with stale matches.

### Item 7 — `src/main/sessions/SessionIndex.ts:296-312`

```ts
search(query: string): Session[] {
  if (!query.trim()) return this.getAll()

  // FTS5 search - join back to sessions for full row data
  const rows = this.db
    .prepare(
      `
      SELECT s.*
      FROM sessions s
      JOIN sessions_fts fts ON s.rowid = fts.rowid
      WHERE sessions_fts MATCH ?
      ORDER BY rank
    `
    )
    .all(query) as DbRow[]           // <-- raw user input as the MATCH expression
  return rows.map(scannedToSession)
}
```

The caller is `ipcMain.handle('sessions:search', (_e, query) => index.search(query))` at `src/main/ipc/handlers.ts:236` — there is no try/catch anywhere on this path, so the `SqliteError` rejects the invoke. Queries that throw today: `C:\Code\multiagent` (column filter on nonexistent column `C`), `"unbalanced`, `foo AND` (dangling operator), `foo(`, `-foo` at expression start.

### Item 12 — `src/main/sessions/DeepSearcher.ts:111` and `:185-200`

Line 111, inside the `rl.on('line', ...)` handler of `searchFile`:

```ts
if (matches.length >= matchesPerSession) return   // <-- returns from the handler; the
if (!matcher(line)) return                        //     stream keeps reading to EOF
```

Compare lines 98-107 in the same handler, which already demonstrate the correct early-termination idiom for the malformed-Codex-meta case: `rl.close(); stream.destroy(); return`.

Lines 177-200, in `search()`:

```ts
const fileJobs: Array<{ filePath: string; agentKind: AgentKind }> = []
for (const root of roots) {
  const files = await walkJsonlFiles(root.dir)          // raw recursive readdir order
  for (const f of files) fileJobs.push({ filePath: f, agentKind: root.agentKind })
}

const resultsByKey = new Map<string, FileResult>()

for (const job of fileJobs) {
  // Collect up to 2× limit to account for unindexed sessions being skipped
  if (resultsByKey.size >= limit * 2) break             // cap fills in walk order

  const fileResult = await searchFile(job.filePath, job.agentKind, matcher, request)  // sequential
```

`walkJsonlFiles` (`DeepSearcher.ts:36-53`) is a plain recursive `readdir` with no ordering guarantee and no mtime collection. With `DEFAULT_LIMIT = 50` (`deepSearch.ts:16`), the loop stops after 100 matching sessions — whichever 100 the directory walk happened to reach first. Claude roots are one flat dir per project; Codex roots are date-partitioned (`~/.codex/sessions/YYYY/MM/DD/`), so walk order is not recency order for either kind, and Claude is walked entirely before Codex.

Session-id provenance (matters for early termination): the **Claude** sessionId is derived from the filename before the stream opens (`DeepSearcher.ts:65-68`, validated against `CLAUDE_SESSION_ID_RE`), so a Claude stream can be destroyed at any point. The **Codex** sessionId comes from the file's *first* record, the `session_meta` line (`DeepSearcher.ts:91-109`; files whose first record is not `session_meta` are already rejected). Since the match cap can only be reached on or after line 1, `sessionId` is always populated by the time termination fires — early termination is safe for both kinds, but this invariant must be stated in the code comment because it is what makes destroying the stream mid-file correct.

## Intended Behavior

1. Clearing the deep-search query (or changing it) invalidates **every** in-flight deep-search response, including via the empty-query branch. A response from a superseded query is always discarded.

2. `SessionIndex.search()` never throws on user input. Every query is treated as **literal terms**: input is tokenized on whitespace and each token is quote-escaped into an FTS5 string literal, joined with implicit AND. Multi-term searches keep their current AND semantics (`foo bar` finds rows containing both). Windows paths, quotes, parens, and FTS keywords are matched literally. As belt-and-braces, a residual FTS failure falls back to a `LIKE` scan instead of rejecting the invoke.

3. Deep search reads only as much of each transcript as it needs (stream destroyed once the per-session match cap is hit), searches files with a small concurrency pool, and fills its candidate pool **newest-first by transcript mtime** so recent sessions can never be crowded out by old ones. Final result ordering is unchanged: `scoreResult` descending, top `limit`.

## Implementation Plan

### Item 5 — bump the generation unconditionally

`src/renderer/src/components/SessionBrowser/index.tsx`, `runDeepSearch`:

```ts
const runDeepSearch = useCallback(async (q: string) => {
  const gen = ++searchGenRef.current   // moved above the empty-query branch
  if (!q.trim()) {
    setDeepResults([])
    setDeepSearching(false)
    return
  }
  setDeepSearching(true)
  ...
```

One-line move. The stale checks in the `try`/`catch`/`finally` blocks are already correct once the generation advances for every invocation. No other changes; keep the 300ms debounce and mode gating as-is.

### Item 7 — literal FTS escaping with LIKE fallback

1. **Extract a pure query builder** — new file `src/main/sessions/ftsQuery.ts` (follow the `deepSearch.ts` / `buildEnv.ts` extraction precedent: pure module, no Electron/native imports, testable under plain Node):

   ```ts
   /** Convert raw user input into a safe FTS5 MATCH expression: whitespace-split
    *  tokens, each wrapped as a double-quoted FTS string literal with internal
    *  quotes doubled, joined with implicit AND. Returns null when no tokens remain. */
   export function toFtsMatchExpression(query: string): string | null {
     const tokens = query.split(/\s+/).filter(Boolean)
     if (tokens.length === 0) return null
     return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
   }
   ```

   `"` doubling inside a double-quoted FTS5 string is the documented FTS5 escape; a quoted string is always a literal term (operators, column filters, and `*` lose their meta-meaning). Do **not** attempt to preserve user-written FTS operators — the contract for summary search becomes "literal terms, implicit AND".

2. **Use it in `SessionIndex.search()`** (`src/main/sessions/SessionIndex.ts:296`):

   ```ts
   search(query: string): Session[] {
     const match = toFtsMatchExpression(query)
     if (!match) return this.getAll()
     try {
       return /* existing prepared MATCH query */ .all(match).map(scannedToSession)
     } catch {
       return this.searchLike(query)
     }
   }
   ```

3. **Add the `searchLike` fallback** — private method: split the query into the same tokens, build `WHERE` with one `AND`-ed group per token over the four summary columns, using `LIKE ? ESCAPE '\'` with `%`/`_`/`\` escaped in the bound value, ordered by `lastActivity DESC NULLS LAST`. With correct escaping the fallback should be unreachable; it exists so a future FTS edge case degrades to slower-but-correct instead of a rejected invoke.

4. Optionally wrap the handler at `src/main/ipc/handlers.ts:236` in a final try/catch returning `[]` so no future `search()` regression can reject the invoke. Log the error; do not swallow it silently.

### Item 12 — early stream termination, mtime ordering, concurrency pool

All in `src/main/sessions/DeepSearcher.ts`.

1. **Early termination** (line 111): when the cap is reached, stop the stream instead of draining it:

   ```ts
   if (matches.length >= matchesPerSession) {
     // Safe for both kinds: Claude sessionId comes from the filename (set before
     // the stream opens); Codex sessionId comes from the session_meta first line,
     // which has necessarily been processed before the cap can be hit.
     rl.close()
     stream.destroy()
     return
   }
   ```

   `rl.close()` fires the existing `'close'` → `finish()` path, so the promise resolves with the collected matches. `readline` may still deliver already-buffered lines after `close()`; the cap guard runs first on every line, so no extra matches can be appended. This mirrors the malformed-Codex-meta termination at lines 98-107.

2. **Collect mtimes and sort newest-first**: change the job-collection phase to stat each walked file (via `fs/promises.stat`, tolerating races with `try { ... } catch { skip }` — transcripts can be deleted mid-walk) and build `fileJobs: Array<{ filePath, agentKind, mtimeMs }>`. After both roots are walked, `fileJobs.sort((a, b) => b.mtimeMs - a.mtimeMs)`. Either extend `walkJsonlFiles` to return `{ path, mtimeMs }` or stat in a second pass — keep it a pure-Node implementation. Note: backlog item 38 wants `walkJsonlFiles` consolidated with `CodexSessionScanner`'s copy; if you change its signature here, keep the shape reusable for that later dedup (returning entries with `mtimeMs` is fine for both).

3. **Concurrency pool**: replace the sequential `for` loop with a fixed pool of **6** workers (constant `SEARCH_CONCURRENCY = 6` in `deepSearch.ts`, within the 4-8 band) pulling from a shared index cursor over the sorted `fileJobs`. Each worker loops: check `resultsByKey.size >= limit * 2` → stop; take next job; `await searchFile(...)`; merge into `resultsByKey` exactly as today (including the shared-sessionId merge branch). Because workers check the cap before *starting* a job, the pool can slightly overshoot `limit * 2` (by at most pool-size − 1 in-flight results); that is acceptable — the overshoot only widens the candidate pool, and the final `slice(0, limit)` still applies. Do not introduce worker threads or any external process; this stays a pure Node streamer on the main process.

4. **Unchanged**: the hydration loop (scan-and-upsert of unindexed sessions), `scoreResult` ranking, `results.sort` + `slice(0, limit)`, `DEFAULT_LIMIT = 50`, `DEFAULT_MATCHES_PER_SESSION = 5`, literal-by-default `buildMatcher`.

**New ordering contract (intended change, not a regression):** the `limit * 2` candidate pool is now filled from the most-recently-modified transcripts across both roots, interleaved by mtime rather than "all Claude in walk order, then all Codex". Final on-screen ordering is still `scoreResult` descending — but the *population* the score ranks over shifts toward recent sessions. A stale session with many matches that previously appeared (only because walk order reached it inside the first 100 candidates) may drop out in favor of recent sessions. This is the desired behavior; do not "fix" it back.

## Tests

Boy-scout rule applies: every touched file gains or extends a test. Vitest note: `better-sqlite3` in this tree is rebuilt for the **Electron ABI** by postinstall (`deepSearch.ts` header comment; spec 030 risks section) — it is expected to fail to load under Vitest's plain-Node `main` project. The FTS test plan below is structured so the regression net does not depend on loading it, with a real-DB integration test attempted as a bonus.

### Item 5 — `src/renderer/src/components/SessionBrowser/index.test.tsx` (extend existing file)

Renderer project, real store, controllable fake ipc via the existing `tests/mockIpc.ts` `installMockIpc()` pattern (see the existing deep-mode tests in this file for the setup shape).

New test: **"discards an in-flight deep-search response after the query is cleared"**:

1. `let resolveSearch!: (r: SessionSearchResult[]) => void` and `ipc.invoke.mockImplementation(() => new Promise((res) => { resolveSearch = res }))` — a deferred the test controls.
2. Render, click the `Deep` mode button, type `needle` into `Search sessions...`.
3. `await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('sessions:search-deep', { query: 'needle' }))` — the request is now in flight and unresolved.
4. Clear the input (`user.clear(...)`), then `await waitFor` for the empty-query prompt `'Type to search across all transcript content.'` — proves the empty branch of `runDeepSearch` has run (300ms debounce elapsed).
5. Now resolve the stale request: `resolveSearch([result])` (reuse the `SessionSearchResult` fixture shape already in this file); `await` a microtask flush.
6. Assert the stale result never renders: `expect(screen.queryByText('1 match')).toBeNull()` and the empty-query prompt is still present.

This test fails against current code (stale results replace the prompt) and passes with the one-line fix.

### Item 7 — `src/main/sessions/ftsQuery.test.ts` (new, main project) + optional integration

Pure unit tests over `toFtsMatchExpression` — these are the primary regression net and run under plain Node:

- `toFtsMatchExpression('foo')` → `'"foo"'`
- `toFtsMatchExpression('foo bar')` → `'"foo" "bar"'` (multi-term AND preserved)
- `toFtsMatchExpression('C:\\Code\\multiagent')` → `'"C:\\Code\\multiagent"'` (colon neutralized)
- `toFtsMatchExpression('say "hello"')` → `'"say" """hello"""'` (internal quotes doubled)
- `toFtsMatchExpression('foo AND')` → `'"foo" "AND"'` (keyword becomes a literal term)
- `toFtsMatchExpression('  ')` → `null`; `toFtsMatchExpression('')` → `null`
- Adversarial set produces some quoted output without throwing: `'"unbalanced'`, `'-foo'`, `'foo(*'`, `'NEAR('`, `'a:b:c'`

**Integration test against a real in-memory index** — `src/main/sessions/SessionIndex.integration.test.ts`:

1. Prerequisite refactor: give `SessionIndex` an injectable path — `constructor(dbPath: string = DB_PATH)` — and make the `app.getPath('userData')` module-level constant lazy (compute inside the default-argument path or a `defaultDbPath()` helper) so importing the module under `vi.mock('electron', ...)` works. Production call sites pass nothing.
2. The test constructs `new SessionIndex(':memory:')`, upserts 2-3 `ScannedSession` fixtures (one with `cwd`/`firstMessage` containing a Windows path), then asserts: `search('C:\\Code\\multiagent')` returns the matching row without throwing; the full adversarial query set from the unit tests returns arrays (never throws); `search('foo bar')` matches only rows containing both terms; `search('')` returns all rows.
3. **Decision rule:** if `better-sqlite3` fails to load under the Vitest node project with an ABI/NODE_MODULE_VERSION error, do not fight it — delete the integration test file and instead add the adversarial-query assertions to the Playwright e2e suite (`e2e/`, which runs the compiled Electron app and already exercises "the real SQLite FTS index" per CLAUDE.md): drive `sessions:search` invokes with the adversarial queries and assert none reject. The pure `ftsQuery.test.ts` suite remains mandatory either way.

Also add `searchLike`-shape coverage: with correct escaping the fallback is unreachable through `search()`, so test the token→`LIKE`-pattern escaping (`%`, `_`, `\` in input) as a pure helper if you extract one, or exercise `searchLike` directly in the integration test.

### Item 12 — `src/main/sessions/DeepSearcher.integration.test.ts` (new, main project) + `deepSearch.test.ts` (extend)

`DeepSearcher` itself only *imports the type* of `SessionIndex` — construct it with a minimal stub object (`{ upsert: vi.fn(), get: vi.fn(...) }` plus stub scanners) so no better-sqlite3 load is needed. Build fixture transcript trees in a temp dir (`fs.mkdtempSync`), point `os.homedir` / `CODEX_HOME` at it (`vi.spyOn(os, 'homedir')`; note `codexRoot()` honors `CODEX_HOME` — use it for the Codex root). Determinism per CLAUDE.md: pin the clock with `vi.setSystemTime` (scoreResult reads `Date.now()`) and pin file mtimes with `fs.utimesSync`.

- **Early termination (behavioral cap + resolution):** a Claude fixture (UUID filename) with 20 matching lines → result has exactly `matchesPerSession` (default 5) matches and the search promise resolves. Same for a Codex fixture whose line 1 is a valid `session_meta` record — asserts the sessionId-before-termination invariant holds (result carries the meta's `payload.id`, not empty).
- **Early termination (I/O assertion):** the behavioral test can't see whether the stream drained. Either spy on `fs.createReadStream` and assert the returned stream's `destroyed === true` after the search resolves for the capped file, or write a large fixture (matches only in the first 10 lines of ~50k lines) and assert `stream.bytesRead`-style evidence via the spy. The spy approach is simpler; use it.
- **mtime ordering beats walk order:** create `limit * 2 + N` matching single-session fixtures (pass a small `limit` like 3 in the request to keep the fixture count tiny — e.g. 6-candidate pool, 8 fixtures) where the files that sort *first* alphabetically/by-walk are given **old** mtimes via `fs.utimesSync`, and the last-walked files are newest. Assert the newest sessions appear in results and the oldest (beyond the pool) do not. This test fails against current sequential walk-order code.
- **Concurrency pool correctness:** with more files than `SEARCH_CONCURRENCY`, results are identical (same set, same order) to expectations computed from fixtures — asserts the pool merges into `resultsByKey` without dropping or duplicating; include two Codex files sharing a sessionId to keep the merge branch covered.
- **Caps unchanged:** existing `deepSearch.test.ts` constants/ranking tests stay green; add an assertion pinning `DEFAULT_LIMIT === 50`, `DEFAULT_MATCHES_PER_SESSION === 5`, and `SEARCH_CONCURRENCY` within `[4, 8]` so the handoff caps are test-enforced.

## Risks

- **Deep-search result population changes by design.** The mtime-desc candidate pool means old sessions that only surfaced because walk order reached them early can drop out. Spell this out in the PR description. The ordering contract after this spec: *candidate pool = the `limit * 2` most-recently-modified matching transcripts (both agent kinds interleaved by mtime); displayed order = `scoreResult` descending over that pool, top `limit`.* Any future complaint of "an old session stopped appearing in deep search" is this contract working as intended, not a regression.
- **Escaping must not break legitimate multi-term searches.** Tokenize-then-quote preserves implicit-AND multi-term behavior exactly (`foo bar` → `"foo" "bar"`). What is intentionally lost: user-typed FTS operators (`OR`, `NEAR`, column filters, `term*` prefix queries) now match literally. Nothing in the UI documents or encourages operator syntax today, and the deep-search mode is the power-search path, so this is acceptable — but do not partially preserve operators (e.g. special-casing `*`); a half-literal grammar is worse than a fully literal one.
- **FTS5 quoted-string semantics:** a quoted string is still tokenized by the FTS tokenizer, so `"C:\Code\multiagent"` matches rows via the tokens the default unicode61 tokenizer produces from that string — this is the same tokenization applied at index time, so literal matching remains consistent. Verify with the integration/e2e test rather than assuming.
- **Early termination resolves via `rl.close()`:** if a future refactor removes the `'close'` → `finish()` wiring, capped files would hang the search promise. The behavioral test above (capped file still resolves with 5 matches) pins this.
- **Concurrency pool + hydration:** `searchFile` is read-only, so 6 concurrent streams are safe; hydration (`index.upsert`) stays in the sequential post-pass exactly as today — do not move upserts into the pool (better-sqlite3 is synchronous and single-connection).
- **Stat-per-file cost:** the added `stat` pass is one syscall per transcript, trivially cheaper than the full-file reads it prevents. On network-mounted homedirs it adds latency; acceptable for an explicit user-triggered deep search.
- **`SessionIndex` constructor change** (injectable path, lazy `app.getPath`) touches every construction site — there is one, in `handlers.ts`. Keep the default-argument form so production code is unchanged.

## Verification Steps

1. `npm run typecheck` and `npm test` green; new tests fail when their fix is reverted (verify at least the item-5 test and the mtime-ordering test red-green).
2. Manual, item 5: open Session Browser (`Ctrl+Shift+O`), switch to Deep, type a query that takes a moment (large transcript corpus), clear the input immediately — the empty-state prompt must remain; no results flash in afterward.
3. Manual, item 7 (mirrors backlog verification list): in Summary mode type `C:\Code\multiagent`, `foo AND`, and `"unbalanced` — the list filters (or shows empty) without the search silently dying; confirm no `SqliteError` in the main-process console. Type `foo bar` and confirm multi-term AND filtering still works.
4. Manual, item 12: run a deep search for a common word in a corpus with many sessions; confirm recently active sessions appear in results. With dev tools timing (or a temporary log), confirm the search completes noticeably faster on large transcripts (early termination) and that snippets/roles/timestamps render as before.
5. `npm run test:e2e` green (session browser and FTS index surfaces are e2e-covered).

## Handoff Contract

### Non-negotiables

- **Deep search stays a pure Node streamer.** No PATH-provided `rg`, no child processes, no worker threads. `fs.createReadStream` + `readline` per file, in the main process.
- **Result caps stay:** 50 sessions (`DEFAULT_LIMIT`), 5 matches per session (`DEFAULT_MATCHES_PER_SESSION`). The `limit * 2` candidate-pool multiplier stays.
- **Literal mode stays the default** for deep search; `caseSensitive` and `regex` remain opt-in per `SessionSearchRequest`. Summary search becomes *strictly* literal (tokenized, quoted); no operator grammar is exposed anywhere.
- **`SessionIndex.search` remains summary-only FTS5** over `projectName`/`displayName`/`firstMessage`/`lastMessage` — do not expand it toward transcript content; that is `DeepSearcher`'s job.
- **The Session Browser generation counter remains the sole staleness mechanism** — do not add AbortController/cancellation IPC as part of this spec.
- **No IPC channel signature changes.** `sessions:search` and `sessions:search-deep` keep their `src/shared/types.ts` shapes.
- Concurrency is a small fixed pool (4-8); do not make it configurable or adaptive in this spec.

### Definition of Done

- All three fixes implemented as specified; line-level behavior of everything else in the three files unchanged.
- New tests from the Tests section exist and pass: the stale-response renderer test, the `ftsQuery` unit suite (mandatory) plus either the real-DB integration test or its e2e substitute per the decision rule, and the DeepSearcher early-termination / mtime-ordering / concurrency / caps tests.
- `npm run typecheck`, `npm test`, `npm run test:e2e` all green.
- Manual verification steps 2-4 performed on Windows.
- This spec moved to `specs/done/036-...` (same number) or folded into CLAUDE.md per the living-document rule; items 5, 7, 12 marked done or removed in `specs/pending/032-code-improvement-backlog.md`.

## Out of Scope

- Backlog item 3 (prepared-statement hoisting / `upsertMany`) and item 4 (`cwdExists` stat memoization) — same file, separate perf items.
- Backlog item 38 (deduplicating `walkJsonlFiles`/`deriveProjectName` across scanners) — keep the new walk signature dedup-friendly but do not perform the consolidation here.
- Backlog item 41 (FTS index rebuilt on every launch / `PRAGMA user_version` guard) — adjacent to `migrate()` but independent.
- Search-result cancellation IPC, streaming/progressive deep-search results, or match highlighting changes.
- Any FTS operator grammar (explicit OR, prefix `*`, phrase search) for summary or deep search.
- Typed `window.ipc` bridge (backlog items 20/27) — tests keep the existing `as SessionSearchResult[]` casts.
