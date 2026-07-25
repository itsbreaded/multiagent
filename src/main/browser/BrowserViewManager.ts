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

  /**
   * Single shared guard for the closed-window state. Used by every interaction
   * and query method so they fail honestly with a recovery hint instead of
   * returning a fake-success value. The prefix `Browser window not open` is
   * load-bearing — keep it.
   */
  private _requireWebContents(): Electron.WebContents {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('Browser window not open — call browser_navigate to open it')
    }
    return this.win.webContents
  }

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
    // Spec 051, BG-I1: validate the scheme before opening a window. The agent
    // (and clickText's http-href branch) can otherwise load file:// / data: /
    // javascript: into the agent-controlled panel, which it can then evaluate
    // against — a filesystem read path. http/https/about only.
    const normalized = normalizeNavigableUrl(url)
    const win = this._ensureWindow()
    win.show()
    this.state = 'agent-controlled'
    this.emit('state-changed', this.state)
    await win.webContents.loadURL(normalized)
    return { url: win.webContents.getURL(), title: win.webContents.getTitle() }
  }

  async reload(): Promise<{ url: string; title: string }> {
    // Spec 051, BG-B5: Playwright has browser_reload; this repo only had
    // back/forward, so an agent had to re-navigate by URL (losing form state)
    // to refresh.
    const wc = this._requireWebContents()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.reload()
    await this.waitForLoad(10000)
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  /**
   * JS probe that resolves `selector` to center coords after a visibility +
   * enabled (actionability) check. Returns `{x,y}` on success, `null` if the
   * element is absent, or `{ error }` if found but not actionable. Spec 051,
   * RF-4.2: click/type/hover previously fired sendInputEvent at a computed
   * center the instant the element was found, with no visible/enabled check,
   * so a click on a `display:none`/occluded/disabled target silently missed.
   */
  private _actionableSelectorProbe(selector: string): string {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return { error: 'not visible' };
      if ((el).disabled) return { error: 'disabled' };
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`
  }

  /** Resolve a probe result into coords, throwing not-found / not-actionable. */
  private _resolveActionable(
    pos: { x: number; y: number } | { error: string } | null,
    selector: string
  ): { x: number; y: number } {
    if (!pos) throw new Error(`Selector not found: ${selector}`)
    if ('error' in pos) throw new Error(`Element not actionable (${pos.error}): ${selector}`)
    return pos
  }

  async click(selector: string): Promise<{ url: string; title: string }> {
    const wc = this._requireWebContents()
    const urlBefore = wc.getURL()
    const pos = this._resolveActionable(
      await wc.executeJavaScript(this._actionableSelectorProbe(selector), true) as
        { x: number; y: number } | { error: string } | null,
      selector
    )
    this.win!.focus()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 } as any)
    return this._waitForNavigationIfStarted(urlBefore)
  }

  async type(selector: string, text: string): Promise<void> {
    const wc = this._requireWebContents()
    const pos = this._resolveActionable(
      await wc.executeJavaScript(this._actionableSelectorProbe(selector), true) as
        { x: number; y: number } | { error: string } | null,
      selector
    )
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
    const wc = this._requireWebContents()
    const image = await wc.capturePage()
    return image.toDataURL()
  }

  async evaluate(js: string): Promise<unknown> {
    const wc = this._requireWebContents()
    // Evaluate the submitted string in an async context so top-level `await`
    // works (spec 051, RF-3: raw executeJavaScript rejects top-level await
    // under this Electron/Chromium config). The string is eval'd as an
    // expression; if it resolves to a function we call it (so `async () =>
    // { ... }` bodies run), otherwise we return its value. This mirrors
    // Playwright's browser_evaluate and preserves the "any JS string" contract
    // for bare expressions, `;`-terminated statements, and multi-statement
    // scripts. executeJavaScript is a privileged injection (like the DevTools
    // console), so the nested eval is not subject to page CSP unsafe-eval.
    return wc.executeJavaScript(
      `(async () => { const v = eval(${JSON.stringify(js)}); return typeof v === 'function' ? await v() : v; })()`,
      true
    )
  }

  async getContent(options: BrowserContentOptions = {}): Promise<BrowserContentResult> {
    const wc = this._requireWebContents()

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
    const wc = this._requireWebContents()
    await wc.executeJavaScript(`window.scrollBy(${x}, ${y})`)
  }

  async waitFor(selector: string, timeoutMs = 5000): Promise<void> {
    const wc = this._requireWebContents()
    const deadline = Date.now() + timeoutMs
    // Spec 051, RF-4.6: poll *visibility*, not bare existence — an element with
    // `display:none`/`hidden` satisfied the old `!!querySelector` check, so the
    // following click/type hit a non-rendered target.
    while (Date.now() < deadline) {
      const found = await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`
      ) as boolean
      if (found) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`Selector not found within ${timeoutMs}ms: ${selector}`)
  }

  getCurrentUrl(): string {
    const wc = this._requireWebContents()
    return wc.getURL()
  }

  async goBack(): Promise<{ url: string; title: string }> {
    const wc = this._requireWebContents()
    if (!wc.canGoBack()) throw new Error('No previous page in history')
    wc.goBack()
    await this._waitForNavigation()
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  async goForward(): Promise<{ url: string; title: string }> {
    const wc = this._requireWebContents()
    if (!wc.canGoForward()) throw new Error('No next page in history')
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
    const wc = this._requireWebContents()
    const pos = this._resolveActionable(
      await wc.executeJavaScript(this._actionableSelectorProbe(selector)) as
        { x: number; y: number } | { error: string } | null,
      selector
    )
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
    const wc = this._requireWebContents()
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
    const wc = this._requireWebContents()
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

  async clickText(text: string, exact = false): Promise<{ url: string; title: string; matchCount: number }> {
    const wc = this._requireWebContents()
    // Three-pass search: <a> first (preferred for navigation), then buttons, then
    // structural containers — for containers, walk up to the nearest <a> ancestor.
    // Spec 051, RF-2: collect ALL visible actionable matches (deduped) across the
    // three passes — not just the first — so the caller can warn when the label
    // is ambiguous (e.g. 20 "Add" buttons). The clicked target is still the first
    // match in pass order. RF-4.2: matches must also be visible + not disabled.
    const found = await wc.executeJavaScript(`
      (() => {
        const exact = ${JSON.stringify(exact)};
        const needle = ${JSON.stringify(text)};
        const matches = (el) => {
          const t = (el.innerText || el.textContent || '').trim();
          return exact ? t === needle : t.toLowerCase().includes(needle.toLowerCase());
        };
        const actionable = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; };
        const toResult = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: el.href || null };
        };
        const seen = new Set();
        const found = [];
        const consider = (el) => {
          if (!el || seen.has(el) || !matches(el) || !actionable(el)) return;
          seen.add(el); found.push(el);
        };
        // Pass 1: <a> elements — exact link targets, preferred for navigation
        for (const el of document.querySelectorAll('a')) consider(el);
        // Pass 2: buttons and interactive ARIA roles
        for (const el of document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')) consider(el);
        // Pass 3: structural containers — walk up to nearest <a> ancestor so
        // complex product cards (e.g. Amazon <li> wrapping a link) resolve correctly.
        // If an <a> ancestor exists, attribute the match to it (dedups vs pass 1);
        // otherwise the structural element itself is the match.
        for (const el of document.querySelectorAll('li, td, th, label, span, div, p')) {
          if (!matches(el) || !actionable(el) || seen.has(el)) continue;
          let cur = el.parentElement, linkAncestor = null;
          while (cur && cur !== document.body) {
            if (cur.tagName === 'A' && actionable(cur)) { linkAncestor = cur; break; }
            cur = cur.parentElement;
          }
          if (linkAncestor) consider(linkAncestor); else consider(el);
        }
        if (!found.length) return null;
        return { ...toResult(found[0]), count: found.length };
      })()
    `, true) as { x: number; y: number; href: string | null; count: number } | null
    if (!found) throw new Error(`No visible element with text: ${JSON.stringify(text)}`)
    // For real http(s) links, navigate directly — bypasses coordinate precision issues
    // on deeply nested link structures and waits for the page to finish loading.
    // (Spec 051 RF-4.4 notes this skips SPA preventDefault / target=_blank / download
    // handlers; a "dispatch click first, fall back to navigate" rework is deferred.)
    if (found.href && /^https?:/.test(found.href)) {
      return { ...(await this.navigate(found.href)), matchCount: found.count }
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
    return { ...(await this._waitForNavigationIfStarted(urlBefore)), matchCount: found.count }
  }

  async getElements(selector: string): Promise<Array<{ tag: string; text: string; value: string; id: string; classes: string; href: string; role: string; x: number; y: number; width: number; height: number; visible: boolean }>> {
    const wc = this._requireWebContents()
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
    const wc = this._requireWebContents()
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
    const wc = this._requireWebContents()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await wc.executeJavaScript(
        `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`
      ) as boolean
      if (found) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`Text not found within ${timeoutMs}ms: ${JSON.stringify(text)}`)
  }

  async keyboard(key: string, modifiers: string[] = []): Promise<void> {
    const wc = this._requireWebContents()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mods = modifiers as any
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
  }

  async waitForLoad(timeoutMs = 10000): Promise<void> {
    const wc = this._requireWebContents()
    if (!wc.isLoading()) return
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
    const wc = this._requireWebContents()
    // Spec 051, RF-4.5: verify the target is a <select> — the old code set
    // `el.value` and fired change/input on whatever querySelector returned; for
    // a non-select the assignment silently no-ops but the synthetic events
    // still fire on the wrong element and can trigger unrelated handlers.
    const result = await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'not found' };
        if (el.tagName !== 'SELECT') return { error: 'not a <select>' };
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      })()
    `, true) as { ok: true } | { error: string } | null | undefined
    if (!result || !('ok' in result)) {
      const err = (result as { error?: string } | null)?.error
      if (err === 'not found') throw new Error(`Selector not found: ${selector}`)
      throw new Error(`browser_select target is not a <select> (${selector})`)
    }
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

