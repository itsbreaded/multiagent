import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SERVER_KEY = 'multiagent-browser'

export class McpInjector {
  // Claude Code stores user-scope MCP servers in ~/.claude.json (not settings.json).
  // The format mirrors what `claude mcp add --transport sse --scope user` writes.
  private claudeJsonPath: string

  constructor() {
    this.claudeJsonPath = join(homedir(), '.claude.json')
  }

  // Merge our MCP server entry into ~/.claude.json under the top-level mcpServers key.
  // All other Claude Code state in the file is preserved.
  inject(sseUrl: string): void {
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

  // Remove our entry from ~/.claude.json on app quit.
  cleanup(): void {
    try {
      const root = JSON.parse(readFileSync(this.claudeJsonPath, 'utf-8')) as Record<string, unknown>
      const servers = root.mcpServers as Record<string, unknown> | undefined
      if (!servers) return
      delete servers[SERVER_KEY]
      writeFileSync(this.claudeJsonPath, JSON.stringify(root, null, 2), 'utf-8')
    } catch { /* ignore */ }
  }
}
