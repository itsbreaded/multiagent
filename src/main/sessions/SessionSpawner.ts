import * as fs from 'fs'
import { randomUUID } from 'crypto'
import type { PtyManager } from '../pty/PtyManager'
import type { AgentKind, AgentProviderSettings } from '../../shared/types'
import { currentClaudeMcpConfigPath, currentCodexMcpUrl, currentMcpSettings } from '../mcp/McpInjector'
import { defaultShell } from '../pty/shell'

let _agentProviderSettings: AgentProviderSettings | null = null

export function setAgentProviderSettings(settings: AgentProviderSettings): void {
  _agentProviderSettings = settings
}

export class SessionSpawner {
  constructor(private ptyManager: PtyManager) {}

  dispose(): void {
    // spec 047 phase 4: the Codex file-poll scanner is gone (replaced by managed hooks).
    // Nothing timer-based remains here.
  }

  async spawnNew(agentKind: AgentKind, cwd: string): Promise<{ ptyId: string; sessionId: string | null; detectionStartedAt: number }> {
    const startedAt = Date.now()
    assertUsableAgentCwd(cwd)
    // spec 047 phase 4: Codex no longer gets a launch-time id. App-launched Codex links via
    // the managed SessionStart hook (after a one-time `codex /hooks` trust); Claude keeps --session-id.
    const sessionId = agentKind === 'claude' ? randomUUID() : null
    const ptyId = this.ptyManager.createDeferred(
      cwd,
      agentLaunchCommand(newSessionCommand(agentKind, sessionId ?? undefined)),
      agentEnv(agentKind, sessionId ?? undefined),
      undefined, // initialSize: overridden by renderer's first pty:resize (see deferSpawn)
      false,     // allowCwdFallback: assertUsableAgentCwd already validated
      true,      // deferSpawn: wait for fitted size before spawning CLI
    )
    return { ptyId, sessionId, detectionStartedAt: startedAt }
  }

  async spawnResume(agentKind: AgentKind, sessionId: string, cwd: string): Promise<{ ptyId: string }> {
    assertUsableAgentCwd(cwd)
    const ptyId = this.ptyManager.createDeferred(
      cwd,
      agentLaunchCommand(resumeSessionCommand(agentKind, sessionId, cwd)),
      agentEnv(agentKind, agentKind === 'claude' ? sessionId : undefined),
      undefined, // initialSize: overridden by renderer's first pty:resize (see deferSpawn)
      false,     // allowCwdFallback
      true,      // deferSpawn: wait for fitted size before spawning CLI
    )
    return { ptyId }
  }
}

function assertUsableAgentCwd(cwd: string): void {
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`)
  }
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working directory is not a directory: ${cwd}`)
  }
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_\-.:\\/]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

function agentLaunchCommand(command: string): string[] {
  const e2eCommand = process.env['MULTIAGENT_E2E_USER_DATA_DIR']
    ? process.env['MULTIAGENT_E2E_AGENT_COMMAND']
    : undefined
  const resolvedCommand = e2eCommand || command
  if (process.platform === 'win32') {
    return ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', resolvedCommand]
  }
  return [defaultShell(), '-lc', resolvedCommand]
}

const CLAUDE_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const

// Raw provider overrides must not be able to make another agent unlaunchable
// merely because that provider card is disabled or scoped to a different agent.
const REQUIRED_PROCESS_ENV_KEYS = new Set([
  'path',
  'pathext',
  'systemroot',
  'windir',
  'comspec',
  'home',
  'userprofile',
  'temp',
  'tmp',
  'shell',
])

function removeExtraEnvKeys(
  vars: Record<string, string | undefined>,
  entries: AgentProviderSettings['claude']['extraEnvVars'] | undefined,
): void {
  for (const entry of entries ?? []) {
    const key = entry.key.trim()
    if (key && !REQUIRED_PROCESS_ENV_KEYS.has(key.toLowerCase())) vars[key] = undefined
  }
}

