import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { McpSettings, McpStatus } from '../../shared/types'
import type { BrowserViewManager } from '../browser/BrowserViewManager'
import { BrowserMcpServer } from './BrowserMcpServer'
import { McpInjector } from './McpInjector'

const SETTINGS_FILE = 'mcp-settings.json'

const BUILTIN_TOOLS = [
  'browser_navigate', 'browser_click', 'browser_click_text', 'browser_click_at',
  'browser_type', 'browser_screenshot', 'browser_evaluate', 'browser_get_content',
  'browser_scroll', 'browser_wait_for', 'browser_wait_for_text', 'browser_wait_for_load',
  'browser_go_back', 'browser_go_forward', 'browser_hover', 'browser_hover_at',
  'browser_keyboard', 'browser_select', 'browser_get_url', 'browser_get_elements',
  'browser_get_links', 'browser_set_cookies',
]

const DEFAULT_SETTINGS: McpSettings = {
  builtinBrowserEnabled: true,
  customServers: [],
}

class McpManager {
  private _injector = new McpInjector()
  private _port: number | null = null
  private _running = false
  private _settings: McpSettings = { ...DEFAULT_SETTINGS }

  loadSettings(): McpSettings {
    try {
      const path = join(app.getPath('userData'), SETTINGS_FILE)
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<McpSettings>
      this._settings = {
        builtinBrowserEnabled: parsed.builtinBrowserEnabled !== false,
        customServers: Array.isArray(parsed.customServers) ? parsed.customServers : [],
      }
    } catch {
      this._settings = { ...DEFAULT_SETTINGS }
    }
    return this._settings
  }

  saveSettings(settings: McpSettings): void {
    this._settings = settings
    try {
      const path = join(app.getPath('userData'), SETTINGS_FILE)
      writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8')
    } catch (err) {
      console.error('[McpManager] Failed to save settings:', err)
    }
    if (this._port !== null) {
      this._injector.updateSettings(`http://127.0.0.1:${this._port}/sse`, `http://127.0.0.1:${this._port}/mcp`, settings)
    }
  }

  async start(browser: BrowserViewManager): Promise<void> {
    this.loadSettings()
    const server = new BrowserMcpServer(browser)
    const port = await server.startHttp()
    this._port = port
    this._running = true
    this._injector.inject(
      `http://127.0.0.1:${port}/sse`,
      `http://127.0.0.1:${port}/mcp`,
      this._settings,
    )
  }

  getStatus(): McpStatus {
    return {
      port: this._port,
      running: this._running,
      tools: this._settings.builtinBrowserEnabled ? BUILTIN_TOOLS : [],
    }
  }

  getSettings(): McpSettings {
    return this._settings
  }

  cleanup(): void {
    this._injector.cleanup()
    this._running = false
  }
}

export const mcpManager = new McpManager()
