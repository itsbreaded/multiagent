# 017 — Agent Provider Configuration

## Problem

The current env var override UI (committed June 2026) lets users inject arbitrary key-value pairs into all spawned processes. That's good infrastructure, but it's too low-level for the real use case: routing **Claude Code** or **Codex** to an alternative model provider (DeepSeek, Alibaba Model Studio, etc.).

Three problems with the current approach:

1. **No per-agent-kind gating.** `_customEnvVars` in `PtyManager.buildEnv()` applies to every spawned process — shells included. Provider API keys should only reach the agent they belong to.
2. **No structure.** The flat key-value list gives no guidance on what to set, has no presets, and mixes API config with whatever other vars a user happens to add.
3. **Codex can't be configured via env vars alone.** Codex provider switching requires structured `-c` CLI overrides (`model_provider`, `model`, `base_url`, `env_key`, `wire_api`). The CLAUDE.md constraint forbids writing to user config files (`~/.codex/config.toml`), so the `-c` override path in `SessionSpawner.codexCliArgs()` is the only safe mechanism.

## Decisions Made

1. **Claude model fields:** Show `ANTHROPIC_MODEL` as the primary model field. The per-tier mappings (`ANTHROPIC_DEFAULT_OPUS_MODEL`, etc.) are granular and shown in an expandable "Model tier overrides" section.
2. **Codex wire_api:** Exposed as a visible field in all presets (not just Custom), since Alibaba Coding Plan requires `chat` while Token Plan / Pay-as-you-go require `responses`.
3. **Raw env vars:** Removed as a global section. Each agent card (Claude, Codex) gets its own "Extra env vars" expander — a key-value list scoped to that agent only. The current global `EnvVarsSection` and `_customEnvVars` in `PtyManager` are removed.
4. **Scope:** Global config only (one Claude profile, one Codex profile, applies to all sessions of that kind).
5. **`agentKind` threading:** `agentEnv()` in `SessionSpawner` builds the full merged env (provider vars + UI flags + per-agent raw vars) and passes it as `extraEnv`. `PtyManager` stays unaware of agent kinds.

## Current Behavior

- `PtyManager._customEnvVars` applies to all panes.
- `SessionSpawner.agentEnv()` returns only Claude rendering flags; no provider config.
- `SessionSpawner.codexCliArgs()` handles MCP server `-c` overrides only; no provider/model config.
- Settings > Environment: global flat key-value list.

## Intended Behavior

### Data model

**New / updated types in `src/shared/types.ts`:**

```typescript
export type ClaudeProviderPreset = 'native' | 'deepseek' | 'alibaba' | 'custom'
export type CodexProviderPreset  = 'native' | 'alibaba-token' | 'alibaba-payg' | 'custom'
export type CodexWireApi = 'responses' | 'chat'

export interface ClaudeProviderConfig {
  enabled: boolean
  preset: ClaudeProviderPreset
  baseUrl: string                 // ANTHROPIC_BASE_URL
  authToken: string               // ANTHROPIC_AUTH_TOKEN  (masked in UI)
  model: string                   // ANTHROPIC_MODEL
  // Tier overrides (collapsed by default)
  opusModel: string               // ANTHROPIC_DEFAULT_OPUS_MODEL
  sonnetModel: string             // ANTHROPIC_DEFAULT_SONNET_MODEL
  haikuModel: string              // ANTHROPIC_DEFAULT_HAIKU_MODEL
  subagentModel: string           // CLAUDE_CODE_SUBAGENT_MODEL
  effortLevel: string             // CLAUDE_CODE_EFFORT_LEVEL
  extraEnvVars: EnvVarEntry[]     // per-agent raw overrides
}

export interface CodexProviderConfig {
  enabled: boolean
  preset: CodexProviderPreset
  providerName: string            // TOML section key, e.g. "my_provider"
  model: string                   // model ID
  baseUrl: string                 // base_url in TOML section
  envKey: string                  // env_key in TOML section (e.g. "OPENAI_API_KEY")
  apiKey: string                  // actual key value, injected as env var  (masked in UI)
  wireApi: CodexWireApi           // wire_api in TOML section
  extraEnvVars: EnvVarEntry[]     // per-agent raw overrides
}

export interface AgentProviderSettings {
  claude: ClaudeProviderConfig
  codex: CodexProviderConfig
}
```

