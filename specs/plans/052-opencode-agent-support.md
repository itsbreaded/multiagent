# Plan — spec 052 (opencode-agent-support)

Source spec: `specs/pending/052-opencode-agent-support.md` (Status: ready → in-progress → review)
Authoritative for WHAT/WHY. This file is the durable resume source + verify-spec coverage input.

## Verified facts (from research, not assumed)

- **OpenCode 1.18.5 installed** at `C:\Users\cdhan\AppData\Roaming\npm\opencode`. Binary `opencode` / `opencode.cmd`.
- **SQLite DB** at `~/.local/share/opencode/opencode.db`. Schema (probed):
  - `session`: `id` (text PK, e.g. `ses_062dac63dffeJwxszoGRWwfIgQ`), `project_id`, `parent_id` (nullable — filter `parent_id IS NULL` for top-level), `slug`, `directory` (cwd, e.g. `C:/Code/multiagent` — forward slashes), `path`, `title`, `version`, `model` (JSON string), `agent`, `time_created` (int ms epoch), `time_updated` (int ms epoch), `time_compacting`, `time_archived`, plus token/cost columns.
  - `message`: `id`, `session_id`, `time_created`, `time_updated`, `data` (JSON: `{role:'user'|'assistant', time:{created}, agent, model, summary}`).
  - `part`: `id`, `message_id`, `session_id`, `time_created`, `data` (JSON: `{type:'text'|'tool'|'reasoning'|'step-start'|'step-finish'|'patch'|'file', text?, tool?, ...}`). `text` is the searchable content for text/reasoning parts; tool parts have `state.input`/`state.output`.
- `opencode session list --format json` → `[{id, title, updated, created, projectId, directory}]`. (Slow: spawns a process; not used for the hot scan.)
- **No `--session-id` launch flag**; `opencode --session <id>` resumes, `opencode --continue` continues last, `opencode --fork` forks. Confirmed via `opencode --help` / CLI docs.
- **Plugins load from `OPENCODE_CONFIG_DIR`** (env var) — that dir is searched for `plugins/*.{js,ts}` automatically. Process-scoped, no user-config mutation. Confirmed via config docs ("Custom directory" + "Plugins" → "local files" load from `.opencode/plugins/` and `~/.config/opencode/plugins/`; `OPENCODE_CONFIG_DIR` overrides that search root).
- **`OPENCODE_CONFIG_CONTENT`** env var = inline JSON config content, merged at high precedence (above project, below managed). Confirmed via config docs precedence order.
- `VALID_AGENT_KINDS` in `agentSessionReportServer.ts:20` is `['claude','codex']` — widening is the gate for opencode session reports.
- `managedHookController.ts` is hard-wired to Claude+Codex only (no `agentKind` param, no third path). **No change needed** — confirmed.
- `opencode.png` icon asset: **user will add to `src/renderer/src/assets/`** (per CLAUDE.md guardrail). I wire the import/branch now; resolves once the file lands.

## Tasks (build order)

### T1 — AgentKind union + surface wiring [reqs §1, §8] ✅
Files: `src/shared/types.ts:115`, `src/main/integration/agentSessionReportServer.ts:20`, `src/renderer/src/utils/agents.ts:4,8`, `src/renderer/src/components/AgentIcon.tsx:5,17`, `src/renderer/src/components/SpawnChoiceMenu.tsx:13-17,185`, `src/renderer/src/commands/registry.ts:~122`, `src/renderer/src/store/panes.ts:242`, `src/renderer/src/store/panesIpc.ts:40,68,117`, `src/main/sessions/DeepSearcher.ts:199`.
- Widen `AgentKind = 'claude' | 'codex' | 'opencode'`.
- `VALID_AGENT_KINDS` += `'opencode'`.
- `agentLabel('opencode')='OpenCode'`; `agentAccent('opencode')='#c084fc'` (purple-400 — distinct from Claude green `#4ade80` and Codex blue `#60a5fa`; hardcoded to match existing style).
- `AgentIcon.tsx`: `import opencodeIcon from '../assets/opencode.png'` + three-way `src` pick.
- `SPAWN_CHOICES` += `{ paneType:'agent', agentKind:'opencode' }`; `spawnChoiceLabel` three-way (`'OpenCode'`).
- `registry.ts` += `session.newOpencode` entry.
- `isSpawnInTabPayload` guard += `'opencode'`.
- `panesIpc.ts` 3 guards += `'opencode'`.
- `DeepSearcher.ts:199` default kinds += `'opencode'`.
Verify: `npm run typecheck` clean (the union widening will surface every remaining closed-union site as a TS error — fix each).

