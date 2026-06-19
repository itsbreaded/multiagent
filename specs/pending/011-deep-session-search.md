# 011 - Deep Session Search

## Problem

The Session Browser search looks like a global conversation search, but it only filters the already-loaded session summaries in the renderer. That means it can match project name, agent kind, display name, first user message, and last user message, but it cannot find text from the middle of a Claude or Codex conversation.

Users need "grep-like" search across saved agent transcripts: find a remembered phrase, tool output, error, file path, or model response, then jump back to the matching Claude/Codex session.

## Research Notes

Local repo and filesystem:

- `CLAUDE.md` already documents `SessionIndex` as the durable session index and says `TranscriptScanner` reads `~/.claude/projects/**/*.jsonl` while `CodexSessionScanner` reads `~/.codex/sessions/**/*.jsonl`.
- On this machine, `C:\Users\cdhan\.claude\projects` has 12 project directories and 844 `.jsonl` files.
- On this machine, `C:\Users\cdhan\.codex\sessions` has 217 `.jsonl` files under date directories and `C:\Users\cdhan\.codex\session_index.jsonl` exists.
- Claude records observed locally include `type`, `message`, `timestamp`, `cwd`, `sessionId`, and `gitBranch`. User messages may have `message.content` as a string or content array.
- Codex records observed locally include `session_meta`, `response_item`, `event_msg` with `payload.type === 'user_message'`, and `turn_context`.
- `rg.exe` is available on this development machine through the installed Codex package, but the app does not currently package ripgrep or declare it as a dependency. Do not assume production users have `rg` on `PATH`.

External references checked:

- Claude Code conversation history is commonly stored as JSONL under `~/.claude/projects/`, and third-party history tools import those files into SQLite/FTS for search. Source: https://dev.to/kuroko1t/i-built-a-tool-to-stop-losing-my-claude-code-conversation-history-5500
- A Codex CLI issue from April 29, 2026 documents valid local sessions under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and notes that direct resume by session ID can work even when the picker/index is stale. Source: https://github.com/openai/codex/issues/20165
- Codex session guides describe JSONL transcript files under `~/.codex/sessions/` containing prompts, model responses, tool calls, and tool results. Source: https://www.verdent.ai/guides/codex-cli-resume-continue-save-chat
- ripgrep recursively searches directories, supports Windows/macOS/Linux, and supports JSON Lines output through `--json`. Sources: https://github.com/BurntSushi/ripgrep and https://docs.rs/crate/ripgrep/11.0.2/source/complete/_rg

## Current Behavior

Indexing:

- `src/main/sessions/SessionIndex.ts` stores one row per session in `session-index.db`.
- `sessions_fts` currently indexes only `projectName`, `displayName`, `firstMessage`, and `lastMessage`.
- `SessionIndex.search(query)` performs an FTS query, but it is not used by `SessionBrowser`.
- `TranscriptScanner` and `CodexSessionScanner` stream JSONL files and extract summary metadata, not full searchable content.

Renderer:

- `src/renderer/src/components/SessionBrowser/index.tsx` calls `useSessions()`, then `search(query)`.
- `src/renderer/src/hooks/useSessions.ts` implements `search(query)` as an in-memory filter over loaded summaries.
- `src/renderer/src/store/sessions.ts` has `searchSessions(query)` that can call `sessions:search`, but the browser component does not use it.

IPC:

- `src/shared/types.ts` exposes `sessions:search` as `(query: string) => Session[]`.
- Returning only `Session[]` is not enough for deep search because the UI needs matching snippets, transcript path, line number, and result counts.

## Intended Behavior

Session Browser search should support two result modes:

1. Summary search for empty or short metadata-style filtering.
2. Deep search for full transcript matches across Claude and Codex JSONL files.

Deep search should:

- Search both Claude and Codex transcript roots.
- Return grouped session results with ranked matches and snippets.
- Hydrate matches back to indexed session metadata by `agentKind + sessionId`.
- Include enough result context for the user to know why a session matched.
- Keep all searching local. No transcript content leaves the machine.
- Avoid blocking the renderer on large transcript sets.
- Work when Codex's own `session_index.jsonl` is stale, because transcript files are the source of truth.

## Search Model

Add a richer result type instead of overloading `Session[]`:

