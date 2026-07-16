# 048 — Extended Provider Presets & Multiple Custom Providers

## Problem

The Agent Providers settings (spec 017, done) ship a fixed set of built-in presets per agent
kind plus **one** `custom` slot. Two gaps:

1. **Missing defaults users actually use.** There is no preset for:
   - **Ollama local** — a local Ollama client at `http://localhost:11434` proxying to the cloud,
     running `glm-5.2:cloud`. Works with Claude Code's Anthropic Messages path. No auth token
     is required because the local Ollama service is already logged in and handles cloud
     auth upstream.
   - **z.ai** — exposes two spec-compatible endpoints:
     - Anthropic Messages: `https://api.z.ai/api/anthropic` (for Claude Code)
     - OpenAI Chat Completions: `https://api.z.ai/api/coding/paas/v4` (for Codex, `wire_api = chat`)
2. **Only one `custom` slot.** A user with two or more non-default providers (e.g. a self-host
   gateway and a third-party proxy) must both live in the single `custom` preset. Switching
   between them overwrites the other's credentials — a bad experience. The existing
   `claudePresets` / `codexPresets` maps already preserve per-builtin drafts across switches,
   but `custom` is a single key in those maps, so two customs collide.

This spec adds the two missing built-in presets and replaces the single `custom` slot with an
arbitrary list of **named custom providers**, each independently preserved when the user
switches away and back.

## Current Behavior

- `ClaudeProviderPreset = 'native' | 'deepseek' | 'alibaba' | 'custom'`
- `CodexProviderPreset  = 'native' | 'alibaba-token' | 'alibaba-payg' | 'custom'`
- `AgentProviderSettings.claude` / `.codex` hold the **active runtime** config.
  `claudePresets` / `codexPresets` are optional `Partial<Record<Preset, Config>>` maps that
  keep per-preset drafts. `applyClaudePreset` / `applyCodexPreset` save the current draft into
  the map under the outgoing preset and load the incoming preset's saved draft (or a fresh
  `newClaudePreset` / `newCodexPreset` seeded from `CLAUDE_PRESET_DEFAULTS` /
  `CODEX_PRESET_DEFAULTS`).
- `custom` is one key in each preset map — the collision point.
- UI (`AgentProvidersSection.tsx`): `PresetButtons` renders a fixed `presets: T[]` array with a
  fixed `labels` record. Codex `envKey` + `wireApi` fields are gated on
  `codexDraft.preset === 'custom'` only — a deviation from spec 017 decision #2 (wire_api should
  be visible in all presets).
- Sanitizer (`agentProviderSettings.ts`): `oneOf(raw['preset'], CLAUDE_PRESETS, ...)` rejects
  any preset string not in the fixed array; `sanitizePresetMap` drops map keys not in the array.
- Injection (`SessionSpawner.agentEnv` / `codexCliArgs`): reads only the active
  `_agentProviderSettings.claude` / `.codex`. For Claude, `ANTHROPIC_AUTH_TOKEN` is set only when
  non-empty and all `CLAUDE_PROVIDER_ENV_KEYS` are cleared first — so a token-less preset is
  already safe. For Codex, the API key is injected as `envKey` and `-c` TOML overrides set
  `model_provider`, `model`, `model_providers.NAME.*`, `wire_api`.

## Intended Behavior

### Data model (`src/shared/types.ts`)

Split the fixed preset union into "built-in" presets and treat `custom` as a **named, repeated
entry** rather than a single slot.

```typescript
export type ClaudeBuiltinPreset = 'native' | 'deepseek' | 'alibaba' | 'ollama' | 'zai'
export type CodexBuiltinPreset  = 'native' | 'alibaba-token' | 'alibaba-payg'

// A custom provider id, stored in the active config's `preset` field so the runtime +
// sanitizer can distinguish it from a built-in. Format: `custom:<uuid>`.
export type CustomProviderId = `custom:${string}`

// Active runtime config. `preset` is a built-in name OR a `custom:<uuid>` id.
export interface ClaudeProviderConfig {
  enabled: boolean
  preset: ClaudeBuiltinPreset | CustomProviderId
  baseUrl: string
  authToken: string
  model: string
  opusModel: string
  sonnetModel: string
  haikuModel: string
  subagentModel: string
  effortLevel: string
  extraEnvVars: EnvVarEntry[]
}

export interface CodexProviderConfig {
  enabled: boolean
  preset: CodexBuiltinPreset | CustomProviderId
  providerName: string
  model: string
  baseUrl: string
  envKey: string
  apiKey: string
  wireApi: CodexWireApi
  extraEnvVars: EnvVarEntry[]
}

// A saved named custom provider. `config.preset === 'custom'` (marker); the entry's
// identity is `id`. `name` is the user-facing label shown on the picker chip.
export interface ClaudeCustomProvider { id: CustomProviderId; name: string; config: ClaudeProviderConfig }
export interface CodexCustomProvider  { id: CustomProviderId; name: string; config: CodexProviderConfig }

export interface AgentProviderSettings {
  claude: ClaudeProviderConfig
  codex: CodexProviderConfig
  claudePresets?: Partial<Record<ClaudeBuiltinPreset, ClaudeProviderConfig>>
  codexPresets?: Partial<Record<CodexBuiltinPreset, CodexProviderConfig>>
  claudeCustomProviders?: ClaudeCustomProvider[]
  codexCustomProviders?: CodexCustomProvider[]
}
```