`EnvVarEntry` already exists from the prior commit.

**New IPC channels (add to `IPCChannels` and `InvokeChannels`):**
```typescript
'settings:get-agent-providers': () => AgentProviderSettings
'settings:save-agent-providers': (settings: AgentProviderSettings) => void
```

**Remove IPC channels no longer needed:**
```typescript
'settings:get-env-vars'    // was global raw vars → gone
'settings:save-env-vars'   // was global raw vars → gone
```

### Known presets

**Claude Code — DeepSeek:**
```
baseUrl:       https://api.deepseek.com/anthropic
model:         deepseek-v4-pro
opusModel:     deepseek-v4-pro
sonnetModel:   deepseek-v4-pro
haikuModel:    deepseek-v4-flash
subagentModel: deepseek-v4-flash
effortLevel:   max
```
_(authToken left blank for user to fill)_

**Claude Code — Alibaba Model Studio (international):**
```
baseUrl: https://dashscope-intl.aliyuncs.com/apps/anthropic
model:   qwen3.5-plus
```

**Codex — Alibaba Token Plan (responses API):**
```
providerName: alibaba_token
model:        qwen3.6-plus
baseUrl:      https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
envKey:       OPENAI_API_KEY
wireApi:      responses
```

**Codex — Alibaba Pay-as-you-go (responses API):**
```
providerName: alibaba_payg
model:        qwen3.6-plus
baseUrl:      https://dashscope-intl.aliyuncs.com/compatible-mode/v1
envKey:       OPENAI_API_KEY
wireApi:      responses
```

### Main process injection

**`src/main/sessions/SessionSpawner.ts`** (primary injection point):

Add a module-level settings store at the top of the file:
```typescript
let _agentProviderSettings: AgentProviderSettings | null = null

export function setAgentProviderSettings(settings: AgentProviderSettings): void {
  _agentProviderSettings = settings
}
```

Rewrite `agentEnv(agentKind)` to build the full merged env:

```typescript
function agentEnv(agentKind: AgentKind): Record<string, string> {
  const vars: Record<string, string> = {}

  if (agentKind === 'claude') {
    // Rendering flags (existing)
    vars['CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL'] = '1'
    vars['CLAUDE_CODE_NO_FLICKER'] = '1'
    // Provider config
    const cfg = _agentProviderSettings?.claude
    if (cfg?.enabled && cfg.preset !== 'native') {
      if (cfg.baseUrl)      vars['ANTHROPIC_BASE_URL'] = cfg.baseUrl
      if (cfg.authToken)    vars['ANTHROPIC_AUTH_TOKEN'] = cfg.authToken
      if (cfg.model)        vars['ANTHROPIC_MODEL'] = cfg.model
      if (cfg.opusModel)    vars['ANTHROPIC_DEFAULT_OPUS_MODEL'] = cfg.opusModel
      if (cfg.sonnetModel)  vars['ANTHROPIC_DEFAULT_SONNET_MODEL'] = cfg.sonnetModel
      if (cfg.haikuModel)   vars['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = cfg.haikuModel
      if (cfg.subagentModel) vars['CLAUDE_CODE_SUBAGENT_MODEL'] = cfg.subagentModel
      if (cfg.effortLevel)  vars['CLAUDE_CODE_EFFORT_LEVEL'] = cfg.effortLevel
    }
    // Per-agent raw overrides
    for (const e of cfg?.extraEnvVars ?? []) {
      if (e.enabled && e.key.trim()) vars[e.key.trim()] = e.value
    }
  }

  if (agentKind === 'codex') {
    const cfg = _agentProviderSettings?.codex
    if (cfg?.enabled && cfg.preset !== 'native') {
      // Inject the API key as the env var Codex is configured to look for
      if (cfg.envKey.trim() && cfg.apiKey) vars[cfg.envKey.trim()] = cfg.apiKey
    }
    // Per-agent raw overrides
    for (const e of cfg?.extraEnvVars ?? []) {
      if (e.enabled && e.key.trim()) vars[e.key.trim()] = e.value
    }
  }

  return vars
}
```

