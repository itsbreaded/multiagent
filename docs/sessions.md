# Sessions: indexing, detection & repair (mechanism)

The why/how behind session search, session-id detection, cwd repair, and the startup-resume /
shutdown-state flow. The one-line guardrails live in `CLAUDE.md`. The hook-based session-id
**linking** mechanism — the one scoped exception to "don't mutate agent config" — is a deep
dive in [`docs/session-linking-hooks.md`](session-linking-hooks.md); this doc covers everything
else session-related.

---

## Session indexing

`SessionIndex` wraps better-sqlite3 with FTS5 for full-text search over session transcripts.
`TranscriptScanner` reads `~/.claude/projects/**/*.jsonl` and `CodexSessionScanner` reads
`~/.codex/sessions/**/*.jsonl`; both extract metadata into the same index. Sessions are polled
every 5 seconds and pushed to the renderer on change. Closing an agent pane with a known
`sessionId` also triggers an immediate `sessions:refresh` scan so the session can move from
the live pane list to Recent without waiting for the next poll.

`SessionIndex.search(query)` is summary-only FTS5 over `projectName`, `displayName`,
`firstMessage`, and `lastMessage`. It is **not** a full transcript search.

## Deep transcript search

`DeepSearcher` (`src/main/sessions/DeepSearcher.ts`) implements full transcript search via a
pure Node.js streamer (no PATH-provided `rg`). It walks both Claude and Codex JSONL roots,
reads each file line-by-line, matches each line against the query, parses matching lines to
extract human-readable text (not raw JSON), groups results by `agentKind:sessionId`,
hydrates from `SessionIndex` (scans and upserts unindexed files on demand), ranks by role
quality + recency + match count, and caps at 50 sessions / 5 matches per session. The IPC
channel is `sessions:search-deep` (invoke, receives a `SessionSearchRequest`, returns
`SessionSearchResult[]`). Default mode is literal (not regex); `caseSensitive` and `regex`
flags are opt-in per request.

Session Browser UI has two modes: **Summary** (instant in-memory filter over loaded metadata)
and **Deep** (300ms debounced call to `sessions:search-deep`). Deep mode shows match snippets
inline under each session row with role badges (user/assistant/tool) and timestamps. Stale
results are discarded via a generation counter — a new query increments the counter and any
response from an older generation is dropped.

## Session cwd repair

Session cwd corrections are app-owned metadata first. `SessionIndex` keeps per-session cwd
overrides in SQLite and applies them during scanner upserts so a repaired directory is not
undone by the 5s transcript rescan. Session rows include `cwdExists`; UI should mark missing
directories as severed/recoverable. Missing cwd repair is project-level: all sessions from the
old cwd move together. Claude Code is directory-scoped, so repairing a Claude cwd
copy/merges the old `~/.claude/projects/<encoded-old-cwd>/` transcript directory into the new
encoded cwd directory and updates indexed file paths. Do not rewrite whole transcript JSONL
files for normal repair; Codex does not need transcript copying for cwd changes.

Directory repair also rewrites app-owned layout state. `sessions:repair-cwd` applies a
prefix-aware, segment-boundary mapping to `layout.json` (`PaneLeaf.cwd`,
`PaneLeaf.sessionDetectionCwd`, and `Tab.defaultCwd`), writes a timestamped `layout.json.bak.*`,
atomically replaces the layout file, and broadcasts `layout:cwd-repaired` so live
primary/detached renderer stores apply the same mapping before the next layout save. (The
pure path-mapping logic is `src/shared/cwdRepair.ts` — extracted to be tested.)

## Session detection (id assignment)

`SessionSpawner` assigns a session id at launch for Claude only: new Claude panes generate a
UUID and launch `claude --session-id <uuid>`, so the renderer receives the session id
immediately. App-launched Codex is linked by the managed `SessionStart` hook (spec 047 phase
4 — see `docs/session-linking-hooks.md`) — the user accepts the managed hook once via
`codex /hooks` and the persisted trust covers every future launch; there is **no** launch-time
codex id and **no** cwd/time file-poll scanner (deleted in phase 4). `codex resume` forks are
handled because each `SessionStart` re-reports via the hook.

