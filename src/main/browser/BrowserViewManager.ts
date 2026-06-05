import { BrowserWindow, WebContentsView } from 'electron'
import { EventEmitter } from 'events'

export type BrowserControlState = 'hidden' | 'agent-controlled' | 'user-controlled'

export class BrowserViewManager extends EventEmitter {
  private view: WebContentsView | null = null
  private window: BrowserWindow
  private state: BrowserControlState = 'hidden'

  constructor(window: BrowserWindow) {
    super()
    this.window = window
  }

  // Called once during app init to create the WebContentsView
  initialize(): void {
    this.view = new WebContentsView()
    // Don't add to window yet - only shown when needed
  }

  show(): void {
    if (!this.view || this.window.contentView.children.includes(this.view)) return
    this.window.contentView.addChildView(this.view)
    this._updateBounds()
    this.state = 'agent-controlled'
    this.emit('state-changed', this.state)
  }

  hide(): void {
    if (!this.view) return
    this.window.contentView.removeChildView(this.view)
    this.state = 'hidden'
    this.emit('state-changed', this.state)
  }

  // Position the browser view in the lower portion of the window
  private _updateBounds(): void {
    const bounds = this.window.getContentBounds()
    const sidebarWidth = 220
    const browserHeight = Math.floor(bounds.height * 0.4)
    this.view?.setBounds({
      x: sidebarWidth,
      y: bounds.height - browserHeight,
      width: bounds.width - sidebarWidth,
      height: browserHeight,
    })
  }

  // User clicked into browser - switch to user-controlled
  setUserControlled(): void {
    this.state = 'user-controlled'
    this.emit('state-changed', this.state)
  }

  // Agent reclaims control
  setAgentControlled(): void {
    this.state = 'agent-controlled'
    this.emit('state-changed', this.state)
  }

  getState(): BrowserControlState {
    return this.state
  }

  // Browser tool implementations
  async navigate(url: string): Promise<void> {
    if (!this.view) throw new Error('Browser not initialized')
    this.show()
    await this.view.webContents.loadURL(url)
  }

  async click(selector: string): Promise<void> {
    await this.view?.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click()`
    )
  }

  async type(selector: string, text: string): Promise<void> {
    await this.view?.webContents.executeJavaScript(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) { el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles: true})); }
    `)
  }

  async screenshot(): Promise<string> {
    if (!this.view) throw new Error('Browser not initialized')
    const image = await this.view.webContents.capturePage()
    return image.toDataURL()
  }

  async evaluate(js: string): Promise<unknown> {
    return this.view?.webContents.executeJavaScript(js)
  }

  async getContent(): Promise<string> {
    return (
      ((await this.view?.webContents.executeJavaScript(
        'document.body.innerText'
      )) as string) ?? ''
    )
  }

  async scroll(x: number, y: number): Promise<void> {
    await this.view?.webContents.executeJavaScript(`window.scrollBy(${x}, ${y})`)
  }

  async waitFor(selector: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await this.view?.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(selector)})`
      )
      if (found) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`Selector not found within ${timeoutMs}ms: ${selector}`)
  }

  getCurrentUrl(): string {
    return this.view?.webContents.getURL() ?? ''
  }
}
