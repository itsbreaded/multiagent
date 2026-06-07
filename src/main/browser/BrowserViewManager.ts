import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'

export type BrowserControlState = 'hidden' | 'agent-controlled' | 'user-controlled'

export class BrowserViewManager extends EventEmitter {
  private win: BrowserWindow | null = null
  private state: BrowserControlState = 'hidden'

  // No-op kept for API compatibility — window is created lazily on first use
  initialize(): void {}

  private _ensureWindow(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        width: 1280,
        height: 900,
        title: 'MultiAgent Browser',
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      })
      this.win.on('closed', () => {
        this.win = null
        this.state = 'hidden'
        this.emit('state-changed', this.state)
      })
    }
    return this.win
  }

  show(): void {
    const win = this._ensureWindow()
    win.show()
    this.state = 'agent-controlled'
    this.emit('state-changed', this.state)
  }

  hide(): void {
    this.win?.hide()
    this.state = 'hidden'
    this.emit('state-changed', this.state)
  }

  setUserControlled(): void {
    this.state = 'user-controlled'
    this.emit('state-changed', this.state)
  }

  setAgentControlled(): void {
    this.state = 'agent-controlled'
    this.emit('state-changed', this.state)
  }

  getState(): BrowserControlState {
    return this.state
  }

  async navigate(url: string): Promise<void> {
    const win = this._ensureWindow()
    win.show()
    this.state = 'agent-controlled'
    this.emit('state-changed', this.state)
    await win.webContents.loadURL(url)
  }

  async click(selector: string): Promise<void> {
    await this.win?.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click()`
    )
  }

  async type(selector: string, text: string): Promise<void> {
    await this.win?.webContents.executeJavaScript(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) { el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); }
    `)
  }

  async screenshot(): Promise<string> {
    if (!this.win || this.win.isDestroyed()) throw new Error('Browser window not open')
    const image = await this.win.webContents.capturePage()
    return image.toDataURL()
  }

  async evaluate(js: string): Promise<unknown> {
    return this.win?.webContents.executeJavaScript(js)
  }

  async getContent(): Promise<string> {
    return ((await this.win?.webContents.executeJavaScript('document.body.innerText')) as string) ?? ''
  }

  async scroll(x: number, y: number): Promise<void> {
    await this.win?.webContents.executeJavaScript(`window.scrollBy(${x}, ${y})`)
  }

  async waitFor(selector: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = (await this.win?.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(selector)})`
      )) as boolean | undefined
      if (found) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`Selector not found within ${timeoutMs}ms: ${selector}`)
  }

  getCurrentUrl(): string {
    return this.win?.webContents.getURL() ?? ''
  }

  async goBack(): Promise<void> {
    const wc = this.win?.webContents
    if (!wc?.canGoBack()) throw new Error('No previous page in history')
    wc.goBack()
    await this._waitForNavigation()
  }

  async goForward(): Promise<void> {
    const wc = this.win?.webContents
    if (!wc?.canGoForward()) throw new Error('No next page in history')
    wc.goForward()
    await this._waitForNavigation()
  }

  private _waitForNavigation(timeoutMs = 10000): Promise<void> {
    const wc = this.win?.webContents
    if (!wc) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wc.removeListener('did-stop-loading', onDone)
        reject(new Error(`Navigation did not complete within ${timeoutMs}ms`))
      }, timeoutMs)
      const onDone = () => { clearTimeout(timer); resolve() }
      wc.once('did-stop-loading', onDone)
    })
  }

  async hover(selector: string): Promise<void> {
    const wc = this.win?.webContents
    if (!wc) return
    const pos = await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `) as { x: number; y: number } | null
    if (!pos) throw new Error(`Selector not found: ${selector}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y } as any)
    await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      })()
    `)
  }

  async keyboard(key: string, modifiers: string[] = []): Promise<void> {
    const wc = this.win?.webContents
    if (!wc) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mods = modifiers as any
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
  }

  async waitForLoad(timeoutMs = 10000): Promise<void> {
    const wc = this.win?.webContents
    if (!wc || !wc.isLoading()) return
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wc.removeListener('did-stop-loading', onDone)
        reject(new Error(`Page did not finish loading within ${timeoutMs}ms`))
      }, timeoutMs)
      const onDone = () => { clearTimeout(timer); resolve() }
      wc.once('did-stop-loading', onDone)
    })
  }

  async selectOption(selector: string, value: string): Promise<void> {
    await this.win?.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `)
  }

  async setCookies(
    cookies: Array<{ url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }>
  ): Promise<void> {
    const ses = this._ensureWindow().webContents.session
    for (const cookie of cookies) {
      await ses.cookies.set(cookie)
    }
  }

  destroy(): void {
    this.win?.destroy()
    this.win = null
  }
}
