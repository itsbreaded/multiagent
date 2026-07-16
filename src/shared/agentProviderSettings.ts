import type {
  AgentProviderSettings,
  ClaudeProviderConfig,
  CodexProviderConfig,
  ClaudeBuiltinPreset,
  CodexBuiltinPreset,
  CodexWireApi,
  EnvVarEntry,
} from './types'
import { isCustomId } from './types'

const CLAUDE_BUILTINS: readonly ClaudeBuiltinPreset[] = ['native', 'deepseek', 'alibaba', 'ollama', 'zai']
const CODEX_BUILTINS: readonly CodexBuiltinPreset[] = ['native', 'deepseek', 'alibaba', 'ollama', 'zai']
const WIRE_APIS: readonly CodexWireApi[] = ['responses', 'chat']

const LEGACY_CUSTOM_ID = 'custom:legacy'

export function defaultClaudeConfig(): ClaudeProviderConfig {
  return {
    enabled: false,
    preset: 'native',
    baseUrl: '',
    authToken: '',
    model: '',
    opusModel: '',
    sonnetModel: '',
    haikuModel: '',
    subagentModel: '',
    effortLevel: '',
    extraEnvVars: [],
  }
}

export function defaultCodexConfig(): CodexProviderConfig {
  return {
    enabled: false,
    preset: 'native',
    providerName: '',
    model: '',
    baseUrl: '',
    envKey: '',
    apiKey: '',
    wireApi: 'responses',
    extraEnvVars: [],
  }
}

export function defaultAgentProviderSettings(): AgentProviderSettings {
  return {
    claude: defaultClaudeConfig(),
    codex: defaultCodexConfig(),
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

// Accept a built-in preset name OR any `custom:<id>` id. Anything else (unknown
// built-in, malformed custom, wrong type) falls back to `'native'` — never to a
// dangling custom id, which would spawn a half-routed pane. Returns a `string`;
// callers cast to the kind-specific preset id type.
function sanitizePresetField(value: unknown, builtins: readonly string[]): string {
  if (typeof value !== 'string') return 'native'
  if (builtins.includes(value)) return value
  if (isCustomId(value) && value.length > 'custom:'.length) return value
  return 'native'
}

function sanitizeExtraEnvVars(raw: unknown): EnvVarEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is EnvVarEntry =>
    isObject(e) &&
    typeof e['id'] === 'string' &&
    typeof e['key'] === 'string' &&
    typeof e['value'] === 'string' &&
    typeof e['enabled'] === 'boolean'
  ).map((e) => ({
    id: e['id'],
    key: e['key'],
    value: e['value'],
    enabled: e['enabled'],
  }))
}

// Sanitize a config whose preset value may be a built-in OR a `custom:<id>`.
// `builtins` selects which built-in union applies (Claude vs Codex).
function sanitizeClaudeConfigWith(raw: unknown, builtins: readonly string[]): ClaudeProviderConfig {
  const base = defaultClaudeConfig()
  if (!isObject(raw)) return base
  return {
    enabled: bool(raw['enabled'], base.enabled),
    preset: sanitizePresetField(raw['preset'], builtins) as ClaudeProviderConfig['preset'],
    baseUrl: str(raw['baseUrl'], base.baseUrl),
    authToken: str(raw['authToken'], base.authToken),
    model: str(raw['model'], base.model),
    opusModel: str(raw['opusModel'], base.opusModel),
    sonnetModel: str(raw['sonnetModel'], base.sonnetModel),
    haikuModel: str(raw['haikuModel'], base.haikuModel),
    subagentModel: str(raw['subagentModel'], base.subagentModel),
    effortLevel: str(raw['effortLevel'], base.effortLevel),
    extraEnvVars: sanitizeExtraEnvVars(raw['extraEnvVars']),
  }
}