Extend `codexCliArgs()` to inject provider `-c` overrides when config is active:

```typescript
// After existing MCP args block:
const codexCfg = _agentProviderSettings?.codex
if (codexCfg?.enabled && codexCfg.preset !== 'native' && codexCfg.providerName.trim()) {
  const n = codexCfg.providerName.trim()
  args.push('-c', psSingleQuoted(`model_provider=${tomlLit(n)}`))
  if (codexCfg.model)   args.push('-c', psSingleQuoted(`model=${tomlLit(codexCfg.model)}`))
  if (codexCfg.baseUrl) args.push('-c', psSingleQuoted(`model_providers.${n}.base_url=${tomlLit(codexCfg.baseUrl)}`))
  args.push('-c', psSingleQuoted(`model_providers.${n}.name=${tomlLit(n)}`))
  if (codexCfg.envKey)  args.push('-c', psSingleQuoted(`model_providers.${n}.env_key=${tomlLit(codexCfg.envKey.trim())}`))
  args.push('-c', psSingleQuoted(`model_providers.${n}.wire_api=${tomlLit(codexCfg.wireApi)}`))
}
```

Note: Codex CLI `-c` uses dot notation for nested keys. Needs verification that `model_providers.NAME.base_url=...` works in the installed Codex version before finalising — see risks below.

**`src/main/pty/PtyManager.ts`:**

Remove `_customEnvVars`, `setCustomEnvVars`, and the `Object.assign(env, _customEnvVars)` call from `buildEnv()`. All per-agent env vars now flow through `agentEnv()` → `extraEnv` in `createDeferred()`.

**`src/main/ipc/handlers.ts`:**

- Remove `settings:get-env-vars` and `settings:save-env-vars` handlers and the `ENV_VARS_FILE` persistence block.
- Add `settings:get-agent-providers` and `settings:save-agent-providers` handlers, persisting to `userData/agent-provider-settings.json`.
- On startup: load from disk, call `setAgentProviderSettings()`.
- On save: call `setAgentProviderSettings()`.

**`src/renderer/src/store/settings.ts`:**

- Remove `envVarOverrides`, `setEnvVarOverrides`, `hydrateEnvVarOverrides` and all references.
- Add `agentProviders: AgentProviderSettings`, `setAgentProviders`, `hydrateAgentProviders`.
- Update `Persisted`, `defaultSettings()`, `loadSettings()`, `saveSettings()`, and all setter save calls.

### Settings UI

**Remove** `src/renderer/src/components/SettingsPanel/EnvVarsSection.tsx`.

**New** `src/renderer/src/components/SettingsPanel/AgentProvidersSection.tsx`:

Two cards (Claude Code, Codex), each structured as:

```
┌─ Claude Code ─────────────────────────────────────────────────┐
│  [●] Enabled                                                   │
│                                                                │
│  Preset:  [Native]  [DeepSeek]  [Alibaba]  [Custom]           │
│                                                                │
│  Base URL     _______________________________________________  │
│  Auth Token   ●●●●●●●●●●●●●●●●●●●●  [show]                   │
│  Model        _______________________________________________  │
│                                                                │
│  ▶ Model tier overrides (collapsed)                           │
│    Opus model     _________________________________________    │
│    Sonnet model   _________________________________________    │
│    Haiku model    _________________________________________    │
│    Subagent model _________________________________________    │
│    Effort level   _________________________________________    │
│                                                                │
│  ▶ Extra env vars (collapsed)                                 │
│    [key-value list, same component as old EnvVarsSection]     │
└────────────────────────────────────────────────────────────────┘

┌─ Codex ────────────────────────────────────────────────────────┐
│  [●] Enabled                                                   │
│                                                                │
│  Preset:  [Native]  [Alibaba Token]  [Alibaba PAYG]  [Custom] │
│                                                                │
│  Provider name  _____________________________________________  │
│  Model          _____________________________________________  │
│  Base URL       _____________________________________________  │
│  Env key        _____________________________________________  │
│  API key        ●●●●●●●●●●●●●●●●●●●●  [show]                 │
│  Wire API       [responses]  [chat]                           │
│                                                                │
│  ▶ Extra env vars (collapsed)                                 │
└────────────────────────────────────────────────────────────────┘
```

Behaviour:
- Selecting a preset fills all fields with known-good defaults; fields remain editable after.
- Auth token / API key fields masked by default; dedicated show/hide toggle.
- "Model tier overrides" and "Extra env vars" sections are collapsed by default, expanded on click.
- When card is disabled, fields are visible but grayed out (config preserved for re-enable).
- Changes are saved immediately on blur / toggle (matches existing settings UX).
- The `EnvVarEntry` key-value editor component is extracted into a shared helper (no separate full-page section anymore) and reused inside each agent card's "Extra env vars" expander.

**`src/renderer/src/components/SettingsPanel/index.tsx`:**

- Replace section `'environment'` with `'providers'`.
- Count badge = total active provider configs + total active extra env vars across both cards.
- Render `<AgentProvidersSection />` in the section body.

## Implementation Phases

1. **Types** — Add new types to `shared/types.ts`, remove old env var IPC channels, add new ones
2. **Main** — `SessionSpawner` (agentEnv + codexCliArgs), `PtyManager` (remove global vars), `handlers.ts` (swap IPC handlers)
3. **Store** — swap `envVarOverrides` for `agentProviders` in `settings.ts`
4. **UI** — new `AgentProvidersSection`, extract key-value editor helper, update `SettingsPanel/index.tsx`
5. **Cleanup** — delete `EnvVarsSection.tsx`

## Risks

- **Codex `-c` nested key syntax.** The TOML flat dot notation `model_providers.NAME.base_url` injected via `-c` may not work in all Codex versions. The existing `-c mcp_servers.NAME.url=...` pattern already uses this style and works today — that's a strong positive signal. Still worth a live test with a Codex install pointed at Alibaba before shipping.
- **`ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY` conflict.** If the user has `ANTHROPIC_API_KEY` set in their system environment, Claude Code may prefer it over `ANTHROPIC_AUTH_TOKEN`. The existing `buildEnv()` already deletes `ANTHROPIC_API_KEY` when it's empty (`if (env['ANTHROPIC_API_KEY'] === '') delete env['ANTHROPIC_API_KEY']`). When a provider is active, we should also `delete env['ANTHROPIC_API_KEY']` in `buildEnv()` (or in the injected env, as the last step) to prevent the native key from shadowing the provider token.
- **Codex `responses` vs `chat` wire_api.** Current Codex versions may reject `wire_api = "chat"`. Older Codex (v0.80.0) is required for Alibaba Coding Plan. We can't detect installed version; wire_api is exposed as a user field so they can match their install.

## Definition of Done

- [ ] Selecting a preset and entering an API key is sufficient to route Claude Code or Codex to an alternative provider
- [ ] Claude provider env vars inject only into Claude panes; Codex `-c` overrides inject only into Codex panes; shells get neither
- [ ] Disabling a card restores native behavior without wiping the saved config
- [ ] Extra env vars on each card are scoped to that agent only
- [ ] Global raw env var section is gone; no regressions in existing functionality
- [ ] `npm run typecheck` passes
- [ ] Manual verification: Claude Code session routes to alternative endpoint when enabled
- [ ] Manual verification: Codex session receives correct `-c` overrides when enabled