### T2 — Provider config data model + sanitizer [req §3] ✅
Files: `src/shared/types.ts` (new types + `AgentProviderSettings`), `src/shared/agentProviderSettings.ts` (parallel opencode path), `src/renderer/src/store/settings.ts:41-55` (defaults).
- New types: `OpencodeBuiltinPreset = 'native' | 'ollama' | 'zai' | 'chatgpt'`, `OpencodePresetId = OpencodeBuiltinPreset | CustomProviderId`, `OpencodeProviderConfig { enabled, preset, providerId (string, the opencode provider key e.g. 'openai'/'ollama'/'zai'/'<custom>'), model (string, 'provider/model' form), baseUrl, apiKey (masked), extraEnvVars }`, `OpencodeCustomProvider { id, name, config }`.
- `AgentProviderSettings` += `opencode: OpencodeProviderConfig`, `opencodePresets?`, `opencodeCustomProviders?`.
- `agentProviderSettings.ts`: `OPENCODE_BUILTINS` array, `defaultOpencodeConfig()`, add `opencode: defaultOpencodeConfig()` to `defaultAgentProviderSettings()`, `sanitizeOpencodeConfigWith`/`sanitizeOpencodeConfig`, parallel custom-array sanitization, dangling-active-custom reset, legacy-migration call (mirror codex). `OPENCODE_PRESET_DEFAULTS` lives in the renderer (T7) — sanitizer only needs the builtins list.
- `settings.ts` `defaultAgentProviderSettings()` += `opencode: {...}`.
Verify: `npm run typecheck`; existing `agentProviderSettings.test.ts` still passes (T8 adds opencode cases).