Non-negotiable: the active `claude` / `codex` configs remain the single source of truth that
`SessionSpawner` reads. Built-in drafts live in `claudePresets` / `codexPresets`; custom drafts
live in `claudeCustomProviders` / `codexCustomProviders`. Switching providers never mutates
another provider's saved draft — it only swaps which saved draft the active config mirrors.

### New built-in preset defaults

**Claude — Ollama local** (`ollama`):
```
baseUrl:    http://localhost:11434
model:      glm-5.2:cloud
authToken:  ''        // none — local Ollama is logged in upstream
// tier overrides blank
```
Verified working by the user: a local Ollama client at `http://localhost:11434` proxies to the
cloud and serves Claude Code's Anthropic Messages path token-less.

**Claude — z.ai** (`zai`):
```
baseUrl:    https://api.z.ai/api/anthropic
model:      glm-5.2
authToken:  ''        // user fills (z.ai API key); sent as Authorization: Bearer
```

z.ai's OpenAI endpoint and Ollama's OpenAI endpoint are **not** built-in Codex presets — the
user runs both via named custom providers (which multi-custom now preserves across switches).
Adding them as built-ins is intentionally out of scope.

### Main process injection (`src/main/sessions/SessionSpawner.ts`)

No structural change required. `agentEnv` / `codexCliArgs` already read only the active
`_agentProviderSettings.claude` / `.codex`. Because a custom provider's config is copied into
the active slot when selected, the injection path is unchanged — it does not need to know
whether the active config came from a built-in or a custom provider.

The one behavioural guarantee to preserve: for the `ollama` preset, `authToken === ''`, and
`agentEnv` must **not** inject `ANTHROPIC_AUTH_TOKEN` (it already skips empties) and must still
clear inherited `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` so the host's native key cannot
shadow the local proxy (it already does via `CLAUDE_PROVIDER_ENV_KEYS` clear). No new code.

### Sanitizer (`src/main/ipc/agentProviderSettings.ts`)

- Replace the `oneOf(raw['preset'], CLAUDE_PRESETS, …)` check with a validator that accepts a
  built-in name **or** a `custom:`-prefixed id. An unknown / malformed `preset` falls back to
  `'native'` (never to a dangling custom id).
- Sanitize `claudeCustomProviders` / `codexCustomProviders` arrays: each entry needs a string
  `id` matching `^custom:`, a non-empty string `name`, and a sanitized config whose `preset`
  marker is `'custom'`. Drop entries with bad ids; de-duplicate by id (last wins) to survive
  manual file edits.
- `sanitizePresetMap` keys become the built-in arrays only (no `custom` key).
- After sanitizing, if the active `claude.preset` is a `custom:<id>` that does not exist in
  `claudeCustomProviders`, reset active to `defaultClaudeConfig()` (native) — a dangling
  custom reference must not reach `SessionSpawner` and spawn a pane with half-empty routing.

### Settings store (`src/renderer/src/store/settings.ts`)

- `defaultAgentProviderSettings()` unchanged shape (no custom providers by default).
- No change required: `agentProviders` is persisted as the full `AgentProviderSettings` object
  (`Persisted` includes `agentProviders`; `saveSettings` writes it whole; `setAgentProviders` /
  `hydrateAgentProviders` spread it through and call `saveSettings`). The new
  `claudeCustomProviders` / `codexCustomProviders` arrays flow through automatically. The main
  file (`userData/agent-provider-settings.json`) is the source of truth via
  `settings:save-agent-providers`; localStorage is a mirror that hydrate overwrites.

### Settings UI (`src/renderer/src/components/SettingsPanel/AgentProvidersSection.tsx`)

Replace the fixed `PresetButtons` row with a **provider picker** that has three parts:

1. **Built-in preset buttons** — `native`, `deepseek`, `alibaba`, `ollama`, `zai` (Claude);
   `native`, `alibaba-token`, `alibaba-payg` (Codex). Same chip style as today.
2. **Custom provider chips** — one per entry in `claudeCustomProviders` / `codexCustomProviders`,
   labelled with the user-chosen `name`, with a small `✕` to delete (confirm before deleting —
   it discards that provider's saved credentials). Selecting a chip activates that custom
   provider.
3. **"+ Add custom"** button — prompts for a name (inline input, no system dialog), creates a
   new `CustomProviderId`, pushes a fresh `newClaudePreset('custom', …)`-style config into
   `claudeCustomProviders`, and activates it. The new config's `preset` marker is `'custom'`;
   the active config's `preset` becomes the new `custom:<id>`.

Switch logic (extends existing `applyClaudePreset` / `applyCodexPreset`):

- **Saving the outgoing provider:** if outgoing is a built-in, save the active draft into
  `claudePresets[builtin]`; if outgoing is a custom id, save it into the matching
  `claudeCustomProviders` entry's `config`. (Same for Codex.)
- **Loading the incoming provider:** if incoming is a built-in, load `claudePresets[builtin]`
  or a freshly seeded `newClaudePreset(builtin, enabled)`; if incoming is a custom id, load
  that custom entry's `config`. The active `claude` / `codex` is then set to the loaded config
  with its `preset` set to the incoming id.
- `flushClaude` / `flushCodex` (blur saves) must write the active draft back to whichever slot
  is active — built-in map **or** the matching custom entry — not always `claudePresets[preset]`
  as it does today.

Codex field visibility is unchanged from today: `envKey` and `wireApi` stay visible only for
the `custom` preset (where the user runs z.ai Codex and Ollama Codex). Widening them to the
alibaba built-ins is a pre-existing spec-017 loose end, **out of scope** here.

Disabled-card behaviour unchanged: fields gray out but config is preserved for re-enable.

### Migration

On load, before sanitizing, if a legacy file has `claudePresets.custom` (or `codexPresets.custom`)
with a non-native body (non-empty `baseUrl` or `model`):

- Create one `ClaudeCustomProvider` with a **deterministic** id `custom:legacy` (not
  `crypto.randomUUID()`), name `"Custom"`, config = the legacy custom config with
  `preset: 'custom'`.
- If the active `claude.preset === 'custom'`, switch the active config's `preset` to
  `custom:legacy` (keep the same body so the running config is unchanged).
- Drop the legacy `custom` key from `claudePresets` (it is no longer a built-in).
- Same for Codex.

**Why deterministic:** `settings:get-agent-providers` sanitizes on read but only writes to disk
on `settings:save-agent-providers` (a user edit). A random migration id would regenerate every
launch, making the active `custom:<id>` reference dangle on each relaunch (resetting to native)
and accumulating duplicate customs. `custom:legacy` is stable across launches; the migrated
shape replaces the legacy `custom` key on the first user edit, after which migration stops
running. User-created customs (the "+ Add custom" flow) still use `crypto.randomUUID()` — they
run once in the renderer and are saved immediately.

This preserves any existing single-custom setup with zero user action. Users who never used
custom see no change.

### Custom provider lifecycle (UI)

- **Add:** "+ Add custom" → inline name input → creates `custom:<uuid>` entry seeded from
  `newClaudePreset('custom', enabled)` / `newCodexPreset('custom', enabled)`, activates it,
  saves immediately.
- **Rename:** each custom chip is inline-renameable (click the label to edit). Needed because
  migration names the legacy provider "Custom" and that name is useless otherwise.
- **Delete:** chip `✕` → **overlay modal confirm** (the shared `#1a1b1e` overlay pattern from
  `src/renderer/src/styles/theme.ts`, not a native `confirm()`) warning that the provider's
  saved credentials will be discarded. Deleting the **active** provider falls back to
  `native` (disabled). Deleting a non-active provider leaves the active one untouched.

## Implementation Phases

1. **Types** — `shared/types.ts`: split preset unions into built-ins, add `CustomProviderId`,
   `ClaudeCustomProvider` / `CodexCustomProvider`, widen `config.preset`, add the two custom
   arrays to `AgentProviderSettings`.
2. **Sanitizer** — `agentProviderSettings.ts`: built-in-or-custom-id preset validator,
   custom-provider array sanitization, dangling-active-custom reset, legacy `custom`-key
   migration. Extend `agentProviderSettings.test.ts` for all of these.
3. **Store** — `settings.ts`: ensure custom arrays flow through hydrate/set/persist.
4. **UI** — `AgentProvidersSection.tsx`: provider picker (built-ins + custom chips + add +
   inline rename), switch/flush logic split by built-in vs custom, delete-with-overlay-confirm,
   preset-default seeders updated with `ollama` and `zai`. Codex field visibility unchanged.
5. **Verify** — typecheck, unit tests, manual: Ollama Claude pane routes token-less; z.ai
   Claude pane routes with a user key; two custom providers survive a round-trip switch;
   legacy single-custom file migrates.

## Risks

- **Token-less Ollama confirmed.** The user runs Ollama (local and cloud) with a **blank**
  `ANTHROPIC_AUTH_TOKEN` via the custom slot and it works — Claude Code starts and routes
  without a placeholder. So the `ollama` preset seeds `authToken: ''` and no dummy token is
  needed. (If a future Claude Code build refuses an empty token, only then seed a placeholder
  like `'ollama'`.)
- **z.ai auth header.** Confirmed by the user: z.ai's `/api/anthropic` endpoint accepts
  `ANTHROPIC_AUTH_TOKEN` (Bearer), so the existing Claude card's `authToken` field works with
  no UI change. If a future z.ai change requires `x-api-key`, the card would need to expose
  `ANTHROPIC_API_KEY` — re-verify if z.ai starts 401-ing.
- **z.ai / Ollama via Codex custom.** The user runs both through the Codex `custom` slot today
  and it works. Multi-custom preserves each as a named provider, but the Codex custom fields
  (`envKey`, `wireApi`, `apiKey`) stay as-is — no new built-in Codex presets are added for them.
- **Custom id collisions across machines.** Ids are `custom:<uuid>`, generated in the renderer
  via `crypto.randomUUID()` (the legacy migration uses the fixed `custom:legacy`). Settings
  files are per-machine (not synced), so collision is not a concern; if a user hand-edits two
  equal ids, the sanitizer de-dupes (last wins).
- **`PresetButtons` is generic over a fixed `T extends string`.** The new picker cannot reuse
  it directly for the mixed built-in + custom set; build a dedicated picker component. Keep
  `PresetButtons` for the `wireApi` toggle and any other fixed-enum rows.

## Verification Steps

- `npm run typecheck` passes.
- `npm run test` — `agentProviderSettings.test.ts` covers: `ollama`/`zai` Claude defaults;
  preset accepts built-in or `custom:<id>` and rejects garbage to `native`; custom array
  sanitization (bad id dropped, dup id de-duped); dangling active `custom:<id>` resets to
  native; legacy `claudePresets.custom` migrates to a `claudeCustomProviders` entry with id
  `custom:legacy` and active preset rewires.
- Manual: enable Claude `ollama` preset, spawn a Claude pane, confirm it reaches
  `http://localhost:11434` with no `ANTHROPIC_AUTH_TOKEN` and no inherited `ANTHROPIC_API_KEY`.
- Manual: enable Claude `zai`, fill the auth token, spawn a pane, confirm routing to
  `https://api.z.ai/api/anthropic` with `Authorization: Bearer …`.
- Manual: create two Claude custom providers ("Gateway A", "Gateway B") with distinct
  base URLs / tokens; switch A → B → A and confirm A's credentials are intact (the regression
  this spec exists to fix). Repeat on the Codex card with two custom providers (e.g. z.ai
  OpenAI + Ollama OpenAI) to confirm the same isolation.
- Manual: delete a custom provider via its chip `✕` and confirm the overlay confirm fires and
  the entry is removed; if it was active, active falls back to `native`.

## Definition of Done

- [ ] `ollama` and `zai` built-in presets exist for Claude with the defaults listed above
      (`glm-5.2:cloud` token-less for Ollama, `glm-5.2` + user token for z.ai) and editable
      fields after selection.
- [ ] A user can create N named custom providers per agent kind and switch between them
      without any provider's saved credentials being overwritten.
- [ ] Custom providers can be renamed inline; deleting one prompts via the overlay modal and
      never silently discards credentials; deleting the active provider falls back to `native`.
- [ ] Legacy single-`custom` settings files migrate to one named custom provider (id
      `custom:legacy`) with the user's existing config preserved and the active preset rewired.
- [ ] A dangling `custom:<id>` active reference (e.g. a deleted provider) resets to native
      instead of spawning a misconfigured pane.
- [ ] `SessionSpawner` injection is unchanged in behaviour; built-in and custom configs flow
      through the same active-config path.
- [ ] `npm run typecheck` + `npm run test` pass.
- [ ] Manual verifications above pass.