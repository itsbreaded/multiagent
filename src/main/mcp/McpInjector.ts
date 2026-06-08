import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const SERVER_KEY = 'multiagent-browser'

export class McpInjector {
  // Claude Code stores user-scope MCP servers in ~/.claude.json (not settings.json).
  // The format mirrors what `claude mcp add --transport sse --scope user` writes.
  private claudeJsonPath: string
  private codexConfigPath: string

  constructor() {
    this.claudeJsonPath = join(homedir(), '.claude.json')
    const codexHome = process.env['CODEX_HOME'] || join(homedir(), '.codex')
    this.codexConfigPath = join(codexHome, 'config.toml')
  }

  // Merge our MCP server entry into ~/.claude.json under the top-level mcpServers key.
  // All other Claude Code state in the file is preserved.
  inject(sseUrl: string, streamableHttpUrl: string): void {
    this.injectClaude(sseUrl)
    this.injectCodex(streamableHttpUrl)
  }

  private injectClaude(sseUrl: string): void {
    let root: Record<string, unknown> = {}
    try {
      root = JSON.parse(readFileSync(this.claudeJsonPath, 'utf-8'))
    } catch { /* file may not exist on first run */ }

    if (!root.mcpServers || typeof root.mcpServers !== 'object') {
      root.mcpServers = {}
    }
    ;(root.mcpServers as Record<string, unknown>)[SERVER_KEY] = {
      type: 'sse',
      url: sseUrl,
    }

    writeFileSync(this.claudeJsonPath, JSON.stringify(root, null, 2), 'utf-8')
  }

  private injectCodex(sseUrl: string): void {
    mkdirSync(dirname(this.codexConfigPath), { recursive: true })
    let config = ''
    try {
      config = readFileSync(this.codexConfigPath, 'utf-8')
    } catch { /* file may not exist on first run */ }

    const cleaned = removeCodexMcpSection(config)
    const suffix = cleaned.trimEnd().length > 0 ? '\n\n' : ''
    const next = `${cleaned.trimEnd()}${suffix}[mcp_servers.${SERVER_KEY}]\nurl = "${sseUrl}"\nenabled = true\n`
    writeFileSync(this.codexConfigPath, next, 'utf-8')
  }

  // Remove our entry from ~/.claude.json on app quit.
  cleanup(): void {
    this.cleanupClaude()
    this.cleanupCodex()
  }

  private cleanupClaude(): void {
    try {
      const root = JSON.parse(readFileSync(this.claudeJsonPath, 'utf-8')) as Record<string, unknown>
      const servers = root.mcpServers as Record<string, unknown> | undefined
      if (!servers) return
      delete servers[SERVER_KEY]
      writeFileSync(this.claudeJsonPath, JSON.stringify(root, null, 2), 'utf-8')
    } catch { /* ignore */ }
  }

  private cleanupCodex(): void {
    try {
      const config = readFileSync(this.codexConfigPath, 'utf-8')
      writeFileSync(this.codexConfigPath, removeCodexMcpSection(config), 'utf-8')
    } catch { /* ignore */ }
  }
}

function removeCodexMcpSection(config: string): string {
  const lines = config.split(/\r?\n/)
  const result: string[] = []
  let skipping = false

  for (const line of lines) {
    if (/^\s*\[mcp_servers\.multiagent-browser\]\s*$/.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*\[[^\]]+\]\s*$/.test(line)) {
      skipping = false
    }
    if (!skipping) result.push(line)
  }

  return result.join('\n').trimEnd() + (result.length > 0 ? '\n' : '')
}