### T3 — SessionSpawner launch + agentEnv [req §2] ✅
Files: `src/main/sessions/SessionSpawner.ts`.
- `spawnNew`: `sessionId = (agentKind === 'claude') ? randomUUID() : null` — opencode falls into the null/hook path (unchanged logic, just confirm the `=== 'claude'` check is the gate).
- `newSessionCommand` += opencode branch: `opencode${opencodeCliArgs()}`.
- `resumeSessionCommand` += opencode branch: `opencode --session ${shellArg(sessionId)}${opencodeCliArgs()}` (no `-C cwd` — opencode takes cwd as the optional positional `opencode <cwd>`; but resume-by-id should still set cwd via the PTY's cwd, which `createDeferred` already does). Verify opencode resume syntax: `opencode --session <id>` + cwd from PTY.
- `opencodeCliArgs()`: `--auto` always; `--model <provider/model>` when provider card enabled and model set. No MCP args here (MCP via env, T4).
- `agentEnv('opencode')` block: scrub `CLAUDE_PROVIDER_ENV_KEYS` + Codex `OPENAI_API_KEY`/`envKey`/extraEnvVars; build `OPENCODE_CONFIG_CONTENT` JSON (provider override + MCP from T4) when card enabled && preset !== 'native'; set `OPENCODE_CONFIG_DIR=<userData>/opencode-plugin` (path resolved at call time via `app.getPath('userData')` — but `agentEnv` is in `SessionSpawner` which doesn't import `app`; pass the plugin dir in via a module-level setter like `_agentProviderSettings`, or compute from `process.env`). Set `MULTIAGENT_*` via existing `getPaneEnv` (no change). Do NOT set `MULTIAGENT_SESSION_ID`.
- Need a module-level `opencodePluginDir` setter, set from `handlers.ts` at startup (parallel to `setAgentProviderSettings`).
Verify: `npm run typecheck`; manual spawn test deferred to T9.

### T4 — Browser MCP injection [req §6]
Files: `src/main/mcp/McpInjector.ts`, `src/main/sessions/SessionSpawner.ts` (agentEnv merge), `src/renderer/src/components/SettingsPanel/McpSection.tsx`.
- `McpInjector.ts`: add `opencodeMcpUrl` state + `currentOpencodeMcpUrl()` accessor (same value as `codexMcpUrl` — the browser server is kind-agnostic); set in `inject`/`updateSettings`; clear in `cleanup`.
- `SessionSpawner.agentEnv('opencode')`: when building `OPENCODE_CONFIG_CONTENT`, merge `mcp.multiagent-browser = { type:'remote', url:<opencodeMcpUrl>, enabled:true }` (gated on `builtinBrowserEnabled !== false` from `currentMcpSettings()`). Single JSON object with provider + mcp.
- `McpSection.tsx`: widen `PreviewTab = 'claude' | 'codex' | 'opencode'`; add `buildOpencodePreviewJson()` (shows the `OPENCODE_CONFIG_CONTENT` JSON that would be injected); add tab button + body branch; update prose "Claude, Codex, and OpenCode".
Verify: `npm run typecheck`; manual MCP test deferred.

### T5 — Managed OpenCode plugin asset [req §4]
Files: `src/main/integration/assets/multiagent-opencode-plugin.js` (new), `src/main/integration/opencodePluginInstall.ts` (new — asset copy + content-hash gate), `src/main/ipc/handlers.ts` (call install at startup), `electron.vite.config.ts` (emit asset beside main).
- Plugin JS: bail unless `MULTIAGENT_ENV==='1'` + `MULTIAGENT_PTY_ID` + `MULTIAGENT_HOOK_PORT`; export hooks for `session.created` (→ POST `/agent-session`), `session.idle`→`stop`, `tool.execute.before`→`pre_tool_use`/`working`, `tool.execute.after`→`post_tool_use`, `permission.asked`→`permission_request`, `session.error`→`stop_failure`, `session.status`→`working` (→ POST `/agent-event`). 2s timeout, try/catch everything, never throw. Uses `fetch` (Bun has it) or falls back to `http` — keep it dependency-free.
- `opencodePluginInstall.ts`: copy bundled asset to `<userData>/opencode-plugin/multiagent-agent-state.js` (create dir), refresh only when content changes (hash compare). Mirror `managedHookController.refreshInstalledScript` pattern. Called once at startup (no toggle — plugin loads unconditionally for opencode panes via `OPENCODE_CONFIG_DIR`).
- `handlers.ts`: call `installOpencodePlugin()` near the managed-hook install (but ungated by the linking toggle — opencode plugin is always available).
- `electron.vite.config.ts`: add the plugin asset to the main-process emit (mirror how `multiagent-agent-state.{ps1,sh}` are emitted).
Verify: `npm run build` (asset emits); manual plugin-load test deferred.

### T6 — OpencodeSessionScanner + dispatch wiring [req §5]
Files: `src/main/sessions/OpencodeSessionScanner.ts` (new), `src/main/sessions/DeepSearcher.ts`, `src/main/ipc/handlers.ts`.
- `OpencodeSessionScanner`: opens `~/.local/share/opencode/opencode.db` readonly via `better-sqlite3` (synchronously — `better-sqlite3` is sync). Defensive: `PRAGMA table_info` to verify `session`/`message`/`part` tables + expected columns exist; on mismatch, `scanAll()` returns `[]` and `scanFile()` returns `null` (fail closed). 
  - `scanAll()`: `SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL` → map to `ScannedSession` (agentKind:'opencode', cwd=directory, projectName from last-2-segments, displayName=title, firstMessage/lastMessage via a follow-up query on `message`+`part` for text parts, messageCount via `SELECT count(*) FROM message WHERE session_id=?`, firstActivity/lastActivity from min/max `time_created` on `message`, gitBranch=null, filePath=`<dbpath>`, transcriptPath=`opencode:<sessionId>`, mtimeMs from `time_updated`).
  - `scanFile(sessionId)`: a single-session variant for deep-search hydration — `SELECT ... FROM session WHERE id=?` + message/part text. (DeepSearcher calls this when a search hit needs hydration.)
  - Caching: the DB is live (WAL); re-query each scanAll (no mtime cache needed — SQLite is fast).
- `DeepSearcher`: ctor += `opencodeScanner` param; `search()` roots += opencode root (the DB — but opencode deep search is query-based, not file-walk-based; add a separate `searchOpencodeDb()` path that runs the matcher as a SQL `LIKE`/`json_extract` query against `part.data` text fields, then maps to `FileResult`). This diverges from the Claude/Codex file-walk — see Open Question below.
- `handlers.ts`: construct `opencodeScanner`; `scanAllSessions` += opencode; `DeepSearcher` ctor += opencodeScanner; `sessions:latest-for-cwd`/`validate`/`recover-pending` scanner pick += opencode three-way branch; `validate`/`recover-pending` guards += `'opencode'`.
Verify: `npm run typecheck`; manual Session Browser test deferred.
**Open Question for brainstorm-spec:** DeepSearcher's `searchFile` is file-stream-based; OpenCode deep search needs a SQL-query-based path. The spec says "streams records through the existing pure Node streamer" but OpenCode has no files to stream — it's SQLite. I'll implement a SQL-based deep search for opencode (separate code path in DeepSearcher, not reusing `searchFile`). Flagging this as an implementation deviation from the spec's literal text but consistent with its intent (deep search works for opencode). Recorded for verify-spec.

### T7 — AgentProvidersSection opencode card [req §3 UI]
Files: `src/renderer/src/components/SettingsPanel/AgentProvidersSection.tsx`.
- Add imports for opencode types.
- `OPENCODE_BUILTIN_LIST`/`OPENCODE_BUILTIN_LABELS` (native/ollama/zai/chatgpt).
- `OPENCODE_PRESET_DEFAULTS`: native (blank), ollama (`baseUrl:'http://localhost:11434/v1'`, model `'ollama/<id>'`, no apiKey), zai (`baseUrl:'https://api.z.ai/api/coding/paas/v4'`, model `'zai/glm-5.2'`, apiKey user-fill), chatgpt (`providerId:'openai'`, model `'openai/gpt-4o'`, apiKey user-fill).
- `newOpencodeConfig`/`isOpencodeBuiltin`.
- `opencodeDraft` state + sync effect + `opencodeEnvExpanded`.
- 6 handlers: `flushOpencode`/`resetOpencodeDefaults`/`activateOpencode`/`addOpencodeCustom`/`renameOpencodeCustom`/`deleteOpencodeCustom`.
- Derived flags: `opencodeDisabled`/`opencodeActiveDefaults`/`opencodeResetVisible`/`opencodeAtDefaults`/`opencodeCustoms`.
- Third `<ProviderCard title="OpenCode">` block: enabled checkbox, `<ProviderPicker>`, fields (providerId, model, baseUrl, apiKey w/ show-hide), extra-env-vars expander. Fields shown when `preset !== 'native'`.
- `saveOpencodeOutgoing`/`loadOpencodeDraft`/`commitOpencodeActive` helpers (mirror codex).
- Provider-count badge in `index.tsx` += opencode.
Verify: `npm run typecheck`; manual card test deferred.

### T8 — Tests [Verification Steps]
Files: `tests/` or `src/.../*.test.ts` (find existing locations).
- `agentProviderSettings.test.ts`: opencode preset defaults (native/ollama/zai/chatgpt); preset accepts built-in or `custom:<id>`, rejects garbage→native; `opencodeCustomProviders` sanitization (bad id dropped, dup de-duped); dangling active `custom:<id>`→native; legacy migration (if applicable — opencode is new, likely no legacy).
- `agentProcessDetect.test.ts`: `opencode` name detection + `opencode-ai` package-path regex + bin-shim file regex.
- `agentSessionReportServer.test.ts`: `'opencode'` accepted in `/agent-session` and `/agent-event` (the `VALID_AGENT_KINDS` widening).
- If `agentProcessDetect.test.ts` doesn't exist, find where detection is tested (the explore agent said tests exist for it).
Verify: `npm run test` green.

### T9 — Self-check + status flip [Step 6/7]
- `npm run typecheck` clean.
- `npm run build` succeeds.
- `npm run lint` clean.
- `npm run test` (full unit suite) green.
- `npm run test:e2e` — run if quick; note any pre-existing failures.
- Update this plan sidecar: all tasks completed.
- Set spec Status → `review`.
- Report: task list, what's verified, what's flagged for brainstorm-spec (stale Verification/DoD text) and verify-spec (deep-search SQL deviation, manual scenarios not runnable without a live opencode pane).

## Notes for verify-spec

- **Spec text staleness (flag for brainstorm-spec, NOT silently fixed):** Verification Steps line 438-442 and DoD line 476-478 reference preset names `zen`/`anthropic` and "no `--auto` by default" — these contradict the Intended Behavior §3 (presets = native/ollama/zai/chatgpt) and §2 + Resolved OQ "Permission posture" (`--auto` IS the default). I built against the authoritative Intended Behavior + Resolved OQ, not the stale Verification/DoD text. The toggle-governs-OpenCode claim in DoD line 479-481 also contradicts the Resolved OQ "Plugin install mechanism" (toggle does NOT govern opencode). Flagging for brainstorm-spec to clean up.
- **Deep search implementation deviation:** spec §5 says "streams records through the existing pure Node streamer" — OpenCode has no JSONL files to stream; deep search is implemented as SQL queries against the SQLite DB (separate code path in DeepSearcher). Intent (deep search works for opencode) is met; mechanism differs. Flagged for verify-spec.
- **Manual verification scenarios** (spawn opencode pane, plugin linking, badge transitions, browser MCP, session browser) require a live `opencode` install + runtime — I can't run these in this session. They're for the human reviewer.
- **opencode.png asset** — user is adding it; the `AgentIcon` import is wired. If missing at runtime, the `<img>` renders nothing (no crash). Reviewer should confirm the asset lands before sign-off.