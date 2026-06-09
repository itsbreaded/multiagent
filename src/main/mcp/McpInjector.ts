import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PORT_PLACEHOLDER = '{port}'

let claudeMcpConfigPath: string | null = null
let codexMcpUrl: string | null = null

export function currentClaudeMcpConfigPath(): string | null {
  return claudeMcpConfigPath
}

export function currentCodexMcpUrl(): string | null {
  return codexMcpUrl
}

export class McpInjector {
  inject(sseUrl: string, streamableHttpUrl: string): void {
    void sseUrl
    const port = portFromUrl(streamableHttpUrl)
    claudeMcpConfigPath = writeClaudeMcpConfig(port)
    codexMcpUrl = resolveTemplate('codex-mcp.toml', portFromUrl(streamableHttpUrl))
      .match(/^\s*url\s*=\s*"([^"]+)"/m)?.[1] ?? streamableHttpUrl
  }

  cleanup(): void {
    cleanupClaudeMcpConfig()
    codexMcpUrl = null
  }
}

function writeClaudeMcpConfig(port: string): string {
  cleanupClaudeMcpConfig()
  const configPath = join(tmpdir(), `multiagent-claude-mcp-${process.pid}.json`)
  writeFileSync(configPath, resolveTemplate('claude-mcp.json', port), 'utf-8')
  return configPath
}

function cleanupClaudeMcpConfig(): void {
  if (!claudeMcpConfigPath) return
  try {
    if (existsSync(claudeMcpConfigPath)) unlinkSync(claudeMcpConfigPath)
  } catch { /* ignore */ }
  claudeMcpConfigPath = null
}

function resolveTemplate(fileName: string, port: string): string {
  return readTemplate(fileName).replaceAll(PORT_PLACEHOLDER, port)
}

function readTemplate(fileName: string): string {
  return readFileSync(join(__dirname, '../../src/main/mcp/templates', fileName), 'utf-8')
}

function portFromUrl(url: string): string {
  return new URL(url).port
}
