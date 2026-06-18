import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'

export type BrowserControlState = 'hidden' | 'agent-controlled' | 'user-controlled'

export interface BrowserContentOptions {
  selector?: string
  maxChars?: number
}

export interface BrowserContentResult {
  text: string
  characters: number
  lines: number
  truncated: boolean
  selector?: string
}

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

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const win = this._ensureWindow()
    win.show()
    this.state = 'agent-controlled'
    this.emit('state-changed', this.state)
    await win.webContents.loadURL(url)
    return { url: win.webContents.getURL(), title: win.webContents.getTitle() }
  }

  async click(selector: string): Promise<{ url: string; title: string }> {
    const wc = this.win?.webContents
    if (!wc) return { url: '', title: '' }
    const urlBefore = wc.getURL()
    const pos = await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `, true) as { x: number; y: number } | null
    if (!pos) throw new Error(`Selector not found: ${selector}`)
    this.win!.focus()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 } as any)
    return this._waitForNavigationIfStarted(urlBefore)
  }

  async type(selector: string, text: string): Promise<void> {
    const wc = this.win?.webContents
    if (!wc) return
    const pos = await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `, true) as { x: number; y: number } | null
    if (!pos) throw new Error(`Selector not found: ${selector}`)
    this.win!.focus()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 } as any)
    for (const char of text) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wc.sendInputEvent({ type: 'char', keyCode: char } as any)
    }
    // Notify React of the new value — char events update the DOM but not React's synthetic event system
    await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `, true)
  }

  async screenshot(): Promise<string> {
    if (!this.win || this.win.isDestroyed()) throw new Error('Browser window not open')
    const image = await this.win.webContents.capturePage()
    return image.toDataURL()
  }

  async evaluate(js: string): Promise<unknown> {
    return this.win?.webContents.executeJavaScript(js, true)
  }

  async getContent(options: BrowserContentOptions = {}): Promise<BrowserContentResult> {
    const wc = this.win?.webContents
    if (!wc) {
      return { text: '', characters: 0, lines: 0, truncated: false, selector: options.selector }
    }

    const text = ((await wc.executeJavaScript(`
      (() => {
        const selector = ${JSON.stringify(options.selector ?? null)};
        const root = selector ? document.querySelector(selector) : document.body;
        if (!root) throw new Error('Selector not found: ' + selector);
        return root.innerText || root.textContent || '';
      })()
    `, true)) as string) ?? ''
    const maxChars = normalizeMaxChars(options.maxChars)
    const truncated = maxChars !== undefined && text.length > maxChars
    const output = truncated ? text.slice(0, maxChars) : text
    return {
      text: output,
      characters: text.length,
      lines: countLines(text),
      truncated,
      selector: options.selector,
    }
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

  async goBack(): Promise<{ url: string; title: string }> {
    const wc = this.win?.webContents
    if (!wc?.canGoBack()) throw new Error('No previous page in history')
    wc.goBack()
    await this._waitForNavigation()
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  async goForward(): Promise<{ url: string; title: string }> {
    const wc = this.win?.webContents
    if (!wc?.canGoForward()) throw new Error('No next page in history')
    wc.goForward()
    await this._waitForNavigation()
    return { url: wc.getURL(), title: wc.getTitle() }
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

  // After a click (sendInputEvent is async from the browser's perspective), wait
  // briefly for navigation to start, then wait for it to finish if it did.
  private async _waitForNavigationIfStarted(urlBefore: string): Promise<{ url: string; title: string }> {
    const wc = this.win?.webContents
    if (!wc) return { url: urlBefore, title: '' }
    // 150ms gives Chromium time to process the input event and begin navigation
    await new Promise<void>(r => setTimeout(r, 150))
    if (wc.isLoading() || wc.getURL() !== urlBefore) {
      await this.waitForLoad(10000)
    }
    return { url: wc.getURL(), title: wc.getTitle() }
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
        const init = { bubbles: true, cancelable: true, clientX: ${pos.x}, clientY: ${pos.y} };
        el.dispatchEvent(new MouseEvent('mousemove', init));
        el.dispatchEvent(new MouseEvent('mouseover', init));
        el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
      })()
    `)
  }

  async hoverAt(x: number, y: number): Promise<void> {
    const wc = this.win?.webContents
    if (!wc) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseMove', x, y } as any)
    await wc.executeJavaScript(`
      (() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (!el) return;
        const init = { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} };
        el.dispatchEvent(new MouseEvent('mousemove', init));
        el.dispatchEvent(new MouseEvent('mouseover', init));
        el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
      })()
    `)
  }

  async clickAt(x: number, y: number): Promise<{ url: string; title: string }> {
    const wc = this.win?.webContents
    if (!wc) return { url: '', title: '' }
    const urlBefore = wc.getURL()
    this.win!.focus()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 } as any)
    await wc.executeJavaScript(`
      (() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }));
      })()
    `)
    return this._waitForNavigationIfStarted(urlBefore)
  }

  async clickText(text: string, exact = false): Promise<{ url: string; title: string }> {
    const wc = this.win?.webContents
    if (!wc) return { url: '', title: '' }
    // Three-pass search: <a> first (preferred for navigation), then buttons, then
    // structural containers — for containers, walk up to the nearest <a> ancestor.
    // Returns coordinates + href so we can navigate directly for real links.
    const found = await wc.executeJavaScript(`
      (() => {
        const exact = ${JSON.stringify(exact)};
        const needle = ${JSON.stringify(text)};
        const matches = (el) => {
          const t = (el.innerText || el.textContent || '').trim();
          return exact ? t === needle : t.toLowerCase().includes(needle.toLowerCase());
        };
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const toResult = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: el.href || null };
        };
        // Pass 1: <a> elements — exact link targets, preferred for navigation
        for (const el of document.querySelectorAll('a')) {
          if (matches(el) && visible(el)) return toResult(el);
        }
        // Pass 2: buttons and interactive ARIA roles
        for (const el of document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')) {
          if (matches(el) && visible(el)) return toResult(el);
        }
        // Pass 3: structural containers — walk up to nearest <a> ancestor so
        // complex product cards (e.g. Amazon <li> wrapping a link) resolve correctly
        for (const el of document.querySelectorAll('li, td, th, label, span, div, p')) {
          if (matches(el) && visible(el)) {
            let cur = el.parentElement;
            while (cur && cur !== document.body) {
              if (cur.tagName === 'A' && visible(cur)) return toResult(cur);
              cur = cur.parentElement;
            }
            return toResult(el);
          }
        }
        return null;
      })()
    `, true) as { x: number; y: number; href: string | null } | null
    if (!found) throw new Error(`No visible element with text: ${JSON.stringify(text)}`)
    // For real http(s) links, navigate directly — bypasses coordinate precision issues
    // on deeply nested link structures and waits for the page to finish loading.
    if (found.href && /^https?:/.test(found.href)) {
      return this.navigate(found.href)
    }
    const urlBefore = wc.getURL()
    this.win!.focus()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseDown', x: found.x, y: found.y, button: 'left', clickCount: 1 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseUp', x: found.x, y: found.y, button: 'left', clickCount: 1 } as any)
    await wc.executeJavaScript(`
      (() => {
        const el = document.elementFromPoint(${found.x}, ${found.y});
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      })()
    `, true)
    return this._waitForNavigationIfStarted(urlBefore)
  }

  async getElements(selector: string): Promise<Array<{ tag: string; text: string; value: string; id: string; classes: string; href: string; role: string; x: number; y: number; width: number; height: number; visible: boolean }>> {
    const wc = this.win?.webContents
    if (!wc) return []
    return await wc.executeJavaScript(`
      (() => {
        return [...document.querySelectorAll(${JSON.stringify(selector)})].map(el => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').trim().slice(0, 200),
            value: el.value || '',
            id: el.id || '',
            classes: el.className || '',
            href: el.href || el.getAttribute('href') || '',
            role: el.getAttribute('role') || '',
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
            visible: r.width > 0 && r.height > 0,
          };
        });
      })()
    `, true) as Array<{ tag: string; text: string; value: string; id: string; classes: string; href: string; role: string; x: number; y: number; width: number; height: number; visible: boolean }>
  }

  async getLinks(textFilter?: string): Promise<Array<{ text: string; href: string; x: number; y: number }>> {
    const wc = this.win?.webContents
    if (!wc) return []
    return await wc.executeJavaScript(`
      (() => {
        const filter = ${JSON.stringify(textFilter?.toLowerCase() ?? null)};
        return [...document.querySelectorAll('a[href]')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            if (!filter) return true;
            return (el.innerText || el.textContent || '').toLowerCase().includes(filter);
          })
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              text: (el.innerText || el.textContent || '').trim().slice(0, 200),
              href: el.href || el.getAttribute('href') || '',
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
            };
          });
      })()
    `, true) as Array<{ text: string; href: string; x: number; y: number }>
  }

  async waitForText(text: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = (await this.win?.webContents.executeJavaScript(
        `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`
      )) as boolean | undefined
      if (found) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`Text not found within ${timeoutMs}ms: ${JSON.stringify(text)}`)
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

function normalizeMaxChars(maxChars: number | undefined): number | undefined {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) return undefined
  return Math.floor(maxChars)
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.split(/\r\n|\r|\n/).length
}
