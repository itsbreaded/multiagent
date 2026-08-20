import * as fs from 'fs'
import { randomUUID } from 'crypto'
import type { PtyManager } from '../pty/PtyManager'
import { buildEnv } from '../pty/buildEnv'
import type { CodexAppServerManager } from '../integration/codexAppServer'
import type { AgentKind, AgentProviderSettings } from '../../shared/types'
import { currentClaudeMcpConfigPath, currentCodexMcpUrl, currentOpencodeMcpUrl, currentMcpSettings, currentUiMcpUrl } from '../mcp/McpInjector'
import { defaultShell } from '../pty/shell'

let _agentProviderSettings: AgentProviderSettings | null = null

export function setAgentProviderSettings(settings: AgentProviderSettings): void {
  _agentProviderSettings = settings
}

// spec 052: the installed managed plugin's absolute file path, set at startup from
// handlers.ts. Injected into the `plugin` array of OPENCODE_CONFIG_CONTENT so OpenCode
// loads it process-scoped, without mutating ~/.config/opencode/ (OpenCode has no
// per-process plugin-directory override — only project `.opencode/plugins/` and global
// `~/.config/opencode/plugins/` are scanned).
let _opencodePluginPath: string | null = null

export function setOpencodePluginPath(pathToPlugin: string | null): void {
  _opencodePluginPath = pathToPlugin
}

export class SessionSpawner {
  constructor(
    private ptyManager: PtyManager,
    private readonly options: { getPaneEnv?: (ptyId: string) => Record<string, string | undefined>; codexAppServer?: CodexAppServerManager } = {},
  ) {}

  async dispose(): Promise<void> {
    // spec 047 phase 4: the Codex file-poll scanner is gone (replaced by managed hooks).
    await this.options.codexAppServer?.dispose()
  }

  async disposePty(ptyId: string): Promise<void> {
    await this.options.codexAppServer?.disposePty(ptyId)
  }

  bindAgentSession(ptyId: string, agentKind: AgentKind, sessionId: string): void {
    if (agentKind === 'codex') this.options.codexAppServer?.bindSession(ptyId, sessionId)
  }

  async spawnNew(agentKind: AgentKind, cwd: string): Promise<{ ptyId: string; sessionId: string | null; detectionStartedAt: number }> {
    const startedAt = Date.now()
    assertUsableAgentCwd(cwd)
    // spec 047 phase 4: Codex no longer gets a launch-time id. App-launched Codex links via
    // the managed SessionStart hook (after a one-time `codex /hooks` trust); Claude keeps --session-id.
    const sessionId = agentKind === 'claude' ? randomUUID() : null
    const requestedId = agentKind === 'codex' ? randomUUID() : undefined
    const extraEnv = agentEnv(agentKind, sessionId ?? undefined)
    const sidecar = await this.prepareCodex(requestedId, agentKind, cwd, extraEnv)
    try {
      const ptyId = this.ptyManager.createDeferred(
        cwd,
        agentLaunchCommand(sidecar ? codexRemoteCommand(sidecar.socketPath) : newSessionCommand(agentKind, sessionId ?? undefined)),
        extraEnv,
        undefined, false, true, 'new-agent', requestedId,
      )
      return { ptyId, sessionId, detectionStartedAt: startedAt }
    } catch (error) {
      if (requestedId) await this.options.codexAppServer?.disposePty(requestedId)
      throw error
    }
  }

  async spawnResume(agentKind: AgentKind, sessionId: string, cwd: string): Promise<{ ptyId: string }> {
    assertUsableAgentCwd(cwd)
    const requestedId = agentKind === 'codex' ? randomUUID() : undefined
    const extraEnv = agentEnv(agentKind, agentKind === 'claude' ? sessionId : undefined)
    const sidecar = await this.prepareCodex(requestedId, agentKind, cwd, extraEnv)
    try {
      const ptyId = this.ptyManager.createDeferred(
        cwd,
        agentLaunchCommand(sidecar ? codexRemoteCommand(sidecar.socketPath, sessionId, cwd) : resumeSessionCommand(agentKind, sessionId, cwd)),
        extraEnv,
        undefined, false, true, 'resume-agent', requestedId,
      )
      return { ptyId }
    } catch (error) {
      if (requestedId) await this.options.codexAppServer?.disposePty(requestedId)
      throw error
    }
  }