```ts
export interface SessionSearchRequest {
  query: string
  mode?: 'summary' | 'deep'
  agentKinds?: AgentKind[]
  cwd?: string
  limit?: number
  matchesPerSession?: number
  caseSensitive?: boolean
  regex?: boolean
}

export interface SessionSearchMatch {
  transcriptPath: string
  lineNumber: number
  timestamp: string | null
  role: 'user' | 'assistant' | 'tool' | 'system' | 'unknown'
  snippet: string
  rawLinePreview?: string
}

export interface SessionSearchResult {
  session: Session
  score: number
  matchCount: number
  matches: SessionSearchMatch[]
}
```

Deep search should return `SessionSearchResult[]`, not mutate the main `sessions` list.

## Implementation Phases

### Phase 1 - Shared Types And IPC

Add IPC channels:

```ts
'sessions:search-deep': (request: SessionSearchRequest) => SessionSearchResult[]
'sessions:search-cancel': (requestId: string) => void
```

If cancellation is not needed in the first pass, still include a request id internally so stale renderer results can be ignored.

Keep `sessions:search` temporarily for compatibility, but make Session Browser use the new typed request. The old channel can remain summary-only until a later cleanup.

### Phase 2 - Transcript Path Registry

Add main-process helpers that know the canonical search roots:

- Claude: `path.join(os.homedir(), '.claude', 'projects')`
- Codex: `path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions')`

The helpers should:

- Return roots that exist and are readable.
- Scope file search to `*.jsonl`.
- Avoid following symlinks unless there is an explicit reason.
- Attach `agentKind` from the root, not from filename shape alone.
- Use the existing scanners/index to map transcript path back to `Session`.

### Phase 3 - Search Engine Choice

Preferred first implementation: package a small ripgrep binary and spawn it from main with `execFile`/`spawn`.

Reasons:

- It matches the requested "grep-like" operating-system search model.
- It is fast for many JSONL files and large transcripts.
- `--json` gives parseable events with path, line number, submatches, and context.
- It avoids stuffing every line of every transcript into SQLite during the first implementation.

Implementation requirements:

- Do not depend on `rg` being available on `PATH`.
- Add platform-specific packaging for the binary or a dependency that reliably exposes it.
- Use `execFile`/`spawn` with an argument array, never string-built shell commands.
- Pass roots and globs as args, not through shell interpolation.
- Use a timeout and result limit.
- Treat exit code `1` as "no matches", not failure.
- Add a pure Node fallback streamer for environments where the packaged binary cannot run.

Candidate ripgrep flags:

```text
--json
--line-number
--context 1
--glob *.jsonl
--fixed-strings by default
--ignore-case unless caseSensitive is true
--regexp <query>
<claudeRoot> <codexRoot>
```

Only enable regex mode when the user explicitly requests it. Default search should be literal text so user input like `foo.bar()` does not become accidental regex.

### Phase 4 - JSONL-Aware Match Hydration

Raw grep lines are JSON strings, so snippets need cleanup before display.

For each matching line:

1. Parse the JSONL record.
2. Determine agent-specific metadata:
   - Claude: `sessionId`, `timestamp`, `type`, `message.role`, `message.content`, `cwd`.
   - Codex: `payload.id` on `session_meta`; later records need session id from file-level metadata, `timestamp`, `type`, `payload.type`, `payload.role`, `payload.message`, `payload.content`.
3. Extract display text from known fields.
4. If the matched line is a tool result or structured payload, produce a compact text preview without dumping huge JSON.
5. Group matches by `agentKind + sessionId`.
6. Hydrate the `Session` row from `SessionIndex`; if missing, scan and upsert that specific file before returning the result.

For Codex files, read the first `session_meta` record once per file and cache `{ sessionId, cwd }` during a search. Do not parse every prior line repeatedly for every match.

### Phase 5 - Ranking And Limits

Ranking should be simple and predictable:

- Exact session metadata match beats transcript body match.
- More recent sessions rank higher when scores tie.
- User and assistant message matches rank higher than tool payload matches.
- Multiple matches in one session increase score, but cap the boost to avoid giant tool logs dominating.

Limits:

- Default result limit: 50 sessions.
- Default matches per session: 5.
- Hard max returned snippet length: 500 characters.
- Hard max raw line preview: 1,000 characters, only for debugging or unknown record shapes.
- Stop collecting once enough grouped results are found, but be careful not to terminate ripgrep before reading process errors/close cleanly.

### Phase 6 - Session Browser UI