function applyExtraEnv(
  vars: Record<string, string | undefined>,
  entries: AgentProviderSettings['claude']['extraEnvVars'],
): void {
  for (const entry of entries) {
    const key = entry.key.trim()
    if (key) vars[key] = entry.enabled ? entry.value : undefined
  }
}

export function agentEnv(agentKind: AgentKind, claudeSessionId?: string): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {}
  const claudeCfg = _agentProviderSettings?.claude
  const codexCfg = _agentProviderSettings?.codex

  if (agentKind === 'claude') {
    vars['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'] = '1'
    // spec 047 phase 4: app-launched Claude already knows its id (--session-id below). Set
    // MULTIAGENT_SESSION_ID so the global managed Claude SessionStart hook bails early
    // instead of re-reporting the same id. (Codex does NOT set this — it relies on the hook.)
    if (claudeSessionId) vars['MULTIAGENT_SESSION_ID'] = claudeSessionId

    // Provider settings and raw overrides are scoped to their agent. Never let
    // Codex credentials inherited from the app process reach a Claude pane.
    vars['OPENAI_API_KEY'] = undefined
    if (codexCfg?.envKey.trim()) vars[codexCfg.envKey.trim()] = undefined
    removeExtraEnvKeys(vars, codexCfg?.extraEnvVars)

    if (!claudeCfg?.enabled) {
      for (const key of CLAUDE_PROVIDER_ENV_KEYS) vars[key] = undefined
      removeExtraEnvKeys(vars, claudeCfg?.extraEnvVars)
    } else {
      if (claudeCfg.preset !== 'native') {
        // Clear inherited routing/auth first so blank profile fields cannot fall
        // back to host credentials or endpoints.
        for (const key of CLAUDE_PROVIDER_ENV_KEYS) vars[key] = undefined
        if (claudeCfg.baseUrl)       vars['ANTHROPIC_BASE_URL'] = claudeCfg.baseUrl
        if (claudeCfg.authToken)     vars['ANTHROPIC_AUTH_TOKEN'] = claudeCfg.authToken
        if (claudeCfg.model)         vars['ANTHROPIC_MODEL'] = claudeCfg.model
        if (claudeCfg.opusModel)     vars['ANTHROPIC_DEFAULT_OPUS_MODEL'] = claudeCfg.opusModel
        if (claudeCfg.sonnetModel)   vars['ANTHROPIC_DEFAULT_SONNET_MODEL'] = claudeCfg.sonnetModel
        if (claudeCfg.haikuModel)    vars['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = claudeCfg.haikuModel
        if (claudeCfg.subagentModel) vars['CLAUDE_CODE_SUBAGENT_MODEL'] = claudeCfg.subagentModel
        if (claudeCfg.effortLevel)   vars['CLAUDE_CODE_EFFORT_LEVEL'] = claudeCfg.effortLevel
      }
      applyExtraEnv(vars, claudeCfg.extraEnvVars)
    }
  }

  if (agentKind === 'codex') {
    // Never pass Claude credentials or raw overrides to a Codex pane.
    for (const key of CLAUDE_PROVIDER_ENV_KEYS) vars[key] = undefined
    removeExtraEnvKeys(vars, claudeCfg?.extraEnvVars)

    if (!codexCfg?.enabled) {
      vars['OPENAI_API_KEY'] = undefined
      if (codexCfg?.envKey.trim()) vars[codexCfg.envKey.trim()] = undefined
      removeExtraEnvKeys(vars, codexCfg?.extraEnvVars)
    } else {
      if (codexCfg.preset !== 'native') {
        // Do not let an empty alternate-provider key fall back to an inherited
        // native or custom credential.
        vars['OPENAI_API_KEY'] = undefined
        if (codexCfg.envKey.trim()) {
          vars[codexCfg.envKey.trim()] = undefined
          if (codexCfg.apiKey) vars[codexCfg.envKey.trim()] = codexCfg.apiKey
        }
      }
      applyExtraEnv(vars, codexCfg.extraEnvVars)
    }
  }

  return vars
}

