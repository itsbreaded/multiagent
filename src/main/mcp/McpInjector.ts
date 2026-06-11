import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { McpSettings } from '../../shared/types'

let claudeMcpConfigPath: string | null = null
let codexMcpUrl: string | null = null
let activeMcpSettings: McpSettings | undefined = undefined

export function currentClaudeMcpConfigPath(): string | null {
  return claudeMcpConfigPath
}

export function currentCodexMcpUrl(): string | null {
  return codexMcpUrl
}

export function currentMcpSettings(): McpSettings | undefined {
  return activeMcpSettings
}

export class McpInjector {
  inject(sseUrl: string, streamableHttpUrl: string, settings?: McpSettings): void {
    void sseUrl
    activeMcpSettings = settings
    const port = portFromUrl(streamableHttpUrl)
    claudeMcpConfigPath = writeClaudeMcpConfig(port, settings)
    codexMcpUrl = buildCodexMcpUrl(port)
  }

  updateSettings(sseUrl: string, streamableHttpUrl: string, settings: McpSettings): void {
    void sseUrl
    activeMcpSettings = settings
    const port = portFromUrl(streamableHttpUrl)
    claudeMcpConfigPath = writeClaudeMcpConfig(port, settings)
    codexMcpUrl = buildCodexMcpUrl(port)
  }

  cleanup(): void {
    cleanupClaudeMcpConfig()
    codexMcpUrl = null
    activeMcpSettings = undefined
  }
}

function buildMcpConfig(port: string, settings?: McpSettings): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {}

  if (!settings || settings.builtinBrowserEnabled !== false) {
    mcpServers['multiagent-browser'] = {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
    }
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

function writeClaudeMcpConfig(port: string, settings?: McpSettings): string {
  cleanupClaudeMcpConfig()
  const configPath = join(tmpdir(), `multiagent-claude-mcp-${process.pid}.json`)
  const config = buildMcpConfig(port, settings)
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

function buildCodexMcpUrl(port: string): string {
  return `http://127.0.0.1:${port}/mcp`
}

function portFromUrl(url: string): string {
  return new URL(url).port
}