function sanitizeCodexConfigWith(raw: unknown, builtins: readonly string[]): CodexProviderConfig {
  const base = defaultCodexConfig()
  if (!isObject(raw)) return base
  return {
    enabled: bool(raw['enabled'], base.enabled),
    preset: sanitizePresetField(raw['preset'], builtins) as CodexProviderConfig['preset'],
    providerName: str(raw['providerName'], base.providerName),
    model: str(raw['model'], base.model),
    baseUrl: str(raw['baseUrl'], base.baseUrl),
    envKey: str(raw['envKey'], base.envKey),
    apiKey: str(raw['apiKey'], base.apiKey),
    wireApi: oneOf(raw['wireApi'], WIRE_APIS, base.wireApi),
    extraEnvVars: sanitizeExtraEnvVars(raw['extraEnvVars']),
  }
}

export function sanitizeClaudeConfig(raw: unknown): ClaudeProviderConfig {
  return sanitizeClaudeConfigWith(raw, CLAUDE_BUILTINS)
}

export function sanitizeCodexConfig(raw: unknown): CodexProviderConfig {
  return sanitizeCodexConfigWith(raw, CODEX_BUILTINS)
}

function sanitizePresetMap<P extends string, V>(
  raw: unknown,
  allowedKeys: readonly P[],
  sanitizeValue: (v: unknown) => V
): Partial<Record<P, V>> | undefined {
  if (!isObject(raw)) return undefined
  const out: Partial<Record<P, V>> = {}
  for (const key of Object.keys(raw)) {
    if (!(allowedKeys as readonly string[]).includes(key)) continue
    out[key as P] = sanitizeValue(raw[key])
  }
  return out
}

// Sanitize a custom-providers array: each entry needs a `custom:` id, a
// non-empty name, and a sanitized config. Entries with bad ids/names are
// dropped; duplicate ids are de-duped (last wins) to survive manual file edits.
// Each stored config's preset is forced to be self-referential (`=== id`) so it
// can never be desynced from its entry by a hand edit.
function sanitizeCustomProviders<C extends ClaudeProviderConfig | CodexProviderConfig>(
  raw: unknown,
  sanitizeConfig: (v: unknown) => C,
): { id: `custom:${string}`; name: string; config: C }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const byId = new Map<string, { id: `custom:${string}`; name: string; config: C }>()
  for (const entry of raw) {
    if (!isObject(entry)) continue
    const id = str(entry['id'], '')
    const name = str(entry['name'], '').trim()
    if (!isCustomId(id) || id.length <= 'custom:'.length || !name) continue
    const config = sanitizeConfig(entry['config'])
    byId.set(id, { id: id as `custom:${string}`, name, config: { ...config, preset: id as `custom:${string}` } })
  }
  if (byId.size === 0) return undefined
  return Array.from(byId.values())
}

/**
 * Coerce arbitrary parsed JSON into a fully-typed `AgentProviderSettings`.
 * Every field is guaranteed to match its declared type, with per-field defaults
 * filled in for anything missing or wrong-typed. A partial or legacy file
 * degrades gracefully instead of crashing agent spawns (`SessionSpawner.agentEnv`
 * calls `.trim()` on `envKey` and iterates `extraEnvVars`, both of which throw
 * on a malformed object).
 *
 * Migration: a legacy file may store its single custom provider under
 * `claudePresets.custom` / `codexPresets.custom` (the old built-in slot). Before
 * sanitizing, we lift that into a named `custom:legacy` custom-provider entry so
 * the user's existing setup is preserved with zero action. The migration runs on
 * every read but only the first user `save` writes the migrated shape to disk,
 * after which the legacy `custom` key is gone and migration stops — which is why
 * the migrated id is deterministic, not random.
 */
