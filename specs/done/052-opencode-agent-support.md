# 052 — OpenCode Agent Support (Parity with Claude Code & Codex)

> **Status:** done
> **Completed:** 2026-07-26

## Problem

MultiAgent today treats **Claude Code** and **Codex** as first-class agents: a pane can be
spawned as one of them, the provider/model routing is configurable from Settings, the
session id is captured (via `--session-id` for Claude, via a managed `SessionStart` hook for
Codex), sessions resume on restart, the Session Browser indexes their transcripts, deep
search works, a managed-hook lifecycle drives per-pane status badges, and the Browser MCP
panel is injected per-pane.

**OpenCode** (`anomalyco/opencode`, https://opencode.ai) is a third terminal AI coding agent
that this repo does not yet support at all. A user who has installed `opencode` (via
`npm install -g opencode-ai`, `brew`, `choco`, `scoop`, or the install script) cannot:

- spawn an "OpenCode" pane from the UI spawn menu / command palette / sidebar button,
- route OpenCode to a specific provider/model from MultiAgent's Settings (the way they can
  for Claude's DeepSeek preset or Codex's Alibaba preset),
- have an OpenCode pane's session id captured automatically so it resumes on restart and
  shows up in the Session Browser,
- see a live status badge on an OpenCode pane (idle / working / waiting / error),
- use the MultiAgent Browser MCP panel from inside an OpenCode session,
- type `opencode` in a shell pane and have MultiAgent detect & promote it the way it does
  for `claude` / `codex`.

This spec brings OpenCode to parity with Claude Code and Codex across all those areas. It
adds `'opencode'` as a third `AgentKind` and wires it through every agent-kind branch the
codebase already has, adapting the mechanism to OpenCode's own extension points where they
differ from Claude/Codex.

## Users & Context

- **Primary:** a developer who already runs OpenCode in a plain terminal and wants to run it
  inside MultiAgent alongside Claude and Codex panes, with the same pane management, resume,
  and search experience.
- **Secondary:** a team that standardizes on OpenCode (e.g. on OpenCode Zen or a self-hosted
  gateway) and wants MultiAgent's provider-routing UI to configure it without hand-editing
  `~/.config/opencode/opencode.json`.

## OpenCode facts that shape the design (verified against opencode.ai docs, July 2026)

These are the load-bearing differences from Claude/Codex. Each drives a concrete design
decision below.

1. **No `--session-id` launch flag.** `opencode --session <id>` *resumes* an existing
   session; it does not *create* one with a caller-chosen id. OpenCode generates its own
   `session_id` internally. So app-launched OpenCode **cannot** use the Claude
   `--session-id <uuid>` + `MULTIAGENT_SESSION_ID` short-circuit — it must learn the id
   after creation, the way Codex does. (CLI reference: `opencode` / `opencode run` / `opencode
   --continue` / `opencode --session <id>` / `opencode --fork`.)
2. **Sessions are stored in a SQLite database**, not JSONL transcript files. The DB lives
   under `~/.local/share/opencode/` (`opencode db path` prints it). There is no
   `~/.claude/projects/<dir>/*.jsonl` or `~/.codex/sessions/*.jsonl` equivalent. The session
   list and full message history are queryable via the `opencode session list` /
   `opencode export <id>` CLI, or via the HTTP server API (`opencode serve` →
   `GET /session`, `GET /session/{id}/message`). The schema is not a documented stable
   contract.
3. **Config is JSON/JSONC**, not TOML. Global: `~/.config/opencode/opencode.json`. TUI:
   `~/.config/opencode/tui.json`. Project: `opencode.json` in the project root. Configs are
   **merged** with a documented precedence (remote → global → `OPENCODE_CONFIG` env →
   project → `.opencode/` dirs → `OPENCODE_CONFIG_CONTENT` env → managed). The inline
   `OPENCODE_CONFIG_CONTENT` env var is a **process-scoped runtime override** that wins over
   user/project config but under managed config — the clean injection seam for per-pane
   provider + MCP overrides.
