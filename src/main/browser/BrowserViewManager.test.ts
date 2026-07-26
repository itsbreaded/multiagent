import { beforeEach, describe, expect, it, vi } from 'vitest'

// BrowserViewManager imports `BrowserWindow` from 'electron' at runtime. In the
// node test env the 'electron' package exports a binary path string, not the
// API — stub it so the import is well-shaped. No test exercises the
// `new BrowserWindow` path (a fake `win` is injected per-test), so the stub
// class body is intentionally empty.
vi.mock('electron', () => ({
  BrowserWindow: class {},
}))

import { BrowserViewManager } from './BrowserViewManager'

/**
 * The manager's logic is exercised through the `executeJavaScript` script
 * strings it builds and the return values it expects. This fake records every
 * script sent to webContents and lets each test queue the return values the
 * in-page probe would produce, then asserts on (a) the generated script and
 * (b) the manager's observable behavior (thrown errors, sendInputEvent calls,
 * the returned navigation/ matchCount). This is the only testable seam
 * without spinning up a real Electron window.
 */
function makeManager() {
  const scripts: string[] = []
  const returns: unknown[] = []
  const inputEvents: unknown[] = []
  let url = 'https://example.com/'
  let title = ''
  const loadURLCalls: string[] = []
  const reloadCalls: number[] = []
  const wc = {
    executeJavaScript: (s: string) => {
      scripts.push(s)
      return Promise.resolve(returns.shift())
    },
    sendInputEvent: (e: unknown) => { inputEvents.push(e) },
    getURL: () => url,
    getTitle: () => title,
    isLoading: () => false,
    reload: () => { reloadCalls.push(1) },
    capturePage: async () => ({ toDataURL: () => 'data:image/png;base64,' }),
    loadURL: async (u: string) => { loadURLCalls.push(u); url = u },
    once: () => {},
    removeListener: () => {},
  }
  const win = {
    isDestroyed: () => false,
    webContents: wc,
    focus: () => {},
    show: () => {},
    on: () => {},
    hide: () => {},
    destroy: () => {},
  }
  const mgr = new BrowserViewManager()
  ;(mgr as unknown as { win: unknown }).win = win
  return {
    mgr, scripts, returns, inputEvents, loadURLCalls, reloadCalls,
    setUrl: (u: string) => { url = u },
    setTitle: (t: string) => { title = t },
  }
}