const ALLOWED_NAV_SCHEMES = new Set(['http:', 'https:', 'about:'])

/**
 * Validate and normalize a navigation URL. Spec 051, BG-I1: block non-http(s)
 * schemes (`file:`, `data:`, `javascript:`, …) so the agent can't drive the
 * browser panel at the user's filesystem. Allow `about:` (blank). Normalize
 * bare `localhost`/IPv4 (no scheme) to `http://` — mirrors Playwright's
 * `checkUrlAndNavigate` so the common dev-server case still works.
 */
function normalizeNavigableUrl(url: string): string {
  // Recognize bare host forms (`localhost`, `localhost:3000`, IPv4, `host:port`)
  // that `new URL` either rejects or misparses as a custom scheme (e.g.
  // `localhost:3000` parses with protocol `localhost:`), and prefix `http://`.
  const hostLike =
    /^localhost(:\d+)?(\/.*)?$/.test(url) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(url)
  let parsed: URL
  try {
    parsed = new URL(hostLike ? 'http://' + url : url)
  } catch {
    throw new Error(`Invalid URL: ${JSON.stringify(url)}`)
  }
  if (!ALLOWED_NAV_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Refusing to navigate to non-http(s) URL (${parsed.protocol || 'no scheme'}): ${JSON.stringify(url)} — file:, data:, javascript: schemes are blocked`
    )
  }
  return parsed.href
}