4. **Provider routing is config-driven, not CLI-flag-driven.** Unlike Codex's `-c
   model_provider=...` overrides, OpenCode reads provider config from the merged JSON at
   startup. Provider entries are keyed by id (`anthropic`, `openai`, `ollama`, a custom id,
   …) with `options.apiKey`, `options.baseURL`, `models.<id>`, etc. Auth credentials
   normally live in `~/.local/share/opencode/auth.json` (populated by `opencode auth login`
   / the `/connect` TUI command) or in env vars. The `{env:VAR}` and `{file:path}`
   substitutions let config reference env vars without hardcoding secrets.
5. **The extension mechanism is a Plugin system, not SessionStart hooks.** Plugins are
   JS/TypeScript modules loaded from `.opencode/plugins/`, `~/.config/opencode/plugins/`, or
   the `plugin` config key (npm packages). A plugin exports a function returning a hooks
   object keyed by event name. Relevant events for us: `session.created`, `session.idle`,
   `session.status`, `session.updated`, `session.compacted`, `session.error`,
   `permission.asked`, `permission.replied`, `tool.execute.before`, `tool.execute.after`,
   `shell.env`. **There is no external-process SessionStart hook command** the way Claude
   and Codex run `powershell … multiagent-agent-state.ps1`. The plugin runs **in-process**
   inside OpenCode's Bun runtime and has access to the `@opencode-ai/sdk` client.
6. **OpenCode ships an HTTP server + SSE event stream.** `opencode serve` / `opencode web`
   start a headless server with a full REST API and `event.subscribe()` SSE; the TUI can
   `opencode attach` to a remote server. This is an alternative integration path to the
   plugin path — see Open Questions.
7. **MCP is configured in the JSON `mcp` key.** Local servers: `{type:'local',
   command:[...], environment:{...}, enabled:true, timeout}`. Remote: `{type:'remote',
   url, headers, oauth}`. MCPs can be enabled/disabled globally and per-agent via the
   `tools` key with glob patterns. There is no `--mcp-config <file>` CLI flag; per-pane
   injection goes through `OPENCODE_CONFIG_CONTENT` inline JSON merging a `mcp` entry.
8. **Process name is `opencode`.** The npm package is `opencode-ai`; the binary shim is
   `opencode`. Windows works natively (choco/scoop/npm) but OpenCode recommends WSL;
   `OPENCODE_GIT_BASH_PATH` is the Windows-specific env var for Git Bash.

## Current Behavior (the agent-kind surface today)

`AgentKind = 'claude' | 'codex'` is a closed union (`src/shared/types.ts:115`). Every place
that branches on agent kind is enumerated below with the change type required to add
`'opencode'`. (Full file:line inventory was done as research for this spec; the plan will
carry the exact line numbers. The shape of each touch point:)

- **Union & allow-lists:** `AgentKind` union; `VALID_AGENT_KINDS` in
  `agentSessionReportServer.ts`; `DEFAULT_AGENT_KIND = 'claude'` fallbacks; DeepSearcher
  default kinds list; `isSpawnInTabPayload` and `panesIpc` kind guards. → *add `'opencode'`
  to each literal/allow-list.*
- **Labels, icon, spawn choices, command palette:** `utils/agents.ts` (`agentLabel`/
  `agentAccent`), `AgentIcon.tsx` (+ new `opencode.png` asset), `SpawnChoiceMenu.tsx`
  `SPAWN_CHOICES`, `commands/registry.ts` (`session.newClaude`/`newCodex` → add
  `session.newOpencode`). → *add a branch / list entry in each.*
- **SessionSpawner** (`src/main/sessions/SessionSpawner.ts`): `spawnNew` (launch-id
  decision), `agentEnv` (per-kind env scrub + provider injection), `newSessionCommand`,
  `resumeSessionCommand`, `claudeCliArgs` / `codexCliArgs` (per-kind CLI arg builders). →
  *add an `opencode` branch in each + a new `opencodeCliArgs` helper.*
- **Provider config** (`src/shared/types.ts` `AgentProviderSettings`, `src/shared/
  agentProviderSettings.ts` sanitizer, `src/renderer/.../store/settings.ts` defaults,
  `AgentProvidersSection.tsx` two hardcoded `<ProviderCard>` blocks): the settings object
  has **literal `{ claude, codex }` keys** + parallel `claudePresets`/`codexPresets`/
  `claudeCustomProviders`/`codexCustomProviders` arrays. → *add a third literal key
  `opencode: OpencodeProviderConfig` + parallel preset/custom arrays + a third provider
  card.* (Refactor opportunity: a generic `<AgentProviderCard kind>` driven by a registry.
  This spec does **not** require the refactor — it adds a third card in the existing style
  to keep the diff bounded. A follow-up spec may genericize.)
- **Managed hooks** (`managedHooks.ts` `generateHookCommand(kind)`, `managedHookController.ts`
  `CLAUDE_EVENTS`/`CODEX_EVENTS` + install/uninstall blocks + per-kind config paths,
  `codexConfigFeatures.ts`): the Claude/Codex managed-hook install writes a hook command
  into `~/.claude/settings.json` / `~/.codex/hooks.json` (+ `[features] hooks = true` for
  Codex). **OpenCode does not have this hook shape** — see Intended Behavior §4 for the
  plugin-based adaptation.
- **Hook script assets** (`multiagent-agent-state.{ps1,sh}`): take agent kind as a
  positional arg, forward verbatim in the POST body; only per-kind logic is turn-id
  extraction (`prompt_id` for Claude, `turn_id` for Codex). → *no script change needed for
  the basic linking path;* OpenCode's turn-id field (if any) is handled in the plugin, not
  the script.
- **Agent process detection** (`agentProcessDetect.ts`): `CLAUDE_NAMES`/`CODEX_NAMES` sets +
  npm-package regexes + `identifyAgentFromProcess` early-return checks. → *add
  `OPENCODE_NAMES = new Set(['opencode'])` + `OPENCODE_PACKAGE_RE` / `OPENCODE_FILE_RE`
  (package `opencode-ai`) + an early-return branch.* The sweeper itself is kind-agnostic.
- **Session scanners** (`TranscriptScanner` for Claude JSONL, `CodexSessionScanner` for
  Codex JSONL): two separate classes, dispatched by two-way branches in `DeepSearcher`
  (roots, `searchFile`, scanner dispatch) and `handlers.ts` (`scanAllSessions`,
  `DeepSearcher` ctor, `sessions:latest-for-cwd`, `sessions:validate`, `sessions:recover-
  pending`). → *add a third scanner class `OpencodeSessionScanner` + a third branch in each
  dispatch site.* OpenCode's source is the SQLite DB (or the HTTP API) — see §5.
- **Session resume / hydrate** (`panes.ts` `hydrateTabRuntime`, `sessions:validate` guard):
  hydrate is kind-agnostic; the per-kind gate is `sessions:validate`'s
  `agentKind !== 'claude' && agentKind !== 'codex'` guard. → *add `'opencode'` to that
  guard.*
- **Status badges / eventToState** (`src/shared/agentStatus.ts`): the reducer is
  agent-agnostic; the per-kind asymmetry (Codex has no `Notification`/`StopFailure`) is
  handled at the **hook-install** layer (which events get installed per kind), not the
  reducer. → *no reducer change;* OpenCode's per-kind event set is installed by the plugin.
- **Browser MCP** (`McpInjector.ts` Claude temp `--mcp-config` file vs Codex `-c
  mcp_servers.*` args; `McpSection.tsx` `previewTab` toggle; `SessionSpawner` MCP args): →
  *add an `opencodeMcpConfigPath`/`opencodeMcpUrl` accessor + `opencodeCliArgs` MCP args +
  an `'opencode'` preview tab.* OpenCode's injection mechanism is `OPENCODE_CONFIG_CONTENT`
  inline JSON (no temp file needed) — see §6.
- **Layout/persistence** (`layoutStore.ts`, `panes.ts` `sanitizeNode`): `agentKind` is
  stored as a string and is **not** allow-listed on load; the only closed-union checks are
  `isSpawnInTabPayload` and two `panesIpc` guards. → *add `'opencode'` to those three
  checks;* layout persistence itself is already kind-agnostic.
- **buildEnv** (`src/main/pty/buildEnv.ts`): generic terminal-profile scrubbing
  (ELECTRON_*, CLAUDECODE, CLAUDE_CODE_DISABLE_*, CLAUDE_CODE_NO_FLICKER, MULTIAGENT_*).
  Per-agent scrubbing lives in `SessionSpawner.agentEnv`, not buildEnv. → *no buildEnv
  change unless OpenCode has renderer-inherited `OPENCODE_*` flags that must be scrubbed
  (verify in plan; `OPENCODE_DISABLE_TERMINAL_TITLE` is a candidate analog of
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` but only matters if the renderer sets it, which it
  doesn't).*