Keep the existing overlay language from `CLAUDE.md`.

UI changes:

- Add a compact mode toggle or segmented control for `Summary` / `Deep`.
- Keep summary mode instant and local.
- Debounce deep search input, initially 250-300ms.
- Show a small "Searching..." state for deep searches.
- Show grouped results by project/session, not raw files first.
- Render match snippets under each session row with timestamp/role badges where available.
- Let the user expand a result to see first/last message plus matched snippets.
- Preserve existing actions: resume in split, resume in new tab, repair missing directory.

Do not expose transcript file paths as the primary label. They can appear in details or a copy/debug affordance later.

### Phase 7 - Optional SQLite FTS Upgrade

After the ripgrep-backed implementation works, consider indexing normalized transcript messages into SQLite FTS5:

```sql
CREATE TABLE session_messages (
  agentKind TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  transcriptPath TEXT NOT NULL,
  lineNumber INTEGER NOT NULL,
  timestamp TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  recordType TEXT,
  PRIMARY KEY(agentKind, sessionId, transcriptPath, lineNumber)
);
```

This would make repeated search faster and enable better ranking/snippets, but it has higher storage and migration risk. Keep it out of the first implementation unless ripgrep spawning proves too brittle.

## Risks

- Transcript JSONL formats are not stable public contracts. Keep parsers tolerant and preserve an unknown-record fallback.
- Grepping raw JSON can match escaped text or structural keys. Hydration must parse records and display extracted text, not raw JSON by default.
- Tool results can be huge and noisy. Limit snippets and rank them lower than human/model messages.
- Packaged ripgrep adds platform packaging work. If not handled, production builds will work on the developer machine but fail elsewhere.
- Searching every keystroke can spawn too many processes. Debounce and cancel/ignore stale requests.
- Claude history may be deleted externally. Search should handle missing files without breaking the whole request.
- Codex `session_index.jsonl` can be stale. Deep search should rely on transcript files and use the index only for display names when available.
- The existing `SessionIndex.search` name may mislead future work because it is summary FTS only. Rename or document boundaries during implementation.

## Verification

Automated checks:

- `npm run typecheck`
- Unit-test query arg construction so paths/queries with spaces, quotes, regex characters, and backslashes are passed safely.
- Unit-test Claude text extraction for string content and array content.
- Unit-test Codex text extraction for `event_msg user_message`, `response_item message`, and unknown payloads.
- Unit-test grouping by `agentKind + sessionId` with duplicate session ids across agents.

Manual scenarios:

- Search for a phrase known to appear only in the middle of a Claude transcript.
- Search for a phrase known to appear only in the middle of a Codex transcript.
- Search for text containing regex punctuation in default literal mode.
- Toggle regex mode and confirm the same query can intentionally behave as regex.
- Search while typing quickly and confirm stale results do not replace newer results.
- Search with `~/.claude/projects` missing, then with `~/.codex/sessions` missing.
- Search with a missing cwd session and confirm repair/resume behavior remains unchanged.
- Package or run the built app in an environment where `rg` is not on `PATH` and confirm deep search still works through the packaged binary or Node fallback.

## Handoff Contract

Non-negotiables:

- Deep search must cover both Claude and Codex transcript roots.
- Do not rely on the user's global `rg` installation or the Codex package's private `rg.exe`.
- Do not send transcript content to any external service.
- Default query mode must be literal, not regex.
- Parse JSONL for displayed snippets; do not show raw JSON as the normal result.
- Keep renderer responsive through debounce, stale-result protection, and main-process search execution.
- Keep existing session resume and missing-directory repair actions available from search results.

Definition of done:

- Session Browser can find text from anywhere in saved Claude and Codex conversations.
- Results show session metadata plus useful snippets from matching transcript lines.
- Search works without PATH-provided ripgrep, either through a packaged binary or a verified Node fallback.
- Typecheck passes.
- The implementation updates `CLAUDE.md` with the durable search architecture once code and packaging behavior are verified.

## Open Decisions Before Implementation

1. Should deep search ship first with packaged ripgrep plus Node fallback, or should the first implementation skip ripgrep and extend SQLite FTS to message-level indexing immediately?
2. Should tool output be searchable by default, or should the first UI expose a filter such as `Messages only` / `All transcript text`?
3. Should exact match snippets include one line of before/after context, or should context stay hidden until the result row is expanded?
