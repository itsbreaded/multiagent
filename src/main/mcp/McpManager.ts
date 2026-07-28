import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { McpSettings, McpStatus } from '../../shared/types'
import type { BrowserViewManager } from '../browser/BrowserViewManager'
import { BrowserMcpServer } from './BrowserMcpServer'
import { AppUiMcpServer } from './AppUiMcpServer'
import { AppUiManager } from '../uiAutomation/AppUiManager'
import { McpInjector } from './McpInjector'

const SETTINGS_FILE = 'mcp-settings.json'

export const BUILTIN_TOOLS = [
  'browser_navigate', 'browser_click', 'browser_click_text', 'browser_click_at',
  'browser_type', 'browser_screenshot', 'browser_evaluate', 'browser_get_content',
  'browser_scroll', 'browser_wait_for', 'browser_wait_for_text', 'browser_wait_for_load',
  'browser_go_back', 'browser_go_forward', 'browser_reload', 'browser_hover', 'browser_hover_at',
  'browser_keyboard', 'browser_select', 'browser_get_url', 'browser_get_elements',
  'browser_get_links', 'browser_set_cookies',
  'browser_get_console', 'browser_get_network', 'browser_get_cookies', 'browser_delete_cookie',
]

const DEFAULT_SETTINGS: McpSettings = {
  builtinBrowserEnabled: true,
  builtinUiAutomationEnabled: false,
  customServers: [],
}

export class McpManager {
  private _injector = new McpInjector()
  private _port: number | null = null
  private _browserPort: number | null = null
  private _running = false
  private _uiPort: number | null = null
  private _uiError: string | undefined
  private _uiServer: AppUiMcpServer | null = null
  private _settings: McpSettings = { ...DEFAULT_SETTINGS }

  loadSettings(): McpSettings {
    try {
      const path = join(app.getPath('userData'), SETTINGS_FILE)
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<McpSettings>
      this._settings = {
        builtinBrowserEnabled: parsed.builtinBrowserEnabled !== false,
        builtinUiAutomationEnabled: parsed.builtinUiAutomationEnabled === true,
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
    void this.reconcileUiAutomation()
  }

  private uiAutomationEnabled(): boolean {
    return this._settings.builtinUiAutomationEnabled || process.env['MULTIAGENT_UI_AUTOMATION_PORT'] !== undefined
  }

  private uiUrl(): string | null {
    return this._uiPort === null ? null : `http://127.0.0.1:${this._uiPort}/mcp`
  }

  private updateInjector(): void {
    if (this._browserPort === null) return
    this._injector.updateSettings(`http://127.0.0.1:${this._browserPort}/sse`, `http://127.0.0.1:${this._browserPort}/mcp`, this._settings, this.uiUrl())
  }

  private async reconcileUiAutomation(): Promise<void> {
    if (!this.uiAutomationEnabled()) {
      const server = this._uiServer
      this._uiServer = null
      this._uiPort = null
      if (server) await server.close().catch((error) => { this._uiError = (error as Error).message })
      this.updateInjector()
      return
    }
    if (this._uiPort !== null) { this.updateInjector(); return }
    const requested = process.env['MULTIAGENT_UI_AUTOMATION_PORT']
    const requestedPort = requested === undefined ? 0 : Number(requested)
    if (!Number.isInteger(requestedPort) || requestedPort < 1 && requested !== undefined || requestedPort > 65535) {
      this._uiError = `Invalid MULTIAGENT_UI_AUTOMATION_PORT: ${requested}`
      this.updateInjector()
      return
    }
    try {
      const ui = new AppUiManager(); ui.initialize()
      const server = new AppUiMcpServer(ui)
      this._uiPort = await server.startHttp(requestedPort)
      this._uiServer = server
      this._uiError = undefined
    } catch (error) {
      this._uiError = (error as Error).message
    }
    this.updateInjector()
  }

  async start(browser: BrowserViewManager): Promise<void> {
    this.loadSettings()
    const server = new BrowserMcpServer(browser)
    const port = await server.startHttp()
    this._browserPort = port
    this._port = port
    this._running = true
    this._injector.inject(
      `http://127.0.0.1:${port}/sse`,
      `http://127.0.0.1:${port}/mcp`,
      this._settings,
    )
    await this.reconcileUiAutomation()
  }

  getStatus(): McpStatus {
    return {
      port: this._port,
      running: this._running,
      tools: this._settings.builtinBrowserEnabled ? BUILTIN_TOOLS : [],
      uiAutomation: { enabled: this.uiAutomationEnabled(), running: this._uiPort !== null, port: this._uiPort, tools: this._uiPort ? ['ui_targets', 'ui_attach_target', 'ui_windows', 'ui_content', 'ui_click', 'ui_type', 'ui_scroll', 'ui_keyboard', 'ui_drag', 'ui_wait_for', 'ui_screenshot', 'ui_evaluate', 'ui_console', 'ui_network'] : [], ...(this._uiError ? { error: this._uiError } : {}) },
    }
  }

  getSettings(): McpSettings {
    return this._settings
  }

  cleanup(): void {
    this._injector.cleanup()
    void this._uiServer?.close()
    this._uiServer = null
    this._uiPort = null
    this._running = false
  }
}

export const mcpManager = new McpManager()
