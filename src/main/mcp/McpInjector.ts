import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface McpConfig {
  mcpServers: Record<
    string,
    {
      command: string
      args: string[]
      env?: Record<string, string>
    }
  >
}

export class McpInjector {
  private configPath: string

  constructor() {
    this.configPath = join(tmpdir(), 'multiagent-mcp-config.json')
  }

  /**
   * Write the MCP config file. Call this once when the server starts.
   *
   * @param serverCommand - How to launch the MCP server (e.g. path to a script or 'node server.js')
   * @param serverArgs - Arguments to pass to the server command
   */
  writeConfig(serverCommand: string, serverArgs: string[]): void {
    const config: McpConfig = {
      mcpServers: {
        'multiagent-browser': {
          command: serverCommand,
          args: serverArgs,
        },
      },
    }
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  /**
   * Returns env vars to inject when spawning a Claude Code session.
   *
   * NOTE: The exact env var name used by Claude Code to load MCP config needs
   * verification against the Claude Code release notes / source. At time of
   * writing the most likely candidates are:
   *   - CLAUDE_MCP_CONFIG  (pointing to a JSON file path)
   *   - MCP_CONFIG_PATH
   *
   * The JSON file format itself (`mcpServers` key) mirrors what Claude Code
   * stores in its project-level `.claude/mcp.json` and user-level
   * `~/.claude/mcp.json`, so the config file structure is safe regardless
   * of which env var name ends up being correct.
   */
  getEnv(): Record<string, string> {
    return {
      CLAUDE_MCP_CONFIG: this.configPath,
    }
  }

  getConfigPath(): string {
    return this.configPath
  }
}
