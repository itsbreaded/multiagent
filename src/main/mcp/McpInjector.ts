import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { McpSettings } from '../../shared/types'

let claudeMcpConfigPath: string | null = null
let codexMcpUrl: string | null = null
let opencodeMcpUrl: string | null = null
let uiMcpUrl: string | null = null
let activeMcpSettings: McpSettings | undefined = undefined

export function currentClaudeMcpConfigPath(): string | null {
  return claudeMcpConfigPath
}

export function currentCodexMcpUrl(): string | null {
  return codexMcpUrl
}

export function currentOpencodeMcpUrl(): string | null {
  return opencodeMcpUrl
}

export function currentMcpSettings(): McpSettings | undefined {
  return activeMcpSettings
}
export function currentUiMcpUrl(): string | null {
  if (!activeMcpSettings?.builtinUiAutomationEnabled && process.env['MULTIAGENT_UI_AUTOMATION_PORT'] === undefined) return null
  return uiMcpUrl
}

export class McpInjector {
  inject(browserUrl: string | null, settings?: McpSettings, uiUrl?: string | null): void {
    activeMcpSettings = settings
    claudeMcpConfigPath = writeClaudeMcpConfig(browserUrl, settings, uiUrl)
    codexMcpUrl = browserUrl
    opencodeMcpUrl = browserUrl
    uiMcpUrl = uiUrl ?? null
  }

  updateSettings(browserUrl: string | null, settings: McpSettings, uiUrl?: string | null): void {
    this.inject(browserUrl, settings, uiUrl)
  }

  cleanup(): void {
    cleanupClaudeMcpConfig()
    codexMcpUrl = null
    opencodeMcpUrl = null
    activeMcpSettings = undefined
    uiMcpUrl = null
  }
}

function buildMcpConfig(browserUrl: string | null, settings?: McpSettings, uiUrl?: string | null): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {}

  if (browserUrl && settings?.builtinBrowserEnabled === true) {
    mcpServers['multiagent-browser'] = {
      type: 'http',
      url: browserUrl,
    }
  }
  if (uiUrl && (settings?.builtinUiAutomationEnabled || process.env['MULTIAGENT_UI_AUTOMATION_PORT'] !== undefined)) {
    mcpServers['multiagent-ui'] = { type: 'http', url: uiUrl }
  }

  if (settings?.customServers) {
    for (const server of settings.customServers) {
      if (!server.enabled || !server.name.trim()) continue
      if (server.type === 'stdio') {
        mcpServers[server.name] = {
          type: 'stdio',
          command: server.command ?? '',
          ...(server.args?.length ? { args: server.args } : {}),
          ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
        }
      } else {
        mcpServers[server.name] = {
          type: server.type,
          url: server.url ?? '',
        }
      }
    }
  }

  return { mcpServers }
}

function writeClaudeMcpConfig(browserUrl: string | null, settings?: McpSettings, uiUrl?: string | null): string | null {
  cleanupClaudeMcpConfig()
  const config = buildMcpConfig(browserUrl, settings, uiUrl)
  if (!Object.keys(config.mcpServers as Record<string, unknown>).length) return null
  const configPath = join(tmpdir(), `multiagent-claude-mcp-${process.pid}.json`)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  return configPath
}

function cleanupClaudeMcpConfig(): void {
  if (!claudeMcpConfigPath) return
  try {
    if (existsSync(claudeMcpConfigPath)) unlinkSync(claudeMcpConfigPath)
  } catch { /* ignore */ }
  claudeMcpConfigPath = null
}
