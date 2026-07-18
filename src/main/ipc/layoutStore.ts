import { BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs'
import type { CwdRepairMapping } from '../../shared/types'
import { replaceCwdPrefix } from '../../shared/cwdRepair'
import { writeJsonAtomic } from '../atomicJson'
import type { IpcRegistrar } from './ipcRegistrar'

interface LayoutWindowManager {
  getPrimaryWindow(): BrowserWindow | null
  isDetachedWindow(id: number): boolean
}

export function createLayoutStore(deps: { layoutPath: string; windowManager: LayoutWindowManager }) {
  const { layoutPath, windowManager } = deps

  function registerHandlers(registrar: IpcRegistrar): void {
    registrar.handle('layout:load', () => {
      try {
        return JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
      } catch {
        return null
      }
    })
    registrar.handle('layout:save', (_e, tabs: unknown, sidebarWidth: unknown, sidebarOpen: unknown, activeTabId: unknown, sidebarSectionOpen: unknown, sidebarPanelSizes: unknown) => {
      try {
        writeJsonAtomic(layoutPath, {
          tabs: normalizeTabsForLayout(tabs), sidebarWidth, sidebarOpen, activeTabId,
          sidebarSectionOpen, sidebarPanelSizes,
        })
      } catch (err) {
        console.error('[MultiAgent] layout:save failed:', err)
      }
    })
  }

  function repairLayoutCwds(mapping: CwdRepairMapping): { changed: boolean; count: number } {
    if (!fs.existsSync(layoutPath)) return { changed: false, count: 0 }
    let layout: unknown
    try {
      layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
    } catch (err) {
      console.error('[MultiAgent] repairLayoutCwds: failed to read layout:', err)
      return { changed: false, count: 0 }
    }
    const result = rewriteLayoutCwds(layout, mapping)
    if (!result.changed) return { changed: false, count: 0 }
    try {
      fs.copyFileSync(layoutPath, `${layoutPath}.bak.${timestampForFilename()}`)
      writeJsonAtomic(layoutPath, layout)
    } catch (err) {
      console.error('[MultiAgent] repairLayoutCwds: failed to write layout:', err)
      return { changed: false, count: 0 }
    }
    return { changed: true, count: result.count }
  }

  async function requestWindowResponse<T>(win: BrowserWindow, sendChannel: string, listenChannel: string, timeoutMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      if (win.isDestroyed()) { resolve(null); return }
      const requestId = `shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`
      let settled = false
      const done = (value: T | null): void => {
        if (settled) return
        settled = true
        ipcMain.removeListener(listenChannel, handler)
        resolve(value)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      const handler = (event: Electron.IpcMainEvent, rid: unknown, data: unknown): void => {
        if (rid !== requestId || BrowserWindow.fromWebContents(event.sender)?.id !== win.id) return
        clearTimeout(timer)
        done(data as T)
      }
      ipcMain.on(listenChannel, handler)
      win.webContents.send(sendChannel, requestId)
    })
  }

  async function performShutdownSave(): Promise<void> {
    const primaryWin = windowManager.getPrimaryWindow()
    if (!primaryWin || primaryWin.isDestroyed()) return
    type PrimaryState = {
      tabs: unknown[]; sidebarWidth: unknown; sidebarOpen: unknown; activeTabId: unknown
      sidebarSectionOpen: unknown; sidebarPanelSizes: unknown
    }
    type DetachedSnapshot = { windowId: number; tabs: unknown[]; activeTabId?: string }
    const detachedWins = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed() && w.id !== primaryWin.id && windowManager.isDetachedWindow(w.id)
    )
    const [primaryState, ...detachedResults] = await Promise.all([
      requestWindowResponse<PrimaryState>(primaryWin, 'layout:request-state', 'layout:state-response', 1000),
      ...detachedWins.map((w) => requestWindowResponse<DetachedSnapshot>(
        w, 'layout:collect-detached-state', 'layout:detached-state-response', 1000
      )),
    ])
    if (!primaryState) {
      console.warn('[MultiAgent] performShutdownSave: primary did not respond, skipping final save')
      return
    }
    let mergedTabs: unknown[] = Array.isArray(primaryState.tabs) ? [...primaryState.tabs] : []
    for (const snap of detachedResults) {
      if (!snap || !Array.isArray(snap.tabs)) continue
      const ids = new Set((snap.tabs as Record<string, unknown>[]).map((tab) => tab['id']))
      mergedTabs = mergedTabs.filter((tab) => !ids.has((tab as Record<string, unknown>)['id']))
      mergedTabs.push(...snap.tabs)
    }
    try {
      writeJsonAtomic(layoutPath, {
        tabs: normalizeTabsForLayout(mergedTabs),
        sidebarWidth: primaryState.sidebarWidth, sidebarOpen: primaryState.sidebarOpen,
        activeTabId: primaryState.activeTabId, sidebarSectionOpen: primaryState.sidebarSectionOpen,
        sidebarPanelSizes: primaryState.sidebarPanelSizes,
      })
    } catch (err) {
      console.error('[MultiAgent] performShutdownSave: layout write failed:', err)
    }
  }

  return { registerHandlers, repairLayoutCwds, performShutdownSave }
}

