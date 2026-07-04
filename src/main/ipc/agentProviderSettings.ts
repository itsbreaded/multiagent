import type {
  AgentProviderSettings,
  ClaudeProviderConfig,
  CodexProviderConfig,
  ClaudeProviderPreset,
  CodexProviderPreset,
  CodexWireApi,
  EnvVarEntry,
} from '../../shared/types'

const CLAUDE_PRESETS: readonly ClaudeProviderPreset[] = ['native', 'deepseek', 'alibaba', 'custom']
const CODEX_PRESETS: readonly CodexProviderPreset[] = ['native', 'alibaba-token', 'alibaba-payg', 'custom']
const WIRE_APIS: readonly CodexWireApi[] = ['responses', 'chat']

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

export function sanitizeClaudeConfig(raw: unknown): ClaudeProviderConfig {
  const base = defaultClaudeConfig()
  if (!isObject(raw)) return base
  return {
    enabled: bool(raw['enabled'], base.enabled),
    preset: oneOf(raw['preset'], CLAUDE_PRESETS, base.preset),
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

export function sanitizeCodexConfig(raw: unknown): CodexProviderConfig {
  const base = defaultCodexConfig()
  if (!isObject(raw)) return base
  return {
    enabled: bool(raw['enabled'], base.enabled),
    preset: oneOf(raw['preset'], CODEX_PRESETS, base.preset),
    providerName: str(raw['providerName'], base.providerName),
    model: str(raw['model'], base.model),
    baseUrl: str(raw['baseUrl'], base.baseUrl),
    envKey: str(raw['envKey'], base.envKey),
    apiKey: str(raw['apiKey'], base.apiKey),
    wireApi: oneOf(raw['wireApi'], WIRE_APIS, base.wireApi),
    extraEnvVars: sanitizeExtraEnvVars(raw['extraEnvVars']),
  }
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

/**
 * Coerce arbitrary parsed JSON into a fully-typed `AgentProviderSettings`.
 * Every field is guaranteed to match its declared type, with per-field defaults
 * filled in for anything missing or wrong-typed. A partial or legacy file
 * degrades gracefully instead of crashing agent spawns (`SessionSpawner.agentEnv`
 * calls `.trim()` on `envKey` and iterates `extraEnvVars`, both of which throw
 * on a malformed object).
 */
export function sanitizeAgentProviderSettings(parsed: unknown): AgentProviderSettings {
  if (!isObject(parsed)) return defaultAgentProviderSettings()

  const result: AgentProviderSettings = {
    claude: sanitizeClaudeConfig(parsed['claude']),
    codex: sanitizeCodexConfig(parsed['codex']),
  }

  const claudePresets = sanitizePresetMap(parsed['claudePresets'], CLAUDE_PRESETS, sanitizeClaudeConfig)
  if (claudePresets) result.claudePresets = claudePresets

  const codexPresets = sanitizePresetMap(parsed['codexPresets'], CODEX_PRESETS, sanitizeCodexConfig)
  if (codexPresets) result.codexPresets = codexPresets

  return result
}
