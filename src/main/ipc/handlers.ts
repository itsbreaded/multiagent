import { ipcMain, BrowserWindow, shell, clipboard, app, dialog } from 'electron'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { execFile, execFileSync } from 'child_process'
import { SessionIndex } from '../sessions/SessionIndex'
import { TranscriptScanner } from '../sessions/TranscriptScanner'
import { CodexSessionScanner } from '../sessions/CodexSessionScanner'
import { SessionSpawner } from '../sessions/SessionSpawner'
import { PtyManager } from '../pty/PtyManager'
import { openExternalUrl } from '../external'
import { mcpManager } from '../mcp/McpManager'
import { probeStdioServer } from '../mcp/probeStdio'
import { windowManager } from '../window/WindowManager'
import type { AgentKind, McpSettings, PaneTransferPayload, Tab } from '../../shared/types'

let vsCodeAvailable = false
try {
  execFileSync('code', ['--version'], { stdio: 'ignore', shell: true, timeout: 3000 })
  vsCodeAvailable = true
} catch {
  vsCodeAvailable = false
}

let remoteFocusRequestSeq = 0
let focusTargetVersionSeq = 0
let tabReleaseSeq = 0
const GIT_BRANCH_CACHE_MS = 10_000

interface CoalesceEntry {
  data: string
  immediate: NodeJS.Immediate
}

interface GitBranchCacheEntry {
  branch: string | null
  expiresAt: number
}

const gitBranchCache = new Map<string, GitBranchCacheEntry>()

/**
 * Parse an OSC 7 CWD escape sequence from PTY output.
 * Format: ESC ] 7 ; file://[host]/path BEL  (or ST terminator)
 */
function parseOsc7(data: string): string | null {
  const match = data.match(/\x1b\]7;file:\/\/[^\x07\x1b/]*(\/?[^\x07\x1b]*)(?:\x07|\x1b\\)/)
  if (!match || !match[1]) return null
  let cwd = match[1]
  try { cwd = decodeURIComponent(cwd) } catch { /* use raw value */ }
  if (process.platform === 'win32') {
    if (/^\/[A-Za-z]:/.test(cwd)) cwd = cwd.slice(1)  // /C:/... → C:/...
    cwd = cwd.replace(/\//g, '\\')
  }
  return cwd || null
}