CLI-launched agents (typed `claude`/`codex` inside a shell pane) are detected by the
`AgentProcessSweeper` and the shell pane is promoted to an agent pane; when the agent exits it
demotes back to a shell. That detection/promotion mechanism is in
`docs/pty-and-terminals.md`; the id **linking** that follows is in
`docs/session-linking-hooks.md`.

### Detection constraints (non-hook)

- Do not reintroduce Claude filesystem matching for new panes; preserve the launch-time
  `--session-id` path unless Claude removes that flag. (Filesystem matching for CLI-launched
  agents was also removed in phase 4 — hooks cover it.)
- Do not reintroduce the Codex cwd/baseline/time file-poll scanner (`codexDetection.ts`) or
  the `SessionSpawner` Codex pending-detection machinery. The managed hook is the sole
  session-id source for Codex; do not add a scanner "fallback" — that re-introduces the
  ambiguity/first-message-gate problems hooks remove. One mechanism.
- App-launched Codex does **not** bypass hook trust — it relies on the same one-time
  `codex /hooks` trust as CLI-launched Codex. Do not add `--dangerously-bypass-hook-trust` to
  the launch command; do not try to bypass trust programmatically (herdr doesn't either).
- Startup should default to resume. Do not reintroduce a restore prompt unless explicitly
  requested.
- New agent panes persist `sessionDetectionState`, `sessionDetectionStartedAt`, and
  `sessionDetectionCwd` while detection is pending. On startup, panes with a pending marker
  and no `sessionId` may recover only from an exact single cwd/time transcript match;
  otherwise they remain visible as agent recovery placeholders. Legacy agent panes with no
  `sessionId` and no pending marker are still converted back to shell panes.
- `hydrateTabRuntime` calls `sessions:validate(agentKind, sessionId, cwd)` before
  `session:resume`. If the transcript is missing, the pane gets `resumeError` and no CLI
  process is spawned. This prevents repeated doomed-spawn loops on startup when a session was
  deleted or moved.

## MCP injection (process-scoped only)

The app must not mutate user or project agent config files. Do not write to `~/.claude.json`,
`~/.codex/config.toml`, `.mcp.json`, or similar files as part of startup. MCP injection is
process-scoped only. The **one scoped exception** — installing managed `SessionStart` hooks
for session linking — is documented in `docs/session-linking-hooks.md`.

`BrowserMcpServer.startHttp()` exposes the browser MCP server. Both Claude and Codex should
use the streamable HTTP endpoint at `http://127.0.0.1:{port}/mcp` via templates in
`src/main/mcp/templates/`:

- `claude-mcp.json` - JSON config for Claude Code, with `{port}` replaced at runtime.
- `codex-mcp.toml` - TOML snippet for Codex CLI config overrides, with `{port}` replaced at
  runtime.

`McpInjector` resolves these templates on startup. Claude Code on Windows requires a real
file path for `--mcp-config`; inline JSON is unreliable and has been observed to be treated as
a mangled file path. Therefore Claude uses a PID-scoped temp file under `%TEMP%`, passed as
`--mcp-config <path>` (no `--strict-mcp-config`), and cleaned up by `McpInjector`. Omitting
`--strict-mcp-config` is intentional — it allows Claude to still load user-level and
project-level MCP servers from its normal config locations alongside the injected browser
server. Codex does not need a temp file. It receives the MCP server process-scoped through
CLI `-c` overrides generated from the template, along with the TUI flags noted in
`docs/pty-and-terminals.md`.

## Browser Panel (MCP)

`BrowserViewManager` embeds a `BrowserView` that an MCP server (`BrowserMcpServer`, server
name `multiagent-browser`) controls via neutral primitive tools in `src/main/mcp/tools/`
(navigate, click, click_text, click_at, type, hover, hover_at, keyboard, select, scroll,
screenshot, get_content/url/elements/links, evaluate, wait_for/wait_for_text/wait_for_load,
set_cookies). The renderer shows/hides it via `browser:toggle`. The tool surface and
recommended selection order are documented with the MCP server itself — keep that list in sync
with `src/main/mcp/tools/`, not in `CLAUDE.md` or here. To override JS dialogs
(`alert`/`confirm`/`prompt`), use `browser_evaluate` to patch `window.confirm = () => true`
etc. after navigation.