export function sanitizeAgentProviderSettings(parsed: unknown): AgentProviderSettings {
  if (!isObject(parsed)) return defaultAgentProviderSettings()

  // --- Migration: lift a legacy `custom` built-in slot into a named custom provider ---
  const migrated = migrateLegacyCustom(parsed)

  const result: AgentProviderSettings = {
    claude: sanitizeClaudeConfig(migrated['claude']),
    codex: sanitizeCodexConfig(migrated['codex']),
  }

  const claudePresets = sanitizePresetMap(migrated['claudePresets'], CLAUDE_BUILTINS, sanitizeClaudeConfig)
  if (claudePresets) result.claudePresets = claudePresets

  const codexPresets = sanitizePresetMap(migrated['codexPresets'], CODEX_BUILTINS, sanitizeCodexConfig)
  if (codexPresets) result.codexPresets = codexPresets

  const claudeCustoms = sanitizeCustomProviders<ClaudeProviderConfig>(
    migrated['claudeCustomProviders'],
    sanitizeClaudeConfig,
  )
  if (claudeCustoms) result.claudeCustomProviders = claudeCustoms

  const codexCustoms = sanitizeCustomProviders<CodexProviderConfig>(
    migrated['codexCustomProviders'],
    sanitizeCodexConfig,
  )
  if (codexCustoms) result.codexCustomProviders = codexCustoms

  // --- Dangling active custom reference → reset to native ---
  // If the active config points at a `custom:<id>` that no longer exists in the
  // sanitized custom array, it must not reach SessionSpawner (half-empty routing).
  // Fall back to a fresh disabled native config.
  if (isCustomId(result.claude.preset) && !result.claudeCustomProviders?.some((c) => c.id === result.claude.preset)) {
    result.claude = defaultClaudeConfig()
  }
  if (isCustomId(result.codex.preset) && !result.codexCustomProviders?.some((c) => c.id === result.codex.preset)) {
    result.codex = defaultCodexConfig()
  }

  return result
}

// Returns a shallow-cloned object with the legacy `custom` slot (if any) lifted
// out of the preset maps and into a custom-providers array, and the active
// `preset: 'custom'` rewired to `custom:legacy`. No-op for files that already
// use the new shape.
function migrateLegacyCustom(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parsed }

  liftLegacyCustomSlot(out, 'claudePresets', 'claudeCustomProviders', 'claude')
  liftLegacyCustomSlot(out, 'codexPresets', 'codexCustomProviders', 'codex')

  return out
}

function liftLegacyCustomSlot(
  root: Record<string, unknown>,
  presetsKey: string,
  customsKey: string,
  activeKey: string,
): void {
  const presetsRaw = root[presetsKey]
  if (!isObject(presetsRaw) || !isObject(presetsRaw['custom'])) return

  const legacy = presetsRaw['custom'] as Record<string, unknown>
  // Only migrate if the legacy custom slot actually holds something
  // (non-empty baseUrl/model/providerName). An empty `custom` draft is just the
  // default and can be dropped silently.
  const hasBody =
    str(legacy['baseUrl'], '').trim() !== '' ||
    str(legacy['model'], '').trim() !== '' ||
    str(legacy['providerName'], '').trim() !== '' ||
    str(legacy['authToken'], '').trim() !== ''

  // Drop the legacy `custom` key from the preset map regardless (it is no longer
  // a built-in). Build the new preset map without it.
  const { custom: _dropped, ...restPresets } = presetsRaw
  root[presetsKey] = restPresets

  if (!hasBody) return

  // Push the legacy custom body into the customs array as `custom:legacy`.
  const existingCustoms = Array.isArray(root[customsKey]) ? root[customsKey] as unknown[] : []
  const legacyConfig = { ...legacy, preset: LEGACY_CUSTOM_ID }
  // Replace any prior `custom:legacy` entry (idempotent across launches).
  const filtered = existingCustoms.filter((e) => !(isObject(e) && str(e['id'], '') === LEGACY_CUSTOM_ID))
  root[customsKey] = [...filtered, { id: LEGACY_CUSTOM_ID, name: 'Custom', config: legacyConfig }]

  // Rewire the active config if it was the legacy `custom` slot.
  const active = root[activeKey]
  if (isObject(active) && str(active['preset'], '') === 'custom') {
    root[activeKey] = { ...active, preset: LEGACY_CUSTOM_ID }
  }
}
