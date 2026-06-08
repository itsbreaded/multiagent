# OpenAI Codex CLI — Session Tracking and Restoration Research

**Date:** 2026-06-07  
**Scope:** How Codex CLI handles session persistence, resume, context management, and how this compares to Claude Code.

---

## 1. Overview

OpenAI Codex CLI has a mature, multi-layered session persistence system introduced progressively from mid-2025 (the `codex resume` command arrived in v0.36.0). Sessions are automatically saved to disk during every conversation, indexed in a local SQLite database, and resumable by ID, name, or shorthand flags. The system supports interactive sessions, non-interactive/scripted sessions, session forking/branching, cross-surface portability (CLI, Desktop, VS Code extension, web), and context compaction for long-running tasks. This is functionally analogous to — and in some areas more feature-complete than — Claude Code's session persistence model.

---

## 2. Session Storage Mechanism

### 2.1 File Locations

| Platform     | Sessions Directory                                           |
|--------------|--------------------------------------------------------------|
| macOS/Linux  | `~/.codex/sessions/YYYY/MM/DD/`                              |
| Windows      | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\`                  |
| WSL          | `~/.codex/sessions/YYYY/MM/DD/`                              |

The base directory (`CODEX_HOME`) defaults to `~/.codex` and can be overridden via the `CODEX_HOME` environment variable.

### 2.2 Rollout Files (Primary Session Store)

Each session is saved as a **rollout file** — a newline-delimited JSON (JSONL) file with the naming pattern:

```
rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
```

These are referred to as "rollout files" because they record every event in the agent loop in sequence.

**Compression:** Cold (inactive) rollout files are automatically compressed using Zstandard (`.zst`). When a session is resumed and needs to be extended, the system transparently decompresses the file back to plain `.jsonl` before writing.

**Rollout item types recorded:**

| Type | Contents |
|---|---|
| `ResponseItem` | Raw model responses, tool call invocations |
| `EventMsg` | Protocol events: user/agent messages, token counts, lifecycle markers |
| `SessionMeta` | Session-level attributes: ID, CWD, model provider, CLI version |
| `TurnContext` | Per-turn settings snapshot: model, approval policy, sandbox policy |
| `Compacted` | Summarized items from history compaction operations |

**Persistence modes (configurable):**

- **Limited** (default): Records only essential items — `UserMessage`, `AgentMessage`, `TokenCount`
- **Extended**: Also captures diagnostic events like shell command output and MCP tool call I/O

Large payloads (e.g., command output) are truncated to 10,000 bytes.

**Ephemeral mode:** The `--ephemeral` flag on `codex exec` prevents any rollout files from being written. Sessions run without persistence.

### 2.3 SQLite Index (state_5.sqlite)

A SQLite database at `~/.codex/state_5.sqlite` (Windows: `%USERPROFILE%\.codex\state_5.sqlite`) serves as the query layer for session discovery. It stores per-session metadata:

- `id` (UUID v7 — the thread identifier)
- `title` (derived from first user message or explicit `/title` command)
- `cwd` (working directory)
- `rollout_path` (path to the JSONL file on disk)
- `archived` flag
- `updated_at` / `updated_at_ms` timestamps
- `git_sha`, `git_branch`, `git_origin` (Git context at session start)
- `token_usage` (from `TokenCount` events)
- `forked_from_id` (parent session UUID if forked)

On startup, a **backfill operation** scans rollout files on disk and synchronizes the SQLite index with the filesystem. This means the SQLite index can be rebuilt from the raw JSONL files if damaged.

### 2.4 session_index.jsonl

A lighter supplementary index file at `~/.codex/session_index.jsonl` stores session metadata (`id`, `thread_name`, `updated_at`) for quick lookups. If this file drifts out of sync with the JSONL rollout files and the SQLite database, sessions can become "hidden" or appear with stale titles in the Desktop UI (a documented known issue on Windows).

### 2.5 history.jsonl

A separate flat file `~/.codex/history.jsonl` stores session transcripts in a simpler format (configurable via `config.toml`):

```toml
[history]
persistence = "save-all"   # or "none" to disable
max_bytes = 104857600      # 100 MiB cap; drops oldest entries when exceeded
```

### 2.6 Asynchronous Writing

The `RolloutRecorder` manages disk I/O via a background `RolloutWriterTask`, so writing session events does not block the agent loop. Commands to the writer include `AddItems`, `Persist`, `Flush`, and `Shutdown`.

---

## 3. Session Identifiers

Each session receives a **UUID v7** identifier generated at session start. This `thread_id` (also called `session_id` informally) is:

- Embedded inside the rollout JSONL file itself (in `SessionMeta` items)
- Used as part of the rollout filename
- Stored in the SQLite `threads` table
- Exposed via `/status` inside an active session
- Used for all resume and fork operations

Additional identifiers tracked per-turn:
- `sub_id` — turn-scoped identifier
- `trace_id` — W3C trace context (for routing/diagnostics)
- `session_source` — surface origin (`CLI`, `TUI`, `Desktop`, etc.)

**Custom session IDs:** Users cannot manually assign session IDs via a CLI flag (this was a requested feature — see GitHub Issue #17782). The backend server generates the UUID automatically, partly to support server-side issue tracking.

**Named sessions:** While IDs are auto-generated, users can assign human-readable names to sessions (via `claude -n` equivalent: `-n` flag, `/rename`, or `/title` command) and resume by name rather than raw UUID.

---

## 4. Resume and Restore Capabilities

### 4.1 Interactive Resume (`codex resume`)

| Command | Behavior |
|---|---|
| `codex resume` | Opens interactive session picker (scoped to current CWD by default) |
| `codex resume --last` | Skips picker, resumes the most recent session from current directory |
| `codex resume <SESSION_ID>` | Resumes specific session by UUID |
| `codex resume --all` | Picker shows sessions from all directories, not just current CWD |
| `codex resume --cd <path>` | Override working directory when resuming |
| `codex resume --add-dir <path>` | Add extra project roots before resuming |

The session picker displays session title, token usage, git context, and timestamp. History is searchable via `Ctrl+R` in the composer.

### 4.2 Non-Interactive Resume (`codex exec resume`)

For scripted/CI use cases:

```bash
codex exec resume --last "Continue the refactor"
codex exec resume <SESSION_ID> "Fix the race condition"
```

### 4.3 In-Session Resume (`/resume` slash command)

Inside an active session, `/resume` opens the picker to switch to a different previous session mid-conversation.

### 4.4 Resume Mechanics

When a session is resumed:
1. Codex locates the rollout file (decompressing `.zst` if needed)
2. Validates that the `thread_id` has a materialized rollout before proceeding
3. `EventMsg` variants replay to reconstruct in-memory conversation history
4. The `ContextManager` repopulates the transcript and applies normalization
5. Context truncation policies are enforced for context window limits
6. A warning is emitted if the resumed session used a different model than current config

Multi-agent session topology is reconstructed via `thread_spawn_edges`, which tracks parent-child relationships between spawned sub-agents.

### 4.5 Session Forking (`codex fork`)

Forking creates a new thread branching from an existing session, leaving the original untouched:

| Command | Behavior |
|---|---|
| `codex fork` | Opens picker to select session to fork |
| `codex fork --last` | Forks most recent session |
| `codex fork <SESSION_ID>` | Forks specific session |
| `/fork` (in-session) | Forks current session from current point |
| `codex exec fork` | Non-interactive fork for automation |

Forking process:
1. Generates a new UUID for the new thread
2. Records `forked_from_id` metadata pointing to the parent session
3. Copies parent's history up to the fork point into a new rollout file
4. Parent rollout remains **unmutated**

Forked sessions are grouped under their root session in the picker UI.

### 4.6 Archive/Unarchive

Sessions can be archived to protect them from accidental resume or fork:

```bash
codex archive <SESSION_ID>
codex unarchive <SESSION_ID>
/archive   # in-session slash command
```

---

## 5. Context Management Across Turns and Restarts

### 5.1 Context Within a Session

- **`/compact`**: Summarizes the visible conversation to free tokens for long-running sessions. Can be manual or auto-triggered.
- **`/clear`**: Resets the visible transcript and starts fresh context within the same CLI session. Previous conversation is saved and resumable.
- **`/new`**: Starts a completely fresh session without clearing the terminal.
- **`/side`** (or `/btw`): Opens an ephemeral side conversation for a focused follow-up without disrupting the main thread.

### 5.2 Auto-Compaction

Auto-compaction triggers at approximately 95% context capacity (configurable via `model_auto_compact_token_limit` in `config.toml`). Two compaction paths exist:

- **Non-Codex models** (local compaction): Runs a local LLM summarization using a prompt visible in the open-source code. The summary is stored with a `_summary` prefix to prevent re-summarization loops. Rebuilds session with summary + recent messages (up to 20k tokens).
- **Codex models** (remote compaction): Calls OpenAI's remote `compact()` endpoint, which returns an AES-encrypted blob that only OpenAI's servers can interpret. This is an opaque server-side operation.

Compacted items are stored as `Compacted` type in the rollout file with a note on what was summarized.

The compaction prompt can be customized:
```toml
compact_prompt = "Focus on architecture decisions and API contracts"
experimental_compact_prompt_file = "~/.codex/compact-prompt.txt"
```

### 5.3 Context Management Configuration

```toml
model_auto_compact_token_limit = 180000   # tokens before auto-compaction fires
compact_prompt = "..."                    # custom summarization instructions
```

### 5.4 AGENTS.md — Persistent Project Context

Persistent project conventions and rules are stored in `AGENTS.md` files (global: `~/.codex/AGENTS.md`, per-project: `.codex/AGENTS.md` or `AGENTS.md` at repo root). These are automatically re-read at every session start and after every compaction, ensuring conventions survive context resets.

This is the equivalent of Claude Code's `CLAUDE.md`.

---

## 6. Cross-Surface Session Portability

All Codex surfaces (CLI, Desktop app, VS Code/Cursor extension, web) connect to a single **App Server** via a bidirectional JSON-RPC 2.0 API over stdio or WebSocket transport. This means:

- A session started in the terminal can be resumed in the Desktop app without any export/import
- Multiple clients can subscribe to the same thread simultaneously (they receive `turn/started` and `item/agentMessage/delta` events in real time)
- The CLI uses the same session store and UUIDs as the Desktop

**Limitation:** If the app-server was not running when a CLI session was created, the Desktop app may not see those sessions without a backfill scan.

---

## 7. CLI Flags and Config Options Summary

### CLI Flags

| Flag | Command | Effect |
|---|---|---|
| `--ephemeral` | `codex exec` | No session files written to disk |
| `--last` | `codex resume/fork` | Skip picker, use most recent session |
| `--all` | `codex resume/fork` | Show sessions from all directories |
| `--cd <path>` | `codex resume` | Override CWD on resume |
| `--add-dir <path>` | `codex resume` | Add project root on resume |
| `--json` | `codex exec` | Emit JSON Lines event stream to stdout |
| `-n <name>` | `codex` | Name the new session at startup |

### config.toml Options

| Key | Purpose |
|---|---|
| `history.persistence` | `save-all` or `none` |
| `history.max_bytes` | Cap on `history.jsonl` size |
| `model_auto_compact_token_limit` | Token threshold for auto-compaction |
| `compact_prompt` | Custom compaction summarization instruction |
| `experimental_compact_prompt_file` | Load compaction prompt from file |
| `sqlite_home` | Override SQLite database directory |
| `log_dir` | Directory for log files |
| `CODEX_HOME` (env var) | Override the entire `~/.codex` base directory |

---

## 8. Comparison to Claude Code

| Dimension | Codex CLI | Claude Code |
|---|---|---|
| **Session file format** | JSONL (`.jsonl` / `.jsonl.zst`) under `~/.codex/sessions/YYYY/MM/DD/` | JSONL under `~/.claude/projects/<project>/<session-id>.jsonl` |
| **Session index** | SQLite (`state_5.sqlite`) + `session_index.jsonl` | Internal session picker; sessions discoverable via filesystem |
| **Session identifier** | UUID v7, auto-generated | UUID, auto-generated |
| **Named sessions** | Yes — via `/title`, `/rename`, `-n` flag | Yes — via `-n`, `/rename`, `Ctrl+R` in picker |
| **Resume by ID** | `codex resume <UUID>` | `claude --resume <session-id>` |
| **Resume most recent** | `codex resume --last` | `claude --continue` |
| **Interactive picker** | `codex resume` (or `/resume` in-session) | `claude --resume` (or `/resume` in-session) |
| **Session forking** | `codex fork` / `/fork` | `claude --fork-session` / `/branch` |
| **Rewind/checkpoint** | Walk back with Esc, then Enter to fork | `/rewind` (checkpoint-based rewind within session) |
| **Non-interactive resume** | `codex exec resume --last "..."` | `claude -p --resume <id>` |
| **Ephemeral/no-persist** | `--ephemeral` flag | `--no-session-persistence` flag |
| **Disable all history** | `history.persistence = "none"` in config.toml | `CLAUDE_CODE_SKIP_PROMPT_HISTORY` env var |
| **Context compaction** | `/compact` (manual), auto at ~95%; server-side encrypted for Codex models | `/compact [instructions]` (manual), auto at ~95%; human-readable summary |
| **Compaction customization** | `compact_prompt` config key; limited manual guidance | `/compact focus on X` — inline custom instructions per compaction |
| **Compaction transparency** | Opaque AES-encrypted blob for Codex models (server-side) | Human-readable plaintext summary (transparent) |
| **Persistent project context** | `AGENTS.md` (auto-read on session start + after compaction) | `CLAUDE.md` (auto-read on session start + after compaction) |
| **Cross-surface portability** | CLI, Desktop, VS Code, web all share same App Server and sessions | CLI, Desktop app, VS Code extension, and web each maintain separate session history |
| **File cleanup** | No automatic cleanup mentioned; `max_bytes` cap on `history.jsonl` | 30-day automatic cleanup (configurable via `cleanupPeriodDays`) |
| **Export** | No built-in export command; raw JSONL files accessible directly | `/export` copies conversation to clipboard or file |
| **Session search** | Ctrl+R in composer; case-insensitive content search (v0.134.0+) | Searchable session picker |
| **Archive sessions** | Yes — `codex archive` / `/archive` | Not a built-in concept |
| **PR linkage** | Not documented | `--from-pr <number>` — resume session linked to a pull request |
| **Open source** | Yes (Rust) — rollout format and compaction prompts are visible | No |

### Key Conceptual Differences

1. **Transparency vs. Security**: Claude Code's compaction produces human-readable summaries; Codex CLI's compaction for Codex models produces an opaque, AES-encrypted server-side blob that only OpenAI can decrypt. This trades user auditability for security/tamper-resistance.

2. **Cross-surface sync**: Codex CLI's App Server model means all surfaces share one live session store with real-time streaming. Claude Code surfaces (CLI, Desktop, VS Code, web) each maintain their own session history, requiring explicit session IDs to cross boundaries.

3. **Non-interactive CI integration**: Both tools support headless/scripted resume, but Codex CLI's `codex exec resume` is more explicitly documented for CI/CD pipelines with structured JSON output (`--json`), output schemas, and stdin piping.

4. **History file vs. rollout files**: Codex CLI distinguishes between `history.jsonl` (a flat summary-level log) and the detailed rollout JSONL files (full event streams). Claude Code uses a single JSONL transcript per session.

5. **Session archiving**: Codex CLI has a dedicated archive concept to protect specific sessions from the resume picker. Claude Code does not have an equivalent.

---

## 9. Relevant Sources

### Official Docs
- [Codex CLI Features](https://developers.openai.com/codex/cli/features)
- [Codex CLI Command Reference](https://developers.openai.com/codex/cli/reference)
- [Codex Slash Commands](https://developers.openai.com/codex/cli/slash-commands)
- [Codex Advanced Configuration](https://developers.openai.com/codex/config-advanced)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference)
- [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive)
- [Codex Changelog](https://developers.openai.com/codex/changelog)
- [Claude Code — Manage Sessions](https://code.claude.com/docs/en/sessions)

### GitHub Discussions & Issues
- [GitHub Discussion #1076: Resuming a previous session](https://github.com/openai/codex/discussions/1076)
- [GitHub Discussion #3827: Session/Rollout Files](https://github.com/openai/codex/discussions/3827)
- [GitHub Discussion #341: Multi-Session Management for Codex CLI](https://github.com/openai/codex/discussions/341)
- [GitHub Issue #22452: state_5.sqlite and session_index.jsonl drift on Windows](https://github.com/openai/codex/issues/22452)
- [GitHub Issue #17782: Allow custom session ID](https://github.com/openai/codex/issues/17782)
- [GitHub Issue #15271: --session-id flag for codex exec](https://github.com/openai/codex/issues/15271)
- [GitHub Issue #5912: Include current session ID in context](https://github.com/openai/codex/issues/5912)
- [GitHub Issue #23218: Clear context between tasks / continue with previous session ID](https://github.com/openai/codex/issues/23218)

### DeepWiki (Technical Architecture)
- [DeepWiki: Session Management and Persistence](https://deepwiki.com/openai/codex/3.3-session-management-and-persistence)
- [DeepWiki: Rollout Persistence and Replay](https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay)
- [DeepWiki: Session Resumption and Forking](https://deepwiki.com/openai/codex/4.4-session-resumption-and-forking)

### Community & Analysis
- [Inventive HQ: How to Resume a Codex CLI Session](https://inventivehq.com/knowledge-base/openai/how-to-resume-sessions)
- [Inventive HQ: Where Configuration Files Are Stored](https://inventivehq.com/knowledge-base/openai/where-configuration-files-are-stored)
- [Verdent Guides: Codex CLI Resume, Continue, and Save Chat](https://www.verdent.ai/guides/codex-cli-resume-continue-save-chat)
- [Cross-Surface Session Sync (Codex Knowledge Base)](https://codex.danielvaughan.com/2026/04/08/cross-surface-session-sync/)
- [Context Compaction Deep Dive: Codex CLI vs Claude Code](https://codex.danielvaughan.com/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode/)
- [Context Compaction Research Gist (badlogic)](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)
- [Codex CLI's Busy Week: Steer Mode, /fork (Dev Genius)](https://blog.devgenius.io/codex-clis-busy-week-steer-mode-fork-and-7-releases-in-3-days-ece5c742923e)