## Intended Behavior

### 1. AgentKind union & surface wiring

- `AgentKind = 'claude' | 'codex' | 'opencode'` in `src/shared/types.ts`.
- `VALID_AGENT_KINDS` in `agentSessionReportServer.ts` → `['claude','codex','opencode']`.
- `agentLabel('opencode') = 'OpenCode'`, `agentAccent('opencode')` = a distinct accent
  color (pick from `theme.ts` tokens; do not introduce a raw hex).
- `AgentIcon.tsx` → new `opencode.png` asset under `src/renderer/src/assets/` (ask for the
  asset before implementing the icon — per CLAUDE.md guardrail).
- `SPAWN_CHOICES` → add `{ paneType: 'agent', agentKind: 'opencode' }`;
  `spawnChoiceLabel`/`spawnChoiceKey` → add an `=== 'opencode'` branch.
- `commands/registry.ts` → add `session.newOpencode` (`agentKind: 'opencode'`).
- `isSpawnInTabPayload`, `panesIpc` `session:detected` + `pane:agent-detected` guards → add
  `'opencode'`.

### 2. Launching OpenCode panes (SessionSpawner)

OpenCode is launched as a **bare TUI** (`opencode` or `opencode <cwd>`), the same way Claude
and Codex are launched directly through a non-profile shell. The launch shape:

- **New session:** `opencode` (with `cwd` set to the pane's cwd). No `--session-id`
  equivalent exists, so `spawnNew` returns `sessionId = null` for OpenCode (same as Codex).
  The id is captured post-launch by the plugin (§4).
- **Resume:** `opencode --session <id>` (resumes a specific session by id). `--fork` is
  **not** added (we resume the exact session, not a fork). `--continue` is **not** used
  (it continues the *last* session with no id — we always resume a specific id).
- **CLI args:** a new `opencodeCliArgs()` helper. At minimum it injects:
  - `--model <provider/model>` when the OpenCode provider card is enabled and a model is
    set (overrides the config's `model` for this pane).
  - `--auto` is **added by default** (auto-approve all permissions not explicitly denied),
    so OpenCode panes run unattended without blocking on permission prompts in the TUI.
    This diverges from the Claude/Codex posture (where prompts surface in the TUI); it's a
    deliberate per-agent choice for OpenCode. The user's own OpenCode `permission` config
    still applies as the deny-list floor — `--auto` only auto-approves non-denied actions.
    A per-pane/per-card toggle to turn this off is a follow-up Non-Goal.
  - MCP args are injected via `OPENCODE_CONFIG_CONTENT` env, not CLI flags (§6).
- **`agentEnv('opencode')` block:** scrubs Claude's `CLAUDE_PROVIDER_ENV_KEYS` + Codex's
  `OPENAI_API_KEY`/`codexCfg.envKey` + Codex extra env vars (so an OpenCode pane never
  inherits another agent's credentials), then applies OpenCode's own provider injection
  (§3). Does **not** set `MULTIAGENT_SESSION_ID` (no launch-id known). Does set
  `MULTIAGENT_PTY_ID`/`MULTIAGENT_ENV`/`MULTIAGENT_HOOK_PORT` via `getPaneEnv` (same as all
  panes) so the plugin can report home.
- **`agentLaunchCommand`** is kind-agnostic (wraps in powershell/bash) — no change.

### 3. Provider config card (Settings)

A third provider card "OpenCode" is added to `AgentProvidersSection.tsx`, parallel to the
Claude and Codex cards. The card shape is adapted to OpenCode's provider model:

- **Preset chips** for the most common OpenCode provider destinations:
  - `native` — no override; OpenCode uses whatever's in `~/.config/opencode/opencode.json`
    + `auth.json` (the user configured OpenCode themselves via `/connect`).
  - `ollama` — local Ollama at `http://localhost:11434/v1`, token-less (mirrors the Claude
    Ollama preset from spec 048). Model default: a `ollama/<id>` entry the user fills.
  - `zai` — z.ai (OpenAI-compatible endpoint at `https://api.z.ai/api/coding/paas/v4`,
    `wire_api = chat` semantics). User pastes their z.ai API key.
  - `chatgpt` — OpenAI ChatGPT plan via API key (`openai` provider). **Note:** the
    ChatGPT *Plus/Pro* OAuth login flow (browser auth via `/connect`) cannot be injected
    by MultiAgent — only the manual API-key path is supported by this preset. A user on
    Plus/Pro who wants OAuth should use `native` and run `/connect` themselves.
  - `custom` (named, repeated — same multi-custom mechanism as spec 048) for any other
    OpenCode-supported provider or self-hosted gateway.
- **Fields per preset:** `model` (the `provider/model` string OpenCode expects, e.g.
  `openai/gpt-4o`, `ollama/llama2`, `zai/glm-5.2`), `apiKey` (masked, with show/hide;
  unset for `ollama`), `baseUrl` (optional; preset for `ollama` and `zai`), and the
  existing "Extra env vars" expander for raw overrides.
- **Injection mechanism:** when the card is enabled and `preset !== 'native'`,
  `agentEnv('opencode')` builds an `OPENCODE_CONFIG_CONTENT` env var whose JSON value
  merges:
  - `model: "<provider/model>"` (if set),
  - `provider.<id>.options.apiKey: "<key>"` (if set — using `{env:VAR}` substitution is
    *not* used here because the key is already in MultiAgent's masked field; we inject the
    literal value, process-scoped),
  - `provider.<id>.options.baseURL: "<url>"` (if set),
  - `provider.<id>.npm: "<adapter package>"` (if set — **required** for any provider id not
    in OpenCode's models.dev catalog, e.g. `@ai-sdk/openai-compatible` for Ollama/z.ai/a
    custom gateway; verified against live docs. Omitted for catalog providers like `openai`.
    A new `npmAdapter` field on `OpencodeProviderConfig`, exposed in the UI, carries this),
  - `provider.<id>.models.<modelId>: { name, limit: { context, output } }` (derived from the
    model id in `model`, whenever a model override is set). **Required** for any model id
    outside the models.dev catalog — verified against live docs. This is the fix for the
    original bug where an Ollama-cloud-proxy tag like `glm-5.2:cloud` (or any other
    non-catalog model) silently failed to resolve: OpenCode has no way to know a model id
    exists unless it's declared here. `limit.context`/`limit.output` use conservative
    generic defaults (128000/4096) since MultiAgent has no way to know a given model's real
    limits; a user hitting an actual limit mismatch can override via "Extra env vars" →
    `OPENCODE_CONFIG_CONTENT` is not directly editable, so a future refinement could expose
    context/output limit fields in the UI if this proves too coarse in practice.
  This inline content overrides the user's global/project OpenCode config for this pane
  only, and never writes to `~/.config/opencode/opencode.json` (per the CLAUDE.md guardrail:
  do not mutate user/project agent config). `native` preset → `OPENCODE_CONFIG_CONTENT` is
  unset and OpenCode uses the user's own config.
- **Data model:** a new `OpencodeProviderConfig` interface + `OpencodeBuiltinPreset` union
  + `opencodePresets` / `opencodeCustomProviders` arrays on `AgentProviderSettings`, all
  parallel to the existing Claude/Codex shapes. The sanitizer
  (`agentProviderSettings.ts`) gets a parallel `sanitizeOpencodeConfigWith` + custom-array
  sanitization + dangling-active-custom reset + legacy-migration hooks, mirroring spec
  048's Claude/Codex paths.
- **Scope:** global config only (one OpenCode profile, applies to all OpenCode panes) —
  same as Claude/Codex today.

### 4. Session linking via a managed OpenCode plugin

This is the OpenCode analog of the managed `SessionStart` hook (spec 047 / docs/session-
linking-hooks.md). The mechanism is different because OpenCode has no external-process hook
command — it has an in-process **plugin system**.

- **Bundled plugin asset:** a new `src/main/integration/assets/multiagent-opencode-plugin.js`
  (a small JS module, no TypeScript to avoid a build step — the plugin runs inside
  OpenCode's Bun runtime which loads JS/TS directly). The plugin:
  1. Bails unless `process.env.MULTIAGENT_ENV === '1'` and `MULTIAGENT_PTY_ID` and
     `MULTIAGENT_HOOK_PORT` are set (so it's a no-op for OpenCode launched outside
     MultiAgent — same gate as the `.ps1`/`.sh` hook scripts).
  2. **Delivery mechanism, corrected after live verification against
     `@opencode-ai/plugin`/`@opencode-ai/sdk` type definitions:** session/permission
     lifecycle (`session.created`, `session.idle`, `session.status`, `session.error`,
     `permission.updated`) are **not** individually-addressable hook keys — an earlier pass
     of this spec/plugin registered them as top-level object keys, which OpenCode silently
     ignores (the plugin loads without error but the hooks never fire, which is exactly the
     "plugin shows loaded, but sessions never link" symptom observed in testing). They are
     `Event` union members delivered **only** through a single generic `event` hook
     (`event: async ({ event }) => ...`, dispatched on `event.type`, payload under
     `event.properties`). The plugin now registers one `event` hook that switches on
     `event.type` for all five. `tool.execute.before` / `tool.execute.after` **are** real
     top-level intercept hooks (own signature: `(input: {tool, sessionID, callID}, output)`)
     and stay registered directly, not via `event`. The plugin deliberately does **not**
     implement the `permission.ask` intercept hook (which can decide allow/deny) — that
     would make it part of the permission decision; `--auto` + the user's own `permission`
     config already own that, so the plugin only observes the passive `permission.updated`
     event for the status badge.
  3. On `event.type === 'session.created'`, reads `event.properties.info.id` → POSTs
     `{ ptyId, agentKind:'opencode', sessionId, transcriptPath:null }` to
     `http://127.0.0.1:<port>/agent-session` (the **existing**
     `agentSessionReportServer.ts`, once `VALID_AGENT_KINDS` is widened). 2s timeout, exits
     0 / swallows errors (a plugin must never break OpenCode's session start).
  4. Subscribes to lifecycle events for status badges (§7) via the same `event` hook:
     `session.idle`→`stop`, `session.status` (only when `properties.status.type==='busy'`)→
     `user_prompt_submit`, `permission.updated`→`permission_request`, `session.error`→
     `stop_failure`; `tool.execute.before`/`tool.execute.after` (direct hooks, not via
     `event`) →`pre_tool_use`/`post_tool_use`. Each event is POSTed to the existing
     `/agent-event` route (same path the Claude/Codex hook scripts use), with `sessionID`
     from the event payload as the turn-id field.
- **Install path (process-scoped, no user-config mutation):** the plugin is copied to
  `<userData>/opencode-plugin/plugins/multiagent-opencode-plugin.js` at install time
  (refreshed only when the bundled content changes — same content-hash gate as the
  `.ps1`/`.sh` scripts). **Verified against live OpenCode docs: there is no per-process
  plugin-directory override.** OpenCode only scans `.opencode/plugins/` (project) and
  `~/.config/opencode/plugins/` (global) — `OPENCODE_CONFIG_DIR` is not a real OpenCode env
  var (an earlier pass of this spec assumed it was; that assumption was wrong and made the
  plugin a silent no-op). Instead, the installed plugin's **absolute file path** is injected
  into a `plugin: ["<path>"]` entry of the same process-scoped `OPENCODE_CONFIG_CONTENT`
  inline JSON used for provider/MCP overrides (§3/§6) — `OPENCODE_CONFIG_CONTENT` is a
  documented, verified mechanism. This is the **process-scoped** seam, parallel to Claude's
  temp `--mcp-config` file: the plugin loads only for the MultiAgent-spawned pane, never
  touches `~/.config/opencode/opencode.json` or `~/.config/opencode/plugins/`, and dies with
  the pane. **No managed-hook install into user config is needed at all** — the per-pane env
  is sufficient, so the Settings → Terminal "Session linking & live status (managed hooks)"
  toggle does **not** need to govern OpenCode (the plugin loads unconditionally for any
  OpenCode pane MultiAgent spawns). This satisfies the CLAUDE.md "don't mutate user/project
  agent config" guardrail without needing the scoped managed-hook exception.
- **The existing report server is reused as-is** (once `VALID_AGENT_KINDS` is widened). The
  existing `session:detected` IPC → `panesIpc.ts` listener → promote-if-shell →
  `setSessionId` path is unchanged.

### 5. Session Browser indexing & deep search (OpencodeSessionScanner)

A new `OpencodeSessionScanner` class, parallel to `TranscriptScanner` (Claude) and
`CodexSessionScanner` (Codex), wired into `DeepSearcher` (third root, third constructor
param, third `searchFile` branch, third scanner dispatch) and `handlers.ts`
(`scanAllSessions`, `DeepSearcher` ctor, `sessions:latest-for-cwd`, `sessions:validate`,
`sessions:recover-pending`).

- **Source: the SQLite DB at `~/.local/share/opencode/`** (the path `opencode db path`
  prints; resolve `~` cross-platform). Read-only via `better-sqlite3` (already a dependency
  for `SessionIndex`). The scanner queries the sessions + messages tables for
  `{sessionId, cwd, title, createdAt, updatedAt, messageCount}` summaries — the same
  `ScannedSession` shape the Session Browser shows for Claude/Codex.
- **Why SQLite over the alternatives:**
  - *Shelling out to `opencode session list` / `opencode export <id>`* is stable but slow
    (spawns a process per scan; OpenCode cold-start is non-trivial) and fragile to TUI
    color codes in output. Rejected for the hot scan path.
  - *The HTTP server API* (`opencode serve` → `GET /session`) requires a running server,
    which we don't have for a bare-TUI launch. Rejected for the scanner.
  - *Direct SQLite read* is fast and local. **Risk:** the schema is not a documented stable
    contract; an OpenCode version bump could rename columns/tables. Mitigation: the scanner
    queries defensively (PRAGMA `table_info`, fall back to `opencode session list --format
    json` if the schema is unrecognized) and fails closed — a schema mismatch degrades to
    "no OpenCode sessions indexed," never crashes the scan. This risk is recorded; the
    plan verifies the schema against the installed OpenCode version before shipping.
- **Deep search** (`DeepSearcher.searchFile` for OpenCode): reads the full message history
  for a session from the SQLite DB (the same tables, joined) and streams records through
  the existing pure Node streamer (no PATH `rg`). The `agentKind === 'opencode'` branch
  extracts `sessionId` from the sessions table (not from a filename like Claude, not from a
  first-line `session_meta` like Codex).
- **cwd repair:** OpenCode does not copy/merge transcript dirs the way Claude does; the
  existing `SessionIndex` cwd-repair path is Claude-specific (`copyClaudeProjectDirectories`
  filters `row.agentKind === 'claude'`). OpenCode sessions get the app-owned-first cwd
  repair (SQLite override) only if needed — **out of scope for v1**; the scanner reads cwd
  from the sessions table and that's the source of truth. Recorded as a Non-Goal.

### 6. Browser MCP injection

- `McpInjector.ts` gets a new `opencodeMcpUrl` accessor (the local browser MCP server URL,
  same value as `codexMcpUrl` — the browser server is kind-agnostic).
- `opencodeCliArgs()` does **not** add MCP args to the command line (OpenCode has no
  `--mcp-config` flag). Instead, `agentEnv('opencode')` merges a `mcp.multiagent-browser`
  entry into the `OPENCODE_CONFIG_CONTENT` JSON:
  ```json
  { "mcp": { "multiagent-browser": { "type": "remote", "url": "<browser-mcp-url>",
    "enabled": true } } }
  ```
  This is merged with any provider override from §3 in the same `OPENCODE_CONFIG_CONTENT`
  value (a single JSON object). Process-scoped, no temp file, no mutation of
  `~/.config/opencode/opencode.json`.
- `McpSection.tsx` → add an `'opencode'` tab to the `previewTab` toggle showing the merged
  JSON that would be injected.
- The Browser MCP server itself (`BrowserMcpServer.ts`, `BrowserViewManager.ts`) is
  kind-agnostic — no change.

### 7. Status badges via the plugin

The plugin (§4) emits lifecycle events to the existing `/agent-event` route. The
`eventToState` reducer (`src/shared/agentStatus.ts`) is agent-agnostic and already handles
`session_start`, `user_prompt_submit` (OpenCode fires this as `tool.execute.before` on the
first tool, or a `session.status` event — verify in plan), `pre_tool_use`/`post_tool_use`
(map from `tool.execute.before`/`tool.execute.after`), `permission_request` (from
`permission.asked`), `stop` (from `session.idle`), `stop_failure` (from `session.error`).
The OpenCode event→our-event-name mapping is done in the plugin before POSTing, so the
report server and reducer need **no change**. The per-pane badge renders the same way.

OpenCode has no `Notification`-hook analog (permission prompts come through
`permission.asked`, which we map to `permission_request`), so all five badge states are
reachable for OpenCode — unlike Codex where `error` is hooks-unreachable and spec 050's
scoped scraping complements it. OpenCode does **not** need the terminal-error scraping
path; `session.error` covers it.

### 8. Process detection (agentProcessDetect)

- `OPENCODE_NAMES = new Set(['opencode'])`.
- `OPENCODE_PACKAGE_RE` matches npm-package paths containing `opencode-ai` (the package
  name); `OPENCODE_FILE_RE` matches the bin shim filename `opencode`.
- `classifyToken` + `identifyAgentFromProcess` get an `OPENCODE_NAMES.has(baseName)` →
  `return 'opencode'` early-return branch, parallel to the Claude/Codex checks.
- The sweeper itself is kind-agnostic — no change.

## Non-Goals

- **Rewriting `AgentProviderSettings` to a generic `Map<AgentKind, …>`** or extracting a
  generic `<AgentProviderCard>` component. This spec adds a third literal key + a third
  hardcoded card in the existing style. A follow-up spec may genericize the provider model
  once three agents prove the pattern's pain.
- **A managed-hook install for OpenCode that mirrors the Claude/Codex hook-command shape.**
  OpenCode has no external-process SessionStart hook; the plugin path (§4) is the
  adaptation. We do not add a `opencodeConfigFeatures.ts`-style feature flag.
- **OpenCode cwd-repair transcript copying** (the Claude `copyClaudeProjectDirectories`
  analog). OpenCode stores sessions in SQLite, not transcript dirs; the scanner reads cwd
  from the DB. App-owned cwd repair for OpenCode is out of scope.
- **OpenCode `--auto` is the default** (panes run unattended). A per-card toggle to turn it
  off is out of scope for v1; the user can deny specific tools/actions in their own OpenCode
  `permission` config (the deny-list floor `--auto` respects).
- **OpenCode `--fork` resume.** We resume the exact session by id, not a fork.
- **OpenCode Zen/Go subscription billing, OAuth flows, or the `/connect` TUI command.**
  MultiAgent's provider card takes an API key + base URL; the user's own `/connect` setup is
  orthogonal and not duplicated. The `chatgpt` preset supports the **API-key** path only;
  ChatGPT Plus/Pro **OAuth** login cannot be injected by MultiAgent and is a Non-Goal (users
  on Plus/Pro OAuth should use the `native` preset).
- **Terminal-error scraping for OpenCode.** `session.error` plugin events cover the error
  badge state; the spec 050 scraping path is not extended to OpenCode.
- **A "managed settings" / MDM config layer** for OpenCode. Out of scope.

## Risks

- **OpenCode SQLite schema instability.** The sessions/messages schema is not a documented
  stable contract. A version bump could break the scanner. Mitigation: defensive queries
  (PRAGMA `table_info`), fall back to `opencode session list --format json`, fail closed.
  The plan verifies the schema against the installed OpenCode version before shipping.
- **~~better-sqlite3 URI-open failure on Windows~~ — RESOLVED, was a real bug.**
  `OpencodeSessionScanner.open()` originally opened the DB via a `file:${dbPath}?mode=ro`
  URI string. Verified live (via `ELECTRON_RUN_AS_NODE=1` against the app's actual
  Electron-ABI-compiled `better-sqlite3` build): **every** `file:` URI form (with or without
  the Windows-backslash-vs-forward-slash path, with 0/1/3 leading slashes) throws `unable to
  open database file` for this build, while the identical plain path (forward- or
  backslash-separated) with `{ readonly: true, fileMustExist: false }` opens correctly and
  reads real data. Because the constructor throws before `schemaOk()` ever runs, every
  Windows OpenCode pane silently produced zero indexed sessions (Session Browser + Recent
  sidebar showed nothing) with no visible error anywhere — indistinguishable from "no
  sessions yet." Fixed by opening the plain path (no URI) with `{ readonly: true }`, which
  gives the same don't-write guarantee without the failure mode. This was the actual root
  cause of the "Recent"/Session Browser gap discovered when live-testing this spec; the
  fix removes the URI wrapping entirely rather than special-casing it per platform, since
  the plain-path form was confirmed correct everywhere it was tested.
- **~~Unbound SQL parameter in `sessionDetail()`~~ — RESOLVED, was a real bug, the actual
  cause of missing firstMessage/lastMessage/lastActivity/messageCount.** After the URI-open
  fix above, sessions were indexed but every one showed `messageCount: 0` and
  `firstMessage`/`lastMessage`/`firstActivity`/`lastActivity` all `null` — even for sessions
  independently confirmed (via a standalone script against the same file) to have real
  messages. Root cause: `sessionDetail()`'s query — `SELECT ... FROM message WHERE
  session_id = ? ORDER BY time_created ASC` — was executed as `.all()` with **no bound
  parameter** for the `?` placeholder. better-sqlite3 throws on a missing parameter binding,
  and that throw was silently swallowed by the method's own `catch { return empty }`, so
  every call returned the all-null/zero "no messages" default regardless of the session's
  real content. This was present from the original implementation and was never touched by
  either the URI-open fix or a (subsequently reverted) speculative "reopen a fresh connection
  per scan" change that was tried and discarded when investigation revealed the real bug was
  parameter binding, not connection lifecycle. Fixed with one line: `.all(sessionId)`. Also
  added a `<system-reminder>`-prefix filter in the same method (mirroring
  `transcriptParse.ts`'s `isRealUserMessage` filtering of Claude's synthesized
  `<command`/`<local-command` records) so IDE-injected context notes don't show up as an
  uninformative firstMessage/lastMessage. A stale on-disk `session-index.db` cache from
  before this fix needed a one-time manual clear (`DELETE FROM sessions WHERE
  agentKind='opencode'`) to drop already-corrupted rows, since `SessionIndex.upsertMany`
  only reprocesses a session when its `mtimeMs` changes — a session whose OpenCode-side
  `time_updated` hadn't moved since the bad scan would otherwise stay frozen with
  all-null/zero fields indefinitely.
- **~~Plugin load order / Bun runtime quirks~~ — RESOLVED, was a real bug.** The original
  design assumed an `OPENCODE_CONFIG_DIR` env var would redirect OpenCode's plugin-directory
  scan; verified against live docs, this env var does not exist, so the plugin never loaded
  and session linking silently failed closed in practice (exactly the failure mode this risk
  entry predicted, just from a different cause than anticipated). Fixed by injecting the
  installed plugin's absolute file path into a `plugin: ["<path>"]` entry inside the same
  process-scoped `OPENCODE_CONFIG_CONTENT` JSON used for provider/MCP overrides — a
  documented, verified mechanism (see §4/§3). Still unverified: whether OpenCode's `plugin`
  array resolves an absolute local file path the same way it resolves an npm package name
  (docs only show npm-package examples) — confirm on first live test.
- **`OPENCODE_CONFIG_CONTENT` merge semantics.** Inline content overrides user/project
  config but is itself overridden by managed config. If a user has managed config
  (`/Library/Application Support/opencode/` etc.), our provider/MCP injection could be
  overridden. This is acceptable (managed config is admin-controlled by design) and
  documented; the provider card notes "may be overridden by managed config" when enabled.
- **OpenCode process detection on Windows.** OpenCode recommends WSL on Windows; a native
  Windows install runs `opencode.exe` (or via `opencode-ai` npm shim). The process-tree
  sweeper's `Get-CimInstance Win32_Process` path should see it, but the WSL case (OpenCode
  running inside a WSL distro) is **not** detectable from the Windows host process table —
  a known limitation inherited from the existing sweeper (which also can't see inside WSL).
  Recorded; not blocking.
- **Plugin trust.** Unlike Codex's explicit `/hooks` trust gate, OpenCode plugins load
  unconditionally — no one-time trust prompt. This is simpler (no "trust once via TUI"
  step) but means a malformed plugin could break OpenCode startup. Mitigation: the plugin
  is tiny, defensive (try/catch around every hook), and bails silently on any error.
- **OpenCode version skew vs `--session` resume semantics.** `opencode --session <id>` is
  documented (CLI flags table) but the exact resume behavior (does it re-fire
  `session.created`? does it fork?) should be verified against the installed version. The
  plan runs a live resume test before shipping.

## Verification Steps

- `npm run typecheck` passes.
- `npm run test` — `agentProviderSettings.test.ts` covers: `opencode` preset defaults
  (`native`/`zen`/`anthropic`/`ollama`); preset accepts built-in or `custom:<id>` and
  rejects garbage to `native`; `opencodeCustomProviders` array sanitization (bad id
  dropped, dup de-duped); dangling active `custom:<id>` resets to native; legacy migration
  if needed. `agentProcessDetect.test.ts` covers `opencode` name + package detection.
  `agentSessionReportServer.test.ts` covers `'opencode'` in `VALID_AGENT_KINDS`.
- Manual: spawn an OpenCode pane from the UI spawn menu → it launches `opencode <cwd>`;
  pane label/icon show "OpenCode".
- Manual: enable the OpenCode `zen` preset, paste a Zen key, spawn a pane → confirm
  `OPENCODE_CONFIG_CONTENT` is set with the merged provider JSON and OpenCode routes to
  Zen (check via `opencode debug config` inside the pane).
- Manual: enable the OpenCode `ollama` preset (token-less) → spawn → confirm routes to
  `http://localhost:11434/v1` with no API key injected.
- Manual: with the session-linking toggle on, spawn an OpenCode pane, send a first message
  → confirm the plugin fires `session.created`, the report server receives it, and the
  pane's `sessionId` is set (visible in the Session Browser + saved to `layout.json`).
- Manual: close and restart MultiAgent → the OpenCode pane resumes via
  `opencode --session <id>` and re-links.
- Manual: type `opencode` in a shell pane → the process sweeper promotes it to an agent
  pane (label/icon flip to OpenCode); the plugin links the id on first message.
- Manual: enable Browser MCP → spawn an OpenCode pane → confirm the
  `multiagent-browser` MCP server is reachable from inside the OpenCode session (the agent
  can call `browser_*` tools).
- Manual: enable status badges → spawn an OpenCode pane, send a message → confirm the
  badge transitions idle → working → (permission) → idle as the turn progresses.
- Manual: open the Session Browser → confirm OpenCode sessions appear alongside Claude/Codex
  sessions, with cwd + title + timestamp; deep search returns OpenCode session contents.
- Manual: two OpenCode custom providers ("Gateway A", "Gateway B") survive a round-trip
  switch (the spec 048 regression check, repeated for the OpenCode card).
- `npm run test:e2e` — the Playwright smoke suite still passes (add an OpenCode spawn
  smoke if the harness supports a mock `opencode` binary; otherwise manual only).

## Definition of Done

- [ ] `'opencode'` is a valid `AgentKind` everywhere it's allow-listed; the spawn menu,
      command palette, and sidebar button offer "OpenCode" with the correct icon + label.
- [ ] Spawning an OpenCode pane launches `opencode <cwd>`; resuming launches
      `opencode --session <id>`. No `--fork`, no `--auto` by default.
- [ ] The OpenCode provider card (presets `native`/`zen`/`anthropic`/`ollama` + named
      custom providers) injects `OPENCODE_CONFIG_CONTENT` with merged provider + MCP JSON,
      scoped to OpenCode panes only, never writing to `~/.config/opencode/opencode.json`.
- [ ] A managed OpenCode plugin is installed (marked, idempotent, reversible from the
      Settings → Terminal toggle) that reports `session.created` + lifecycle events to the
      existing report server; `VALID_AGENT_KINDS` includes `'opencode'`.
- [ ] An OpenCode pane's session id is captured on first message, saved to `layout.json`,
      and resumes on restart.
- [ ] Typing `opencode` in a shell pane promotes it to an OpenCode agent pane (process
      detection) and links the id via the plugin.
- [ ] The Session Browser indexes OpenCode sessions from the SQLite DB; deep search returns
      OpenCode session contents. A schema mismatch fails closed (no crash).
- [ ] Browser MCP is injectable into an OpenCode pane via `OPENCODE_CONFIG_CONTENT`; the
      MCP settings preview has an OpenCode tab.
- [ ] Status badges render on OpenCode panes (all five states reachable via plugin events).
- [ ] `npm run typecheck` + `npm run test` + `npm run test:e2e` pass.

## Open Questions

None outstanding.

**Resolved:**

- **Scope:** full parity in one spec (spawn + provider card + plugin linking + SQLite
  scanner + browser MCP + badges + process detection + resume). Chosen over a core-first
  split because the surfaces are tightly coupled (linking needs the scanner for validate;
  badges need the plugin; browser MCP needs the env injection) and splitting would leave
  half-landed states. A follow-up spec may genericize the provider card / scanner dispatch
  once three agents prove the pattern's pain.
- **Integration model:** bare TUI (`opencode <cwd>`) launched directly in the pane + a
  managed JS plugin that reports `session.created` + lifecycle events to the existing
  report server. Rejected `opencode serve` + `opencode attach` (pane wouldn't be the native
  TUI; we'd manage a second backend process per pane) and `opencode session list` polling
  (flaky, race-prone — closer to the rolled-back Codex file-poll scanner).
- **Plugin install mechanism (revised after live verification):** `OPENCODE_CONFIG_DIR` is
  not a real OpenCode env var — OpenCode only scans `.opencode/plugins/` (project) and
  `~/.config/opencode/plugins/` (global), with no per-process override. Instead, the
  installed plugin's absolute file path is injected as `plugin: ["<path>"]` inside the same
  process-scoped `OPENCODE_CONFIG_CONTENT` inline JSON used for provider/MCP overrides. No
  mutation of `~/.config/opencode/opencode.json` or `~/.config/opencode/plugins/`, so
  the CLAUDE.md "don't mutate user/project agent config" guardrail is satisfied without the
  scoped managed-hook exception. The plugin loads unconditionally for any MultiAgent-spawned
  OpenCode pane — the existing Settings → Terminal managed-hooks toggle does **not** govern
  it (that toggle stays Claude/Codex-scoped).
- **Custom/non-catalog model resolution (added after live verification):** a model id not in
  OpenCode's models.dev catalog (e.g. an Ollama cloud-proxy tag like `glm-5.2:cloud`) is
  unresolvable unless declared under `provider.<id>.models.<modelId>`, and a generic
  OpenAI-compatible provider id (Ollama, z.ai, a custom gateway) needs `provider.<id>.npm:
  "@ai-sdk/openai-compatible"` or OpenCode has no adapter for it at all. `OpencodeProviderConfig`
  gained an `npmAdapter` field (UI-exposed, empty for catalog providers like `openai`);
  `SessionSpawner.agentEnv` derives a `models` entry from the configured `model` string with
  generic `limit.context`/`limit.output` defaults.
- **Provider presets:** `native` + `ollama` (token-less local) + `zai` (OpenAI-compatible,
  user key) + `chatgpt` (OpenAI API-key path) + named custom providers (spec 048 mechanism).
  Rejected `zen`/`anthropic` as built-ins (users on those can use `native` after `/connect`
  or a custom provider); rejected `openrouter` (custom is sufficient). `chatgpt` preset is
  API-key-only — Plus/Pro OAuth cannot be injected by MultiAgent (Non-Goal).
- **Permission posture:** launch with `--auto` by default so OpenCode panes run unattended
  (no permission prompts blocking the TUI). The user's own OpenCode `permission` config is
  the deny-list floor `--auto` respects. Diverges from Claude/Codex posture (deliberate,
  per-agent). A per-card toggle to disable `--auto` is a follow-up Non-Goal.
- **Resume shape:** `opencode --session <id>`. No `--fork` (resume the exact session, not a
  branch). No `--continue` (it resumes the *last* session with no id; we always resume a
  specific id we captured).
- **Session browser source:** direct SQLite read of `~/.local/share/opencode/` via
  `better-sqlite3`, with defensive `PRAGMA table_info` + fall back to `opencode session
  list --format json` + fail closed on schema mismatch. Rejected shelling out to the CLI
  for the hot scan (slow, TUI color codes) and the HTTP server API (requires a running
  server we don't have for a bare-TUI launch).
- **Browser MCP injection:** merged into the same `OPENCODE_CONFIG_CONTENT` JSON as the
  provider override (§6), as a `mcp.multiagent-browser` remote entry. No temp file (unlike
  Claude's `--mcp-config`); no CLI flag (unlike Codex's `-c mcp_servers.*`).
- **Status badges:** the plugin maps OpenCode events to the existing `eventToState`
  reducer's input events (no reducer change). OpenCode has `permission.asked` (→
  `permission_request`) and `session.error` (→ `stop_failure`), so all five badge states
  are reachable — unlike Codex, OpenCode does **not** need the spec 050 terminal-error
  scraping complement.