  private async prepareCodex(
    requestedId: string | undefined,
    agentKind: AgentKind,
    cwd: string,
    extraEnv: Record<string, string | undefined>,
  ): Promise<{ socketPath: string } | null> {
    if (agentKind !== 'codex' || !requestedId || !this.options.codexAppServer || process.env['MULTIAGENT_E2E_USER_DATA_DIR']) return null
    try {
      const paneEnv = this.options.getPaneEnv?.(requestedId) ?? {}
      return await this.options.codexAppServer.prepare(requestedId, cwd, buildEnv({ ...extraEnv, ...paneEnv }))
    } catch {
      // Sidecar preparation is best-effort before the PTY exists. The direct CLI
      // fallback remains available; PTY creation still fails normally if its own
      // environment or launch setup is invalid.
      return null
    }
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
  const opencodeCfg = _agentProviderSettings?.opencode

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

  if (agentKind === 'opencode') {
    // spec 052: never let Claude or Codex credentials inherited from the app process reach
    // an OpenCode pane. Scrub both agents' provider env keys + their extra env vars.
    for (const key of CLAUDE_PROVIDER_ENV_KEYS) vars[key] = undefined
    removeExtraEnvKeys(vars, claudeCfg?.extraEnvVars)
    vars['OPENAI_API_KEY'] = undefined
    if (codexCfg?.envKey.trim()) vars[codexCfg.envKey.trim()] = undefined
    removeExtraEnvKeys(vars, codexCfg?.extraEnvVars)

    // Provider + MCP + plugin injection via OPENCODE_CONFIG_CONTENT (inline JSON, merged at
    // high precedence by OpenCode, above user/project config but below managed config).
    // Never writes to ~/.config/opencode/opencode.json. MCP injection is independent of the
    // provider card (mirrors Claude/Codex): the browser panel + custom MCP servers reach
    // an OpenCode pane regardless of whether the OpenCode provider card is enabled.
    const inline: Record<string, unknown> = {}

    // Load the managed linking + status-badge plugin process-scoped (OpenCode has no
    // per-process plugin-*directory* override — only `.opencode/plugins/` (project) and
    // `~/.config/opencode/plugins/` (global) are scanned — so we reference the installed
    // file's absolute path directly in the `plugin` array instead). Set unconditionally for
    // any OpenCode pane MultiAgent spawns — the plugin bails unless MULTIAGENT_ENV is set,
    // so an OpenCode launched outside MultiAgent is unaffected even if the file exists.
    if (_opencodePluginPath) inline['plugin'] = [_opencodePluginPath]

    // Provider overrides — only when the card is enabled and a non-native preset is active.
    if (opencodeCfg?.enabled && opencodeCfg.preset !== 'native') {
      if (opencodeCfg.model) inline['model'] = opencodeCfg.model
      const providerId = opencodeCfg.providerId.trim()
      if (providerId) {
        const opts: Record<string, string> = {}
        if (opencodeCfg.apiKey) opts['apiKey'] = opencodeCfg.apiKey
        if (opencodeCfg.baseUrl) opts['baseURL'] = opencodeCfg.baseUrl
        const providerEntry: Record<string, unknown> = {}
        // Custom/OpenAI-compatible provider ids (ollama, zai, custom gateways) aren't in
        // OpenCode's models.dev catalog, so OpenCode needs the `npm` adapter to know how to
        // talk to them at all.
        if (opencodeCfg.npmAdapter?.trim()) providerEntry['npm'] = opencodeCfg.npmAdapter.trim()
        if (Object.keys(opts).length) providerEntry['options'] = opts
        // A model id outside the models.dev catalog (e.g. an Ollama cloud-proxy tag like
        // `glm-5.2:cloud`) must be declared under provider.<id>.models.<modelId> with at
        // least a name + context/output limits, or OpenCode can't resolve `--model <id>`.
        if (opencodeCfg.model) {
          const modelId = opencodeCfg.model.includes('/')
            ? opencodeCfg.model.slice(opencodeCfg.model.indexOf('/') + 1)
            : opencodeCfg.model
          if (modelId) {
            providerEntry['models'] = {
              [modelId]: {
                name: modelId,
                limit: { context: 128000, output: 4096 },
              },
            }
          }
        }
        if (Object.keys(providerEntry).length) {
          inline['provider'] = { [providerId]: providerEntry }
        }
      }
    }

    // MCP injection (spec 052 §6): merge the built-in browser + custom MCP servers into
    // the same inline JSON's `mcp` object. OpenCode's mcp format: local servers use
    // { type:'local', command:[...], environment:{...}, enabled:true }; remote servers
    // use { type:'remote', url, enabled:true }. Independent of the provider card.
    const mcpUrl = currentOpencodeMcpUrl()
    const mcpSettings = currentMcpSettings()
    const mcp: Record<string, unknown> = {}
    if (mcpUrl && (!mcpSettings || mcpSettings.builtinBrowserEnabled !== false)) {
      mcp['multiagent-browser'] = { type: 'remote', url: mcpUrl, enabled: true }
    }
    const uiUrl = currentUiMcpUrl()
    if (uiUrl) mcp['multiagent-ui'] = { type: 'remote', url: uiUrl, enabled: true }
    if (mcpSettings) {
      for (const server of mcpSettings.customServers) {
        if (!server.enabled || !server.name.trim()) continue
        const key = server.name.trim()
        if (server.type === 'stdio') {
          if (server.command) {
            mcp[key] = {
              type: 'local',
              command: [server.command, ...(server.args ?? [])],
              ...(server.env && Object.keys(server.env).length ? { environment: server.env } : {}),
              enabled: true,
            }
          }
        } else {
          if (server.url) {
            mcp[key] = { type: 'remote', url: server.url, enabled: true }
          }
        }
      }
    }
    if (Object.keys(mcp).length) inline['mcp'] = mcp

    if (Object.keys(inline).length) {
      vars['OPENCODE_CONFIG_CONTENT'] = JSON.stringify(inline)
    }

    applyExtraEnv(vars, opencodeCfg?.extraEnvVars ?? [])
  }

  return vars
}

export function newSessionCommand(agentKind: AgentKind, sessionId?: string): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs(sessionId)}`
  if (agentKind === 'opencode') return `opencode${opencodeCliArgs()}`
  // spec 047 phase 4: app-launched Codex links its session via the managed SessionStart hook
  // (the file-poll scanner is gone). We do NOT bypass the Codex hook trust gate — the user
  // accepts the managed hook once via `codex /hooks` (same as a CLI-launched Codex), and the
  // persisted trust then covers every future app/CLI Codex launch. Avoids the
  // --dangerously-bypass-hook-trust flag.
  return `codex${codexCliArgs()}`
}

export function resumeSessionCommand(agentKind: AgentKind, sessionId: string, cwd: string): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs()} --resume ${shellArg(sessionId)}`
  if (agentKind === 'opencode') return `opencode --session ${shellArg(sessionId)}${opencodeCliArgs()}`
  return `codex resume${codexCliArgs()} -C ${shellArg(cwd)} ${shellArg(sessionId)}`
}