export async function registerIpcHandlers(mainWindow: BrowserWindow): Promise<{
  cleanup: () => void
  registerWindowHandlers: (win: BrowserWindow) => void
  performShutdownSave: () => Promise<void>
}> {
  const index = new SessionIndex()
  const claudeScanner = new TranscriptScanner()
  const codexScanner = new CodexSessionScanner()
  const ptyManager = new PtyManager()
  const spawner = new SessionSpawner(ptyManager, mainWindow)
  const coalesceBuffer = new Map<string, CoalesceEntry>()
  const registeredWindowHandlers = new WeakSet<BrowserWindow>()

  function enqueuePtyOutput(ptyId: string, chunk: string): void {
    const entry = coalesceBuffer.get(ptyId)
    if (entry) {
      entry.data += chunk
      return
    }
    const newEntry: CoalesceEntry = {
      data: chunk,
      immediate: setImmediate(() => {
        coalesceBuffer.delete(ptyId)
        windowManager.sendToWindowForPty(ptyId, 'pty:data', ptyId, newEntry.data)
      }),
    }
    coalesceBuffer.set(ptyId, newEntry)
  }

  function flushCoalesceEntry(ptyId: string): void {
    const entry = coalesceBuffer.get(ptyId)
    if (!entry) return
    clearImmediate(entry.immediate)
    coalesceBuffer.delete(ptyId)
    windowManager.sendToWindowForPty(ptyId, 'pty:data', ptyId, entry.data)
  }

  async function scanAllSessions() {
    const [claudeSessions, codexSessions] = await Promise.all([
      claudeScanner.scanAll(),
      codexScanner.scanAll(),
    ])
    return [...claudeSessions, ...codexSessions]
  }

  function execGit(args: string[], cwd: string, timeout = 1500): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout, windowsHide: true }, (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout.toString().trim())
      })
    })
  }

  async function resolveGitBranch(cwd: string): Promise<string | null> {
    if (typeof cwd !== 'string' || !cwd.trim()) return null
    const normalizedCwd = normalizePath(cwd)
    const cached = gitBranchCache.get(normalizedCwd)
    if (cached && cached.expiresAt > Date.now()) return cached.branch

    let branch: string | null = null
    try {
      const inside = await execGit(['rev-parse', '--is-inside-work-tree'], cwd)
      if (inside !== 'true') {
        gitBranchCache.set(normalizedCwd, { branch: null, expiresAt: Date.now() + GIT_BRANCH_CACHE_MS })
        return null
      }

      const current = await execGit(['branch', '--show-current'], cwd)
      if (current) {
        branch = current
      } else {
        const head = await execGit(['rev-parse', '--short', 'HEAD'], cwd)
        branch = head ? `detached@${head}` : null
      }
    } catch {
      branch = null
    }

    gitBranchCache.set(normalizedCwd, { branch, expiresAt: Date.now() + GIT_BRANCH_CACHE_MS })
    return branch
  }

  // Per-window setup: send current session list when a new window loads,
  // and broadcast to all windows whenever this window gains OS focus.
  function registerWindowHandlers(win: BrowserWindow): void {
    if (registeredWindowHandlers.has(win)) return
    registeredWindowHandlers.add(win)
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('sessions:updated', index.getAll())
      win.webContents.send('window:maximized-changed', win.isMaximized())
    })
    win.on('focus', () => {
      windowManager.broadcastAll('window:became-active', win.id)
      win.webContents.send('window:focus-state-request')
    })
    win.on('maximize', () => win.webContents.send('window:maximized-changed', true))
    win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false))
    win.on('restore', () => win.webContents.send('window:maximized-changed', win.isMaximized()))
  }

  // Register the main window and set up its window-specific handlers.
  windowManager.register(mainWindow)
  registerWindowHandlers(mainWindow)

  // Initial full scan on startup.
  scanAllSessions().then((sessions) => {
    sessions.forEach((s) => {
      try { index.upsert(s) } catch { /* skip malformed entries */ }
    })
    windowManager.broadcastAll('sessions:updated', index.getAll())
  }).catch((err) => {
    console.error('[MultiAgent] Session scan failed:', err)
    windowManager.broadcastAll('sessions:updated', [])
  })

  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })

  let lastSessionsJson = ''

  async function pollSessions(): Promise<void> {
    try {
      const sessions = await scanAllSessions()
      for (const session of sessions) {
        index.upsert(session)
      }
      const all = index.getAll()
      const json = JSON.stringify(all)
      if (json !== lastSessionsJson) {
        lastSessionsJson = json
        windowManager.broadcastAll('sessions:updated', all)
      }
    } catch (err) {
      console.error('[MultiAgent] pollSessions error:', err)
    }
  }

  const contentTimer = setInterval(() => { void pollSessions() }, 5000)

  // PTY data -> renderer, coalesced within the current event-loop turn; OSC 7 is parsed immediately for CWD.
  ptyManager.on('data', (ptyId: string, data: string) => {
    enqueuePtyOutput(ptyId, data)
    if (data.includes('\x1b]7;')) {
      const cwd = parseOsc7(data)
      if (cwd) windowManager.sendToWindowForPty(ptyId, 'pty:cwd', ptyId, cwd)
    }
  })

  ptyManager.on('exit', (ptyId: string, exitCode: number) => {
    flushCoalesceEntry(ptyId)
    if (exitCode !== 0) {
      windowManager.sendToWindowForPty(ptyId, 'pty:data', ptyId, `\r\n\x1b[33m[process exited with code ${exitCode}]\x1b[0m\r\n`)
    }
    windowManager.unroutePty(ptyId)
  })

  // --- IPC handlers ---

  ipcMain.handle('sessions:search', (_e, query: string) => index.search(query))

  ipcMain.handle('sessions:delete', (_e, agentKind, sessionId: string) => index.delete(agentKind, sessionId))

  ipcMain.handle('sessions:latest-for-cwd', async (_e, agentKind, cwd: string) => {
    const scanner = agentKind === 'codex' ? codexScanner : claudeScanner
    const sessions = await scanner.scanAll()
    const normalizedCwd = normalizePath(cwd)
    const latest = sessions
      .filter((session) => session.agentKind === agentKind && normalizePath(session.cwd) === normalizedCwd)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (latest) {
      index.upsert(latest)
      return latest.sessionId
    }
    return null
  })

  ipcMain.handle('session:new', async (e, agentKind, cwd: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    const result = await spawner.spawnNew(agentKind, cwd, senderWin)
    windowManager.routePty(result.ptyId, senderWin.webContents.id)
    return result
  })

  ipcMain.handle('session:resume', async (e, agentKind, sessionId: string, cwd: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    const result = await spawner.spawnResume(agentKind, sessionId, cwd, senderWin)
    windowManager.routePty(result.ptyId, senderWin.webContents.id)
    return result
  })

  ipcMain.handle('pty:create', (e, cwd: string) => {
    const ptyId = ptyManager.createShell(cwd)
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    windowManager.routePty(ptyId, senderWin.webContents.id)
    return { ptyId }
  })

  ipcMain.on('pty:write', (_e, ptyId: string, data: string) => ptyManager.write(ptyId, data))

  ipcMain.on('pty:pause-output', (_e, ptyId: string) => ptyManager.pause(ptyId))

  ipcMain.on('pty:resume-output', (_e, ptyId: string) => ptyManager.resume(ptyId))

  ipcMain.handle('pty:resize', (_e, ptyId: string, cols: number, rows: number) => {
    flushCoalesceEntry(ptyId)
    return ptyManager.resize(ptyId, cols, rows)
  })

  ipcMain.handle('pty:kill', (_e, ptyId: string) => {
    windowManager.unroutePty(ptyId)
    return ptyManager.kill(ptyId)
  })

  ipcMain.handle('shell:open-folder', (_e, folderPath: string) => shell.openPath(folderPath))

  ipcMain.handle('shell:open-external', (_e, url: string) => {
    openExternalUrl(url)
  })

  ipcMain.handle('shell:copy-to-clipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('shell:vscode-available', () => vsCodeAvailable)

  ipcMain.handle('git:branch', (_e, cwd: string) => resolveGitBranch(cwd))

  ipcMain.handle('shell:open-vscode', (_e, cwd: string) => {
    shell.openExternal(encodeURI(`vscode://file/${cwd.replace(/\\/g, '/')}`))
  })

  ipcMain.handle('dialog:pick-directory', async (e, title?: string, defaultPath?: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    const result = await dialog.showOpenDialog(senderWin, {
      title: title ?? 'Select Directory',
      properties: ['openDirectory'],
      defaultPath: defaultPath || os.homedir(),
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  const layoutPath = path.join(app.getPath('userData'), 'layout.json')

  ipcMain.handle('layout:load', () => {
    try {
      return JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('layout:save', (_e, tabs: unknown, sidebarWidth: unknown, sidebarOpen: unknown, activeTabId: unknown, sidebarSectionOpen: unknown, sidebarPanelSizes: unknown) => {
    try {
      fs.writeFileSync(layoutPath, JSON.stringify({
        tabs: normalizeTabsForLayout(tabs),
        sidebarWidth,
        sidebarOpen,
        activeTabId,
        sidebarSectionOpen,
        sidebarPanelSizes,
      }))
    } catch (err) {
      console.error('[MultiAgent] layout:save failed:', err)
    }
  })

  ipcMain.handle('sessions:validate', async (_e, agentKind: AgentKind, sessionId: string, cwd: string) => {
    if ((agentKind !== 'claude' && agentKind !== 'codex') || typeof sessionId !== 'string') {
      return { found: false, cwdMatch: false, transcriptPath: null, transcriptCwd: null }
    }
    const scanner = agentKind === 'codex' ? codexScanner : claudeScanner
    const sessions = await scanner.scanAll()
    const match = sessions.find((s) => s.agentKind === agentKind && s.sessionId === sessionId)
    if (!match) return { found: false, cwdMatch: false, transcriptPath: null, transcriptCwd: null }
    const normalizedSaved = normalizePath(cwd)
    const normalizedTranscript = normalizePath(match.cwd)
    return {
      found: true,
      cwdMatch: normalizedSaved === normalizedTranscript,
      transcriptPath: match.transcriptPath,
      transcriptCwd: match.cwd,
    }
  })

  ipcMain.handle('sessions:recover-pending', async (_e, agentKind: AgentKind, cwd: string, startedAt: number) => {
    if ((agentKind !== 'claude' && agentKind !== 'codex') || typeof cwd !== 'string' || typeof startedAt !== 'number') {
      return null
    }
    const scanner = agentKind === 'codex' ? codexScanner : claudeScanner
    const sessions = await scanner.scanAll()
    const normalizedCwd = normalizePath(cwd)
    const matches = sessions
      .filter((session) =>
        session.agentKind === agentKind &&
        normalizePath(session.cwd) === normalizedCwd &&
        session.mtimeMs >= startedAt - 5_000
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (matches.length !== 1) return null
    index.upsert(matches[0])
    return matches[0].sessionId
  })

  ipcMain.handle('mcp:get-status', () => mcpManager.getStatus())

  ipcMain.handle('mcp:get-settings', () => mcpManager.getSettings())

  ipcMain.handle('mcp:save-settings', (_e, settings: McpSettings) => {
    mcpManager.saveSettings(settings)
  })

  ipcMain.handle('mcp:probe-stdio', async (_e, command: string, args: string[], env?: Record<string, string>) => {
    const tools = await probeStdioServer(command, args, env)
    return { tools }
  })

  // --- Multi-window IPC ---

  ipcMain.handle('window:get-id', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.id ?? null
  })

  ipcMain.handle('window:get-init-data', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const data = windowManager.pendingInitData.get(win.id)
    if (data) windowManager.pendingInitData.delete(win.id)
    return data ?? null
  })

  ipcMain.handle('window:get-all-bounds', () => {
    return windowManager.getAllBounds()
  })

  ipcMain.handle('window:minimize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    win.minimize()
  })

  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return false
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
    const maximized = win.isMaximized()
    win.webContents.send('window:maximized-changed', maximized)
    return maximized
  })

  ipcMain.handle('window:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    win.close()
  })

  ipcMain.handle('window:is-maximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })

  ipcMain.handle('window:start-drag', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if ('startSystemMove' in win && typeof win.startSystemMove === 'function') {
      win.startSystemMove()
    }
  })

  ipcMain.handle('window:snap-apply', (e, targetWindowId: number, side: 'left' | 'right' | 'top' | 'bottom') => {
    const fromWin = BrowserWindow.fromWebContents(e.sender)
    if (!fromWin) return
    windowManager.applySnap(fromWin, targetWindowId, side)
  })

  ipcMain.handle('tab:tear-off', async (e, tabJson: string, ptyIds: string[], screenX: number, screenY: number) => {
    const fromWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    const tab = JSON.parse(tabJson) as Tab
    const newWin = windowManager.createDetachedWindow(fromWin, screenX, screenY)
    windowManager.pendingInitData.set(newWin.id, { mode: 'detached', tab, ptyIds })
    windowManager.prepareDetachedTab(newWin.id, [tab.id])
    registerWindowHandlers(newWin)
    return { windowId: newWin.id }
  })

  ipcMain.handle('window:focus-for-tab', (_e, tabId: string) => {
    return windowManager.focusWindowForTab(tabId)
  })

  // Immediate focus relay: detached window clicked a pane → broadcast to all other windows.
  ipcMain.on('pane:focus-changed', (e, windowId: number, tabId: string, paneId: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin) return
    windowManager.broadcastExcept(senderWin.id, 'pane:focus-changed', windowId, tabId, paneId)
  })

  ipcMain.on('focus:target-report', (e, tabId: string, paneId: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin || typeof tabId !== 'string' || typeof paneId !== 'string') return
    windowManager.broadcastAll('focus:target-changed', {
      windowId: senderWin.id,
      tabId,
      paneId,
      version: ++focusTargetVersionSeq,
    })
  })

  ipcMain.handle('window:focus-pane', (_e, tabId: string, paneId: string) => {
    const winId = windowManager.getWindowIdForTab(tabId)
    if (winId === null) return false
    const expectedGeneration = windowManager.getOwnershipGeneration(tabId)
    const win = windowManager.getWindowById(winId)
    if (!win || win.isDestroyed()) return false

    const requestId = `${Date.now()}:${++remoteFocusRequestSeq}`
    let settled = false
    const focusTarget = (): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener('pane:focus-remote-applied', onApplied)
      if (
        windowManager.getWindowIdForTab(tabId) !== winId ||
        windowManager.getOwnershipGeneration(tabId) !== expectedGeneration
      ) return
      const currentWin = windowManager.getWindowById(winId)
      if (!currentWin || currentWin.isDestroyed()) return
      if (currentWin.isMinimized()) currentWin.restore()
      currentWin.focus()
    }
    const onApplied = (event: Electron.IpcMainEvent, ackRequestId: unknown): void => {
      if (ackRequestId !== requestId) return
      const ackWin = BrowserWindow.fromWebContents(event.sender)
      if (!ackWin || ackWin.id !== win.id) return
      focusTarget()
    }

    ipcMain.on('pane:focus-remote-applied', onApplied)
    win.webContents.send('pane:focus-remote', tabId, paneId, requestId)
    setTimeout(focusTarget, 1000)
    return true
  })

  ipcMain.handle('tab:adopt', (e, ptyIds: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    for (const ptyId of ptyIds as string[]) {
      windowManager.routePty(ptyId, win.webContents.id)
    }
    return true
  })

  ipcMain.on('tab:detached-ready', (e, tabId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || typeof tabId !== 'string') return
    windowManager.markDetachedTabReady(win.id, tabId)
  })

  // Live tab state sync: detached window pushes its tab list; we update routing and forward to others.
  ipcMain.on('tab:state-sync', (e, payloadOrWindowId: unknown, tabsJsonArg?: unknown, activeTabIdArg?: unknown) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin) return
    let windowId: number
    let tabsJson: string
    let activeTabId: string | undefined
    let version: number | undefined
    if (typeof payloadOrWindowId === 'object' && payloadOrWindowId !== null) {
      const payload = payloadOrWindowId as { windowId?: unknown; tabs?: unknown; activeTabId?: unknown; version?: unknown }
      if (typeof payload.windowId !== 'number' || !Array.isArray(payload.tabs)) return
      windowId = payload.windowId
      tabsJson = JSON.stringify(payload.tabs)
      activeTabId = typeof payload.activeTabId === 'string' ? payload.activeTabId : undefined
      version = typeof payload.version === 'number' ? payload.version : undefined
    } else {
      if (typeof payloadOrWindowId !== 'number' || typeof tabsJsonArg !== 'string') return
      windowId = payloadOrWindowId
      tabsJson = tabsJsonArg
      activeTabId = typeof activeTabIdArg === 'string' ? activeTabIdArg : undefined
    }
    try {
      const tabs = JSON.parse(tabsJson) as Array<{ id: string }>
      const acceptedIds = windowManager.recordDetachedTabsForWindow(senderWin.id, tabs.map((t) => t.id), version)
      tabsJson = JSON.stringify(tabs.filter((t) => acceptedIds.includes(t.id)))
    } catch { /* ignore malformed */ }
    windowManager.broadcastExcept(senderWin.id, 'tab:state-sync', windowId, tabsJson, activeTabId)
  })

  // Move a pane (with its PTY) to a tab in another window.
  ipcMain.handle('pane:transfer', async (e, payload: PaneTransferPayload) => {
    try {
      const senderWin = BrowserWindow.fromWebContents(e.sender)
      if (!senderWin || !payload?.pane || typeof payload.targetTabId !== 'string') return false
      const targetWindowId = payload.targetWindowId ?? windowManager.getWindowIdForTab(payload.targetTabId) ?? senderWin.id
      if (targetWindowId === null) return false
      const toWin = windowManager.getWindowById(targetWindowId)
      if (!toWin || toWin.isDestroyed()) return false
      const sourceWin = windowManager.getWindowById(payload.sourceWindowId)
      if (!sourceWin || sourceWin.isDestroyed()) return false
      if (payload.sourceWindowId === targetWindowId) {
        sourceWin.webContents.send('pane:move-remote', payload.pane.id, payload.targetTabId)
        return true
      }
      const transferId = `${Date.now()}:${Math.random().toString(36).slice(2)}`
      const committed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          ipcMain.removeListener('pane:received-applied', onApplied)
          resolve(false)
        }, 1000)
        const onApplied = (event: Electron.IpcMainEvent, ackTransferId: unknown): void => {
          if (ackTransferId !== transferId) return
          const ackWin = BrowserWindow.fromWebContents(event.sender)
          if (!ackWin || ackWin.id !== toWin.id) return
          clearTimeout(timer)
          ipcMain.removeListener('pane:received-applied', onApplied)
          resolve(true)
        }
        ipcMain.on('pane:received-applied', onApplied)
        toWin.webContents.send('pane:received', JSON.stringify(payload.pane), payload.targetTabId, transferId)
      })
      if (!committed || toWin.isDestroyed()) {
        // The target optimistically added the pane on pane:received but the transfer never
        // committed (no PTY routing will follow). Tell it to discard the pane so it does not
        // linger as a dead, output-less duplicate. The source still holds its working pane.
        // See specs/atomic-state-audit-followup #2.
        if (!toWin.isDestroyed()) toWin.webContents.send('pane:transfer-rolledback', payload.pane.id)
        return false
      }
      if (payload.pane.ptyId) windowManager.transferPty(payload.pane.ptyId, toWin)
      sourceWin.webContents.send('pane:remove-remote', payload.pane.id)
      return true
    } catch {
      return false
    }
  })

  // Pull a detached tab back to the requesting window.
  ipcMain.handle('tab:bring-home', (e, tabId: string) => {
    const targetWindowId = windowManager.getWindowIdForTab(tabId)
    if (targetWindowId === null) return false
    const sourceWin = windowManager.getWindowById(targetWindowId)
    if (!sourceWin || sourceWin.isDestroyed()) return false
    // Unrecord before sending release so stale syncs and unregister() don't re-process this tab.
    windowManager.unrecordTab(tabId)
    sourceWin.webContents.send('tab:release', tabId)
    const callerWin = BrowserWindow.fromWebContents(e.sender)
    callerWin?.webContents.send('tab:return', tabId)
    return true
  })

  // Reattach: a detached window moves one of its own tabs back to the primary window.
  // Mirror of tab:bring-home, but the SENDER is the source (the detached window) and the
  // destination is the primary window. Unrecording first means the detached window's
  // close-time return (if this empties it) and any in-flight sync won't duplicate the tab.
  ipcMain.handle('tab:reattach-home', (e, tabId: string) => {
    const callerWin = BrowserWindow.fromWebContents(e.sender)
    if (!callerWin) return false
    const primaryWin = windowManager.getPrimaryWindow()
    if (!primaryWin || primaryWin.isDestroyed() || primaryWin.id === callerWin.id) return false
    windowManager.unrecordTab(tabId)
    callerWin.webContents.send('tab:release', tabId)
    primaryWin.webContents.send('tab:return', tabId)
    return true
  })

  ipcMain.handle('tab:absorb', async (e, tabJson: string, ptyIds: string[], sourceWindowId: number) => {
    const toWin = BrowserWindow.fromWebContents(e.sender)
    if (!toWin) return false
    let tab: Tab
    try {
      tab = JSON.parse(tabJson) as Tab
    } catch {
      return false
    }

    const sourceWin = windowManager.getWindowById(sourceWindowId)
    if (!sourceWin || sourceWin.isDestroyed()) return false

    const releaseId = `${Date.now()}:${++tabReleaseSeq}`
    const released = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('tab:release-applied', onApplied)
        resolve(false)
      }, 1000)
      const onApplied = (event: Electron.IpcMainEvent, ackReleaseId: unknown): void => {
        if (ackReleaseId !== releaseId) return
        const ackWin = BrowserWindow.fromWebContents(event.sender)
        if (!ackWin || ackWin.id !== sourceWin.id) return
        clearTimeout(timer)
        ipcMain.removeListener('tab:release-applied', onApplied)
        resolve(true)
      }
      ipcMain.on('tab:release-applied', onApplied)
      sourceWin.webContents.send(
        'tab:release',
        tab.id,
        windowManager.isDetachedWindow(toWin.id) ? toWin.id : undefined,
        releaseId,
      )
    })
    // On failure the source has NOT yet touched its copy of the tab (it only acked the
    // release; finalize is deferred to tab:absorb-committed below), so there is nothing to
    // roll back here — the absorber discards its optimistic copy on the falsy result.
    if (!released || toWin.isDestroyed()) return false

    windowManager.unrecordTab(tab.id)
    if (windowManager.isDetachedWindow(toWin.id)) {
      windowManager.recordDetachedTab(toWin.id, [tab.id])
    }
    for (const ptyId of ptyIds as string[]) {
      windowManager.transferPty(ptyId, toWin)
    }
    // PTYs are now routed to the absorbing window; only now is it safe for the source to
    // drop/detach its copy. Without this commit the source either lost the tab before the
    // transfer was confirmed (data loss) or never released it at all.
    if (!sourceWin.isDestroyed()) {
      sourceWin.webContents.send(
        'tab:absorb-committed',
        tab.id,
        windowManager.isDetachedWindow(toWin.id) ? toWin.id : undefined,
      )
    }
    return true
  })

  // Collect a response from a single renderer window within a timeout.
  // Sends `sendChannel` with a unique requestId; expects the renderer to reply via `listenChannel`
  // with (requestId, data). Returns null on timeout or if the window is already destroyed.
  function requestWindowResponse<T>(
    win: BrowserWindow,
    sendChannel: string,
    listenChannel: string,
    timeoutMs: number
  ): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      if (win.isDestroyed()) { resolve(null); return }
      const requestId = `shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`
      let settled = false
      const done = (value: T | null): void => {
        if (settled) return
        settled = true
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        ipcMain.removeListener(listenChannel, handler)
        resolve(value)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (event: any, rid: unknown, data: unknown): void => {
        if (rid !== requestId) return
        if (BrowserWindow.fromWebContents(event.sender)?.id !== win.id) return
        clearTimeout(timer)
        done(data as T)
      }
      ipcMain.on(listenChannel, handler)
      win.webContents.send(sendChannel, requestId)
    })
  }

  // Collect authoritative state from the primary and all detached windows, merge, and write
  // layout.json. Called on primary-window 'close' before destruction so the latest detached
  // window state is never lost behind the 300ms sync debounce.
  async function performShutdownSave(): Promise<void> {
    const COLLECT_TIMEOUT_MS = 1000
    const primaryWin = windowManager.getPrimaryWindow()
    if (!primaryWin || primaryWin.isDestroyed()) return

    type PrimaryState = {
      tabs: unknown[]
      sidebarWidth: unknown
      sidebarOpen: unknown
      activeTabId: unknown
      sidebarSectionOpen: unknown
      sidebarPanelSizes: unknown
    }
    type DetachedSnapshot = { windowId: number; tabs: unknown[]; activeTabId?: string }

    const detachedWins = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed() && w.id !== primaryWin.id && windowManager.isDetachedWindow(w.id)
    )

    const [primaryState, ...detachedResults] = await Promise.all([
      requestWindowResponse<PrimaryState>(primaryWin, 'layout:request-state', 'layout:state-response', COLLECT_TIMEOUT_MS),
      ...detachedWins.map((w) =>
        requestWindowResponse<DetachedSnapshot>(w, 'layout:collect-detached-state', 'layout:detached-state-response', COLLECT_TIMEOUT_MS)
      ),
    ])

    if (!primaryState) {
      console.warn('[MultiAgent] performShutdownSave: primary did not respond, skipping final save')
      return
    }

    // Merge: start with primary's tab list (which may have stale detached entries),
    // then overlay fresh snapshots from each detached window.
    let mergedTabs: unknown[] = Array.isArray(primaryState.tabs) ? [...primaryState.tabs] : []
    for (const snap of detachedResults) {
      if (!snap || !Array.isArray(snap.tabs)) continue
      const ids = new Set((snap.tabs as Record<string, unknown>[]).map((t) => t['id']))
      mergedTabs = mergedTabs.filter((t) => !ids.has((t as Record<string, unknown>)['id']))
      mergedTabs.push(...snap.tabs)
    }

    try {
      fs.writeFileSync(layoutPath, JSON.stringify({
        tabs: normalizeTabsForLayout(mergedTabs),
        sidebarWidth: primaryState.sidebarWidth,
        sidebarOpen: primaryState.sidebarOpen,
        activeTabId: primaryState.activeTabId,
        sidebarSectionOpen: primaryState.sidebarSectionOpen,
        sidebarPanelSizes: primaryState.sidebarPanelSizes,
      }))
    } catch (err) {
      console.error('[MultiAgent] performShutdownSave: layout write failed:', err)
    }
  }

  return {
    cleanup: () => {
      clearInterval(contentTimer)
      for (const entry of coalesceBuffer.values()) clearImmediate(entry.immediate)
      coalesceBuffer.clear()
      index.close()
      ptyManager.destroy()
    },
    registerWindowHandlers,
    performShutdownSave,
  }
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeTabsForLayout(tabs: unknown): unknown {
  if (!Array.isArray(tabs)) return tabs
  return tabs.map((tab) => {
    if (!tab || typeof tab !== 'object') return tab
    return { ...(tab as Record<string, unknown>), detached: false }
  })
}
