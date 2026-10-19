import { app, BrowserWindow, type Session } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'

// Playwright launches the real compiled app. When an explicit E2E profile is
// supplied, redirect every app-owned file and Chromium cache away from the
// developer's actual profile before modules compute paths at import time.
const e2eUserData = process.env['MULTIAGENT_E2E_USER_DATA_DIR']
export const isE2ERun = Boolean(e2eUserData)

export type E2EJiraMentionsTextMenuRecord = {
  target: 'editable' | 'selection'
  x: number
  y: number
  items: Array<{ role?: string; type?: string; enabled: boolean }>
}

type E2EDiagnostics = {
  externalOpenAttempts: string[]
  blockedNetworkRequests: string[]
  syntheticClipboardText: string
  jiraMentionsTextMenus: E2EJiraMentionsTextMenuRecord[]
}

const e2eDiagnostics: E2EDiagnostics = {
  externalOpenAttempts: [],
  blockedNetworkRequests: [],
  syntheticClipboardText: '',
  jiraMentionsTextMenus: [],
}
if (isE2ERun) {
  ;(globalThis as typeof globalThis & { __multiagentE2EDiagnostics?: E2EDiagnostics })
    .__multiagentE2EDiagnostics = e2eDiagnostics
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

export function shouldBlockE2EUrl(rawUrl: string): boolean {
  if (!isE2ERun) return false
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    e2eDiagnostics.blockedNetworkRequests.push(rawUrl)
    return true
  }

  if (['file:', 'data:', 'blob:', 'about:', 'devtools:'].includes(url.protocol)) return false
  if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && isLoopbackHost(url.hostname)) return false

  e2eDiagnostics.blockedNetworkRequests.push(url.toString())
  return true
}

export function recordE2EExternalOpenAttempt(url: string): boolean {
  if (!isE2ERun) return false
  e2eDiagnostics.externalOpenAttempts.push(url)
  return true
}

export function getE2ESyntheticClipboardText(): string {
  return isE2ERun ? e2eDiagnostics.syntheticClipboardText : ''
}

export function recordE2EJiraMentionsTextMenu(record: E2EJiraMentionsTextMenuRecord): void {
  if (!isE2ERun) return
  e2eDiagnostics.jiraMentionsTextMenus.push(record)
}

const guardedSessions = new WeakSet<Session>()
export function installE2ENetworkGuard(targetSession: Session): void {
  if (!isE2ERun || guardedSessions.has(targetSession)) return
  guardedSessions.add(targetSession)
  targetSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: shouldBlockE2EUrl(details.url) })
  })
}

function preventWindowAttention(win: BrowserWindow): void {
  // E2E renderers are controlled through Playwright while remaining completely
  // off the user's desktop. Override every Electron API that could reveal a
  // window; the shared policy also catches future call sites automatically.
  for (const method of ['show', 'showInactive', 'focus', 'restore', 'moveTop'] as const) {
    try {
      Object.defineProperty(win, method, { configurable: true, value: () => undefined })
    } catch {
      // The show:false constructor option remains the primary protection if an
      // Electron build exposes a non-configurable method.
    }
  }
  win.on('show', () => win.hide())
}

if (isE2ERun) {
  app.on('browser-window-created', (_event, win) => preventWindowAttention(win))

  // Main-process fetch is used by the Jira clients and MCP bridge. Refuse
  // external destinations here as well as in Electron's renderer request hook.
  const nativeFetch = globalThis.fetch?.bind(globalThis)
  if (nativeFetch) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (shouldBlockE2EUrl(url)) {
        return Promise.reject(new Error(`External network access is disabled in E2E: ${url}`))
      }
      return nativeFetch(input, init)
    }) as typeof fetch
  }
}

if (e2eUserData) {
  const sessionData = join(e2eUserData, 'session-data')
  mkdirSync(e2eUserData, { recursive: true })
  mkdirSync(sessionData, { recursive: true })
  app.setPath('userData', e2eUserData)
  app.setPath('sessionData', sessionData)
}