export function codexRemoteCommand(socketPath: string, sessionId?: string, cwd?: string): string {
  const remote = ` --remote ${shellArg(`unix://${socketPath.replace(/\\/g, '/')}`)}`
  if (!sessionId) return `codex${codexCliArgs()}${remote}`
  return `codex${codexCliArgs()}${remote} resume -C ${shellArg(cwd ?? '')} ${shellArg(sessionId)}`
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
  const uiUrl = currentUiMcpUrl()
  if (uiUrl) {
    args.push('-c', psSingleQuoted(`mcp_servers.multiagent-ui.url=${tomlLit(uiUrl)}`), '-c', psSingleQuoted('mcp_servers.multiagent-ui.enabled=true'))
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

// spec 052: OpenCode CLI args. `--auto` is always added (auto-approve non-denied permissions
// so panes run unattended; the user's own `permission` config is the deny-list floor — a
// deliberate per-agent posture that diverges from Claude/Codex). `--model <provider/model>`
// overrides the config's model for this pane when the provider card is enabled and a model
// is set. MCP + provider key/baseURL go through OPENCODE_CONFIG_CONTENT env, not CLI flags.
function opencodeCliArgs(): string {
  const args: string[] = ['--auto']
  const opencodeCfg = _agentProviderSettings?.opencode
  if (opencodeCfg?.enabled && opencodeCfg.preset !== 'native' && opencodeCfg.model) {
    args.push('--model', shellArg(opencodeCfg.model))
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