describe('BrowserViewManager — spec 051 fixes', () => {
  describe('RF-3 evaluate — async context + function detect', () => {
    it('evaluates async function input through the function-call contract', async () => {
      const { mgr, scripts, returns } = makeManager()
      returns.push(42)
      const result = await mgr.evaluate('async () => await Promise.resolve(42)')
      expect(result).toBe(42)
      // detect-then-call shape: eval the submitted string, call if function.
      expect(scripts[0]).toContain('(async () => { const v = eval(')
      expect(scripts[0]).toContain('typeof v === \'function\' ? await v() : v')
    })
  })

  describe('RF-4.2 click/type/hover — actionability pre-check', () => {
    it('click throws "Selector not found" when the probe resolves null', async () => {
      const { mgr, returns } = makeManager()
      returns.push(null)
      await expect(mgr.click('#missing')).rejects.toThrow('Selector not found: #missing')
    })

    it('click throws "Element not actionable (not visible)" for a zero-size element', async () => {
      const { mgr, returns } = makeManager()
      returns.push({ error: 'not visible' })
      await expect(mgr.click('#hidden')).rejects.toThrow(/not actionable \(not visible\): #hidden/)
    })

    it('click throws "Element not actionable (disabled)" for a disabled element', async () => {
      const { mgr, returns } = makeManager()
      returns.push({ error: 'disabled' })
      await expect(mgr.click('#btn')).rejects.toThrow(/not actionable \(disabled\): #btn/)
    })

    it('click dispatches mouseDown/mouseUp at the resolved coords on success', async () => {
      const { mgr, returns, inputEvents } = makeManager()
      returns.push({ x: 10, y: 20 })
      await mgr.click('#btn')
      const types = inputEvents.map((e) => (e as { type: string }).type)
      expect(types).toEqual(['mouseDown', 'mouseUp'])
    })

    it('the click probe asserts visibility + disabled, not just existence', async () => {
      const { mgr, scripts, returns } = makeManager()
      returns.push({ x: 1, y: 1 })
      await mgr.click('#btn')
      expect(scripts[0]).toContain('r.width > 0 && r.height > 0')
      expect(scripts[0]).toContain('.disabled')
      expect(scripts[0]).toContain("document.querySelector(\"#btn\")")
    })

    it('type shares the actionability probe (throws on not visible)', async () => {
      const { mgr, returns } = makeManager()
      returns.push({ error: 'not visible' })
      await expect(mgr.type('#hidden', 'hi')).rejects.toThrow(/not actionable/)
    })

    it('hover shares the actionability probe (throws on not visible)', async () => {
      const { mgr, returns } = makeManager()
      returns.push({ error: 'not visible' })
      await expect(mgr.hover('#hidden')).rejects.toThrow(/not actionable/)
    })
  })

  describe('RF-4.6 waitFor — visibility, not existence', () => {
    it('resolves when the element is visible', async () => {
      const { mgr, returns } = makeManager()
      returns.push(true)
      await expect(mgr.waitFor('#x', 1000)).resolves.toBeUndefined()
    })

    it('rejects when the element never becomes visible (times out)', async () => {
      const { mgr } = makeManager()
      // queue empty -> executeJavaScript returns undefined (falsy) each poll
      await expect(mgr.waitFor('#x', 10)).rejects.toThrow(/Selector not found within 10ms/)
    })

    it('the poll script checks visibility, not just querySelector existence', async () => {
      const { mgr, scripts, returns } = makeManager()
      returns.push(true)
      await mgr.waitFor('#x', 1000)
      expect(scripts[0]).toContain('getBoundingClientRect')
      expect(scripts[0]).toContain('r.width > 0 && r.height > 0')
      // must NOT be the old bare `!!document.querySelector(...)`
      expect(scripts[0]).not.toMatch(/^\s*return\s*\(?\s*!?\s*document\.querySelector/)
    })
  })

  describe('RF-2 clickText — count ambiguous matches + warn', () => {
    it('returns matchCount and clicks when exactly one match', async () => {
      const { mgr, returns, inputEvents } = makeManager()
      returns.push({ x: 5, y: 6, href: null, count: 1 }, null)
      const nav = await mgr.clickText('Add')
      expect(nav.matchCount).toBe(1)
      expect(inputEvents.length).toBeGreaterThanOrEqual(2) // mouseDown + mouseUp
    })

    it('returns matchCount=N when N visible matches, still clicking the first', async () => {
      const { mgr, returns, inputEvents } = makeManager()
      returns.push({ x: 5, y: 6, href: null, count: 4 }, null)
      const nav = await mgr.clickText('Add')
      expect(nav.matchCount).toBe(4)
      // still dispatches a click (first match)
      expect(inputEvents.map((e) => (e as { type: string }).type)).toEqual(['mouseDown', 'mouseUp'])
    })

    it('throws when no visible element matches', async () => {
      const { mgr, returns } = makeManager()
      returns.push(null)
      await expect(mgr.clickText('Nope')).rejects.toThrow(/No visible element with text/)
    })

    it('for an http(s) href it navigates directly (no sendInputEvent)', async () => {
      const { mgr, returns, inputEvents, loadURLCalls } = makeManager()
      returns.push({ x: 5, y: 6, href: 'https://target/page', count: 1 })
      const nav = await mgr.clickText('Go')
      expect(nav.matchCount).toBe(1)
      expect(loadURLCalls).toEqual(['https://target/page'])
      expect(inputEvents).toEqual([]) // bypass: no mouseDown/Up
    })

    it('the probe collects all matches and reports count', async () => {
      const { mgr, scripts, returns } = makeManager()
      returns.push({ x: 1, y: 1, href: null, count: 2 }, null)
      await mgr.clickText('Add')
      expect(scripts[0]).toContain('count: found.length')
      // three passes still present
      expect(scripts[0]).toContain("document.querySelectorAll('a')")
      expect(scripts[0]).toContain("document.querySelectorAll('button, [role=\"button\"], [role=\"menuitem\"], [role=\"option\"]')")
      expect(scripts[0]).toContain("document.querySelectorAll('li, td, th, label, span, div, p')")
      // dedup set present
      expect(scripts[0]).toContain('new Set()')
    })
  })

  describe('RF-4.5 selectOption — verify <select>', () => {
    it('resolves when the target is a <select>', async () => {
      const { mgr, returns } = makeManager()
      returns.push({ ok: true })
      await expect(mgr.selectOption('#s', 'opt')).resolves.toBeUndefined()
    })

    it('throws when the target is not a <select>', async () => {
      const { mgr, returns } = makeManager()
      returns.push({ error: 'not a <select>' })
      await expect(mgr.selectOption('#div', 'opt')).rejects.toThrow(/not a <select> \(#div\)/)
    })

    it('throws "Selector not found" when absent', async () => {
      const { mgr, returns } = makeManager()
      returns.push({ error: 'not found' })
      await expect(mgr.selectOption('#missing', 'opt')).rejects.toThrow('Selector not found: #missing')
    })

    it('the probe guards tagName before setting value', async () => {
      const { mgr, scripts, returns } = makeManager()
      returns.push({ ok: true })
      await mgr.selectOption('#s', 'opt')
      expect(scripts[0]).toContain("tagName !== 'SELECT'")
    })
  })

  describe('BG-I1 navigate — scheme validation', () => {
    it('allows https', async () => {
      const { mgr, loadURLCalls } = makeManager()
      await mgr.navigate('https://example.com/x')
      expect(loadURLCalls).toEqual(['https://example.com/x'])
    })

    it('allows about:blank', async () => {
      const { mgr, loadURLCalls } = makeManager()
      await mgr.navigate('about:blank')
      expect(loadURLCalls).toEqual(['about:blank'])
    })

    it('normalizes bare localhost to http://', async () => {
      const { mgr, loadURLCalls } = makeManager()
      await mgr.navigate('localhost:3000')
      expect(loadURLCalls).toEqual(['http://localhost:3000/'])
    })

    it('rejects file:// without opening a window or loading', async () => {
      const { mgr, loadURLCalls } = makeManager()
      await expect(mgr.navigate('file:///C:/secret.txt')).rejects.toThrow(/non-http\(s\) URL/)
      expect(loadURLCalls).toEqual([])
    })

    it('rejects data: urls', async () => {
      const { mgr, loadURLCalls } = makeManager()
      await expect(mgr.navigate('data:text/html,<h1>x')).rejects.toThrow(/non-http\(s\) URL/)
      expect(loadURLCalls).toEqual([])
    })

    it('rejects javascript: urls', async () => {
      const { mgr, loadURLCalls } = makeManager()
      await expect(mgr.navigate('javascript:alert(1)')).rejects.toThrow(/non-http\(s\) URL/)
      expect(loadURLCalls).toEqual([])
    })
  })

  describe('BG-B5 reload', () => {
    it('reloads the current page and waits for load', async () => {
      const { mgr, reloadCalls, setUrl, setTitle } = makeManager()
      setUrl('https://example.com/here')
      setTitle('H')
      const nav = await mgr.reload()
      expect(reloadCalls).toEqual([1])
      expect(nav).toEqual({ url: 'https://example.com/here', title: 'H' })
    })

    it('throws the closed-window message when no window is open', async () => {
      const mgr = new BrowserViewManager()
      // no fake win injected -> _requireWebContents throws
      await expect(mgr.reload()).rejects.toThrow('Browser window not open')
    })
  })
})

describe('BrowserViewManager — closed-window honesty', () => {
  beforeEach(() => {
    // ensure each test starts from a clean manager; makeManager injects its own
    // fake win, so this is just a no-op anchor for the shared-closed cases below.
  })
  it('evaluate surfaces the shared window-not-open message', async () => {
    const mgr = new BrowserViewManager()
    await expect(mgr.evaluate('1+1')).rejects.toThrow('Browser window not open — call browser_navigate to open it')
  })
})

describe('BrowserViewManager — observability', () => {
  it('returns chronological bounded console and network buffers with truncation metadata', async () => {
    const { mgr } = makeManager()
    const internals = mgr as unknown as {
      _appendConsole: (entry: { level: number; message: string; sourceUrl: string; line: number; timestamp: number }) => void
      _appendNetwork: (entry: { method: string; url: string; resourceType: string; status: number | null; failure: string | null; timestamp: number; durationMs: number }) => void
      consoleEntries: unknown[]
      consoleTruncated: boolean
    }
    internals._appendConsole({ level: 3, message: 'first', sourceUrl: 'https://app.test/a.js', line: 1, timestamp: 1 })
    internals._appendConsole({ level: 3, message: 'second', sourceUrl: 'https://app.test/a.js', line: 2, timestamp: 2 })
    internals._appendNetwork({ method: 'GET', url: 'https://api.test/items', resourceType: 'fetch', status: 200, failure: null, timestamp: 3, durationMs: 12 })
    internals.consoleEntries = Array.from({ length: 200 }, (_, i) => ({ level: 1, message: String(i), sourceUrl: '', line: 0, timestamp: i }))
    internals._appendConsole({ level: 3, message: 'latest', sourceUrl: '', line: 0, timestamp: 201 })

    const consoleResult = await mgr.getConsoleMessages()
    expect(consoleResult.truncated).toBe(true)
    expect(consoleResult.entries).toHaveLength(200)
    expect(consoleResult.entries[0]).toMatchObject({ message: '1' })
    expect(consoleResult.entries.at(-1)).toMatchObject({ message: 'latest' })
    await expect(mgr.getNetworkRequests()).resolves.toEqual({
      truncated: false,
      entries: [{ method: 'GET', url: 'https://api.test/items', resourceType: 'fetch', status: 200, failure: null, timestamp: 3, durationMs: 12 }],
    })
  })

  it('clears buffers when destroyed and only reports cookie values from the cookie API', async () => {
    const { mgr } = makeManager()
    const internals = mgr as unknown as {
      _appendConsole: (entry: { level: number; message: string; sourceUrl: string; line: number; timestamp: number }) => void
      consoleEntries: unknown[]
      win: { webContents: { session: unknown } }
    }
    let cookies = [{ name: 'session', value: 'sensitive-value', domain: 'app.test', path: '/', hostOnly: true, httpOnly: true, secure: true, session: false, sameSite: 'lax' }]
    const remove = vi.fn(async () => { cookies = [] })
    internals.win.webContents.session = {
      cookies: {
        get: async () => cookies,
        remove,
      },
    }
    await expect(mgr.getCookies()).resolves.toMatchObject([{ name: 'session', value: 'sensitive-value' }])
    await expect(mgr.deleteCookie('https://app.test/', 'session')).resolves.toBe(true)
    expect(remove).toHaveBeenCalledWith('https://app.test/', 'session')
    await expect(mgr.getCookies()).resolves.toEqual([])
    internals._appendConsole({ level: 3, message: 'secret must not log', sourceUrl: '', line: 0, timestamp: 1 })
    mgr.destroy()
    expect(internals.consoleEntries).toEqual([])
  })
})