export function normalizeTabsForLayout(tabs: unknown): unknown {
  if (!Array.isArray(tabs)) return tabs
  return tabs.map((tab) => tab && typeof tab === 'object'
    ? { ...normalizeTabForLayout(tab as Record<string, unknown>), detached: false }
    : tab)
}

/** Per-tab normalization: strip transient pane state before writing layout.json. */
function normalizeTabForLayout(tab: Record<string, unknown>): Record<string, unknown> {
  if (tab && typeof tab.rootNode !== 'undefined') {
    return { ...tab, rootNode: normalizeNodeForLayout(tab.rootNode) }
  }
  return tab
}

/**
 * Strip in-memory-only pane state from a layout node before it is persisted.
 *
 * spec 047: `promotedFromShell` is never serialized. A phase-1-only promoted pane
 * (agent + promotedFromShell + no sessionId) is reverted to a shell here so layout.json
 * never carries a dangling agent leaf; a phase-2-linked promoted pane (has sessionId) is
 * kept as an agent pane so it resumes on restart. Non-promoted panes pass through
 * unchanged (applyLayout's sanitizeNode still handles legacy agent-no-sessionId on load).
 */
function normalizeNodeForLayout(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>
  if (record['type'] === 'leaf') {
    if (record['promotedFromShell'] === true) {
      const promoted = { ...record }
      delete promoted['promotedFromShell']
      delete promoted['agentStatus'] // spec 032: in-memory only, never serialized
      if (!promoted['sessionId']) {
        // Phase-1-only promotion (no session linked): persist as the original shell pane.
        promoted['paneType'] = 'shell'
        delete promoted['agentKind']
        delete promoted['sessionId']
        delete promoted['sessionDetectionState']
        delete promoted['sessionDetectionStartedAt']
        delete promoted['sessionDetectionCwd']
        delete promoted['sessionDetectionError']
      }
      return promoted
    }
    // Defensive: never persist the flag even if it somehow appears on a non-promoted leaf.
    if ('promotedFromShell' in record) {
      const cleaned = { ...record }
      delete cleaned['promotedFromShell']
      delete cleaned['agentStatus'] // spec 032: in-memory only, never serialized
      return cleaned
    }
    // spec 032: a native (non-promoted) agent leaf still must not persist agentStatus.
    if ('agentStatus' in record) {
      const cleaned = { ...record }
      delete cleaned['agentStatus']
      return cleaned
    }
    return record
  }
  if (record['type'] === 'split') {
    return { ...record, first: normalizeNodeForLayout(record['first']), second: normalizeNodeForLayout(record['second']) }
  }
  return record
}

export function rewriteLayoutCwds(layout: unknown, mapping: CwdRepairMapping): { changed: boolean; count: number } {
  if (!layout || typeof layout !== 'object') return { changed: false, count: 0 }
  const tabs = (layout as { tabs?: unknown }).tabs
  if (!Array.isArray(tabs)) return { changed: false, count: 0 }
  let count = 0
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object') continue
    count += rewritePathProperty(tab as Record<string, unknown>, 'defaultCwd', mapping)
    count += rewriteNodeCwds((tab as { rootNode?: unknown }).rootNode, mapping)
  }
  return { changed: count > 0, count }
}

function rewriteNodeCwds(node: unknown, mapping: CwdRepairMapping): number {
  if (!node || typeof node !== 'object') return 0
  const record = node as Record<string, unknown>
  if (record['type'] === 'leaf') {
    return rewritePathProperty(record, 'cwd', mapping) + rewritePathProperty(record, 'sessionDetectionCwd', mapping)
  }
  if (record['type'] === 'split') {
    return rewriteNodeCwds(record['first'], mapping) + rewriteNodeCwds(record['second'], mapping)
  }
  return 0
}

function rewritePathProperty(record: Record<string, unknown>, key: string, mapping: CwdRepairMapping): number {
  const value = record[key]
  if (typeof value !== 'string') return 0
  const rewritten = replaceCwdPrefix(value, mapping)
  if (rewritten === value) return 0
  record[key] = rewritten
  return 1
}

export function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export { writeJsonAtomic }