export function newSessionCommand(agentKind: AgentKind, sessionId?: string): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs(sessionId)}`
  // spec 047 phase 4: app-launched Codex links its session via the managed SessionStart hook
  // (the file-poll scanner is gone). We do NOT bypass the Codex hook trust gate — the user
  // accepts the managed hook once via `codex /hooks` (same as a CLI-launched Codex), and the
  // persisted trust then covers every future app/CLI Codex launch. Avoids the
  // --dangerously-bypass-hook-trust flag.
  return `codex${codexCliArgs()}`
}

export function resumeSessionCommand(agentKind: AgentKind, sessionId: string, cwd: string): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs()} --resume ${shellArg(sessionId)}`
  return `codex resume${codexCliArgs()} -C ${shellArg(cwd)} ${shellArg(sessionId)}`
}

function claudeCliArgs(sessionId?: string): string {
  const mcpConfigPath = currentClaudeMcpConfigPath()
  const args: string[] = []
  if (mcpConfigPath) args.push('--mcp-config', shellArg(mcpConfigPath))
  if (sessionId) args.push('--session-id', shellArg(sessionId))
  return args.length ? ` ${args.join(' ')}` : ''
}

function codexCliArgs(): string {
  const args = [
    '--no-alt-screen',
    '-c',
    psSingleQuoted('tui.animations=false'),
    '-c',
    psSingleQuoted('tui.terminal_title=[]'),
  ]

  const settings = currentMcpSettings()
  const mcpUrl = currentCodexMcpUrl()

  // Built-in browser server
  if (mcpUrl && (!settings || settings.builtinBrowserEnabled !== false)) {
    args.push(
      '-c',
      psSingleQuoted(`mcp_servers.multiagent-browser.url=${tomlLit(mcpUrl)}`),
      '-c',
      psSingleQuoted('mcp_servers.multiagent-browser.enabled=true')
    )
  }

  // Custom servers
  if (settings) {
    for (const server of settings.customServers) {
      if (!server.enabled || !server.name.trim()) continue
      const key = server.name.trim()
      if (server.type === 'stdio') {
        if (server.command) {
          args.push('-c', psSingleQuoted(`mcp_servers.${key}.command=${tomlLit(server.command)}`))
          if (server.args?.length) {
            // Skip any arg containing a single quote — TOML literal strings can't represent them.
            // Codex won't receive those args, but Claude handles them correctly via the JSON config file.
            const safeArgs = server.args.filter(a => !a.includes("'"))
            if (safeArgs.length) {
              args.push('-c', psSingleQuoted(`mcp_servers.${key}.args=${tomlLitArray(safeArgs)}`))
            }
          }
          if (server.env && Object.keys(server.env).length) {
            for (const [k, v] of Object.entries(server.env)) {
              if (!v.includes("'")) {
                args.push('-c', psSingleQuoted(`mcp_servers.${key}.env.${k}=${tomlLit(v)}`))
              }
            }
          }
          args.push('-c', psSingleQuoted(`mcp_servers.${key}.enabled=true`))
        }
      } else {
        if (server.url) {
          args.push(
            '-c', psSingleQuoted(`mcp_servers.${key}.url=${tomlLit(server.url)}`),
            '-c', psSingleQuoted(`mcp_servers.${key}.enabled=true`)
          )
        }
      }
    }
  }

  // Provider config: inject Codex -c overrides for model/provider/base_url/wire_api
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

  return ` ${args.join(' ')}`
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Build a TOML literal string (single-quoted) for use inside psSingleQuoted().
// psSingleQuoted doubles the single quotes so PowerShell passes them verbatim,
// and TOML's literal-string syntax accepts them without any double-quote dependency.
// This avoids the Windows/PowerShell 5.1 behaviour where double quotes passed to
// native executables can be stripped, breaking TOML array parsing.
function tomlLit(value: string): string {
  return `'${value}'`
}

function tomlLitArray(items: string[]): string {
  return `[${items.map(tomlLit).join(', ')}]`
}

