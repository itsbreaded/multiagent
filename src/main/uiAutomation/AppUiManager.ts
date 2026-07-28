import { BrowserWindow, app } from 'electron'

export interface UiWindow { id: number; title: string; url: string; visible: boolean; focused: boolean }
type ConsoleEntry = { level: number; message: string; sourceUrl: string; line: number; timestamp: number }
export type NetworkEntry = { method: string; url: string; resourceType: string; status: number | null; failure: string | null; timestamp: number; durationMs: number }
const NETWORK_LIMIT = 200
const OBSERVED_RESOURCE_TYPES = new Set(['mainFrame', 'fetch', 'xhr', 'script', 'stylesheet'])

export class AppUiManager {
  private console = new Map<number, ConsoleEntry[]>()
  private network = new Map<number, NetworkEntry[]>()
  private networkTruncated = new Set<number>()
  private requestStartedAt = new Map<number, { at: number; webContentsId: number }>()
  private observedSessions = new WeakSet<Electron.Session>()
  initialize(): void {
    for (const win of BrowserWindow.getAllWindows()) this.observe(win)
    app.on('browser-window-created', (_event, win) => this.observe(win))
  }
  private observe(win: BrowserWindow): void {
    const id = win.id
    this.console.set(id, this.console.get(id) ?? [])
    this.network.set(id, this.network.get(id) ?? [])
    win.webContents.on('console-message', (_event, level, message, line, sourceUrl) => {
      const entries = this.console.get(id) ?? []
      entries.push({ level, message, sourceUrl, line, timestamp: Date.now() })
      if (entries.length > 200) entries.shift()
      this.console.set(id, entries)
    })
    win.on('closed', () => { this.console.delete(id); this.network.delete(id); this.networkTruncated.delete(id) })
    this.installNetworkObserver(win)
  }
  private installNetworkObserver(win: BrowserWindow): void {
    const session = win.webContents.session
    if (this.observedSessions.has(session)) return
    this.observedSessions.add(session)
    const observed = (details: { webContentsId?: number; resourceType: string }) =>
      details.webContentsId !== undefined && this.network.has(details.webContentsId) && OBSERVED_RESOURCE_TYPES.has(details.resourceType)
    session.webRequest.onBeforeRequest((details, callback) => {
      if (observed(details) && details.id !== undefined) this.requestStartedAt.set(details.id, { at: Date.now(), webContentsId: details.webContentsId! })
      callback({})
    })
    session.webRequest.onCompleted((details) => this.recordNetwork(details, null))
    session.webRequest.onErrorOccurred((details) => this.recordNetwork(details, details.error))
  }
  private recordNetwork(details: Electron.OnCompletedListenerDetails | Electron.OnErrorOccurredListenerDetails, failure: string | null): void {
    if (details.webContentsId === undefined || !this.network.has(details.webContentsId) || !OBSERVED_RESOURCE_TYPES.has(details.resourceType)) return
    const start = details.id === undefined ? undefined : this.requestStartedAt.get(details.id)
    if (details.id !== undefined) this.requestStartedAt.delete(details.id)
    const entries = this.network.get(details.webContentsId)!
    if (entries.length === NETWORK_LIMIT) { entries.shift(); this.networkTruncated.add(details.webContentsId) }
    entries.push({ method: details.method, url: details.url, resourceType: details.resourceType, status: 'statusCode' in details ? details.statusCode : null, failure, timestamp: Date.now(), durationMs: Math.max(0, Date.now() - (start?.at ?? Date.now())) })
  }
  windows(): UiWindow[] {
    return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => ({ id: w.id, title: w.webContents.getTitle(), url: w.webContents.getURL(), visible: w.isVisible(), focused: w.isFocused() }))
  }
  private window(id: number): BrowserWindow {
    const win = BrowserWindow.fromId(id)
    if (!win || win.isDestroyed()) throw new Error(`Application window not found: ${id}`)
    return win
  }
  async content(id: number): Promise<string> { return String(await this.window(id).webContents.executeJavaScript('document.body?.innerText ?? ""', true)) }
  async evaluate(id: number, js: string): Promise<unknown> { return this.window(id).webContents.executeJavaScript(`(async()=>{const v=eval(${JSON.stringify(js)});return typeof v==='function'?await v():v})()`, true) }
  async click(id: number, selector: string): Promise<void> { await this.evaluate(id, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Selector not found: ${selector}');e.click()})()` ) }
  async type(id: number, selector: string, text: string): Promise<void> {
    await this.evaluate(id, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement))throw new Error('Editable selector not found: ${selector}');e.focus();const prototype=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(prototype,'value')?.set;if(!set)throw new Error('Native value setter is unavailable');set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  }
  async scroll(id: number, x: number, y: number): Promise<void> { await this.evaluate(id, `window.scrollBy(${x},${y})`) }
  async keyboard(id: number, key: string): Promise<void> { await this.evaluate(id, `document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));document.activeElement?.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(key)},bubbles:true}))`) }
  async drag(id: number, source: string, target: string): Promise<void> { await this.evaluate(id, `(()=>{const s=document.querySelector(${JSON.stringify(source)}),t=document.querySelector(${JSON.stringify(target)});if(!s||!t)throw new Error('Drag selector not found');const d=new DataTransfer();for(const [e,n] of [[s,'dragstart'],[t,'dragenter'],[t,'dragover'],[t,'drop'],[s,'dragend']])e.dispatchEvent(new DragEvent(n,{bubbles:true,cancelable:true,dataTransfer:d}))})()`) }
  async waitFor(id: number, selector: string, timeout: number): Promise<void> { const until = Date.now() + timeout; while (Date.now() < until) { if (await this.evaluate(id, `!!document.querySelector(${JSON.stringify(selector)})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error(`Selector not found within ${timeout}ms: ${selector}`) }
  async screenshot(id: number): Promise<string> { return this.window(id).webContents.capturePage().then((image) => image.toDataURL()) }
  consoleEntries(id: number): ConsoleEntry[] { this.window(id); return this.console.get(id) ?? [] }
  networkEntries(id: number): { entries: NetworkEntry[]; truncated: boolean } { this.window(id); return { entries: this.network.get(id) ?? [], truncated: this.networkTruncated.has(id) } }
}
