import { ipcMain, BrowserWindow, shell, clipboard, app, dialog } from 'electron'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { SessionIndex } from '../sessions/SessionIndex'
import { createSessionPoller } from '../sessions/sessionPoll'
import { TranscriptScanner } from '../sessions/TranscriptScanner'
import { CodexSessionScanner } from '../sessions/CodexSessionScanner'
import { DeepSearcher } from '../sessions/DeepSearcher'
import { SessionSpawner, setAgentProviderSettings } from '../sessions/SessionSpawner'
import { PtyManager } from '../pty/PtyManager'
import { openExternalUrl } from '../external'
import { getRecentDirs, addRecentDir } from '../recentDirs'
import { mcpManager } from '../mcp/McpManager'
import { probeStdioServer } from '../mcp/probeStdio'
import { windowManager } from '../window/WindowManager'
import type { AgentKind, AgentProviderSettings, CwdRepairMapping, McpSettings, SessionSearchRequest } from '../../shared/types'
import type { ScannedSession } from '../sessions/TranscriptScanner'
import { GitBranchWatcher } from '../git/GitBranchWatcher'
import { writeJsonAtomic } from '../atomicJson'
import { defaultAgentProviderSettings, sanitizeAgentProviderSettings } from './agentProviderSettings'
import { createIpcRegistrar } from './ipcRegistrar'
import { createAckProtocol } from './ackProtocol'
import { createPtyOutputRouter } from './ptyOutputRouter'
import { registerTransferHandlers } from './transferHandlers'
import { createLayoutStore } from './layoutStore'
import { killPtyIfAllowed, senderMayControlPty as senderMayControlOwnedPty } from './ptyControl'

// PTY output is relayed straight to xterm (seq=0 direct write) for both shell and
// agent panes — no coalescing, no ack, no backpressure. node-pty + xterm handle
// the volume directly, exactly like a normal terminal. PTY_ROUTE_RETRY_MS is the
// only timer left: it covers the brief window where a pane has no routable window
// (e.g. mid cross-window move), buffering output until a window is available.
export async function registerIpcHandlers(mainWindow: BrowserWindow): Promise<{
  cleanup: () => Promise<void>
  registerWindowHandlers: (win: BrowserWindow) => void
  performShutdownSave: () => Promise<void>
}> {
  const vsCodeAvailable = promisify(execFile)('code', ['--version'], { shell: true, timeout: 3000 })
    .then(() => true, () => false)
  const registrar = createIpcRegistrar(ipcMain)
  const layoutStore = createLayoutStore({
    layoutPath: path.join(app.getPath('userData'), 'layout.json'),
    windowManager,
  })
  layoutStore.registerHandlers(registrar)
  const ack = createAckProtocol({
    on: (channel, listener) => ipcMain.on(channel, listener),
    removeListener: (channel, listener) => ipcMain.removeListener(channel, listener),
    senderWindowId: (event) => BrowserWindow.fromWebContents((event as Electron.IpcMainEvent).sender)?.id,
  })
  const index = new SessionIndex()
  const claudeScanner = new TranscriptScanner()
  const codexScanner = new CodexSessionScanner()
  const deepSearcher = new DeepSearcher(claudeScanner, codexScanner, index)
  const ptyManager = new PtyManager()
  const spawner = new SessionSpawner(ptyManager, mainWindow)
  const registeredWindowHandlers = new WeakSet<BrowserWindow>()
  let cleanupPromise: Promise<void> | null = null
  const gitBranchWatcher = new GitBranchWatcher((cwdKeys, branch) => {
    windowManager.broadcastAll('git:branch-updated', cwdKeys, branch)
  })
  const ptyOutputRouter = createPtyOutputRouter({
    ptyManager,
    windowManager,
    onCommandComplete: (cwd) => { void gitBranchWatcher.retryUnresolvedCwd(cwd) },
  })

  async function scanAllSessions() {
    const [claudeSessions, codexSessions] = await Promise.all([
      claudeScanner.scanAll(),
      codexScanner.scanAll(),
    ])
    return [...claudeSessions, ...codexSessions]
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
  registerTransferHandlers({
    registrar,
    ack,
    windowManager,
    getPrimaryWindow: () => windowManager.getPrimaryWindow(),
    flushDirectOutput: (ptyId) => ptyOutputRouter.flushDirectOutput(ptyId),
    registerWindowHandlers,
  })

  // Initial full scan on startup.
  const sessionPoller = createSessionPoller({
    scanAll: scanAllSessions,
    index,
    broadcast: (sessions) => windowManager.broadcastAll('sessions:updated', sessions),
  })
  sessionPoller.poll(true).catch((err) => {
    console.error('[MultiAgent] Session scan failed:', err)
    windowManager.broadcastAll('sessions:updated', [])
  })

  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })

  const contentTimer = setInterval(() => {
    void sessionPoller.poll().catch((err) => console.error('[MultiAgent] pollSessions error:', err))
  }, 5000)

  // --- IPC handlers ---

  registrar.handle('sessions:search', (_e, query: string) => {
    try {
      return index.search(query)
    } catch (err) {
      // search() is expected to fall back to LIKE on FTS errors (spec 036, item 7).
      // This final guard ensures no future regression can reject the invoke —
      // summary search degrades to an empty list rather than throwing.
      console.error('[sessions:search] failed:', err)
      return []
    }
  })

  registrar.handle('sessions:search-deep', async (_e, request: SessionSearchRequest) => {
    const allSessions = index.getAll()
    return deepSearcher.search(request, allSessions)
  })

  registrar.handle('sessions:delete', (_e, agentKind, sessionId: string) => index.delete(agentKind, sessionId))

  registrar.handle('sessions:repair-cwd', (_e, oldCwd: string, newCwd: string) => {
    if (typeof oldCwd !== 'string' || typeof newCwd !== 'string') {
      return { ok: false, sessions: [], error: 'Invalid directory repair request' }
    }
    const trimmedOld = oldCwd.trim()
    const trimmedNew = newCwd.trim()
    if (!trimmedOld || !trimmedNew) {
      return { ok: false, sessions: [], error: 'Choose a directory before repairing' }
    }
    try {
      if (!fs.existsSync(trimmedNew) || !fs.statSync(trimmedNew).isDirectory()) {
        return { ok: false, sessions: [], error: 'The selected directory does not exist' }
      }
    } catch {
      return { ok: false, sessions: [], error: 'The selected directory could not be read' }
    }
    const mapping = { oldCwd: path.resolve(trimmedOld), newCwd: path.resolve(trimmedNew) } satisfies CwdRepairMapping
    const layoutRepair = layoutStore.repairLayoutCwds(mapping)
    const updated = index.repairCwd(mapping.oldCwd, mapping.newCwd)
    if (updated.length > 0) {
      const all = index.getAll()
      windowManager.broadcastAll('sessions:updated', all)
    }
    if (layoutRepair.changed || updated.length > 0) {
      windowManager.broadcastAll('layout:cwd-repaired', mapping)
    }
    return {
      ok: true,
      sessions: updated,
      mapping,
      layoutUpdated: layoutRepair.changed,
      layoutAffectedCount: layoutRepair.count,
    }
  })

  registrar.handle('sessions:refresh', async () => {
    await sessionPoller.poll(true)
    return index.getAll()
  })

  registrar.handle('sessions:latest-for-cwd', async (_e, agentKind, cwd: string) => {
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

  registrar.handle('session:new', async (e, agentKind, cwd: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    const result = await spawner.spawnNew(agentKind, cwd, senderWin)
    windowManager.routePty(result.ptyId, senderWin.webContents.id)
    ptyOutputRouter.flushDirectOutput(result.ptyId)
    return result
  })

  registrar.handle('session:resume', async (e, agentKind, sessionId: string, cwd: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    const result = await spawner.spawnResume(agentKind, sessionId, cwd, senderWin)
    windowManager.routePty(result.ptyId, senderWin.webContents.id)
    ptyOutputRouter.flushDirectOutput(result.ptyId)
    return result
  })

  registrar.handle('pty:create', (e, cwd: string, cols?: number, rows?: number) => {
    const initialSize = {
      cols: typeof cols === 'number' && cols > 0 ? Math.floor(cols) : 80,
      rows: typeof rows === 'number' && rows > 0 ? Math.floor(rows) : 24,
    }
    const ptyId = ptyManager.createShell(cwd, initialSize)
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    windowManager.routePty(ptyId, senderWin.webContents.id)
    ptyOutputRouter.flushDirectOutput(ptyId)
    return { ptyId }
  })

  registrar.handle('pty:get-ready', (e, ptyId: string) => {
    if (!windowManager.ownsPty(ptyId, e.sender.id)) return null
    const event = ptyManager.getReadyEvent(ptyId)
    return event
      ? { pid: event.pid, cwd: event.cwd, windowsPty: event.windowsPty }
      : null
  })

  function senderMayControlPty(ptyId: string, senderId: number): boolean {
    return senderMayControlOwnedPty(windowManager.getPtyOwner(ptyId), senderId)
  }

  registrar.on('pty:write', (e, ptyId: string, data: string) => {
    if (!senderMayControlPty(ptyId, e.sender.id)) return
    spawner.notePtyWrite(ptyId, data)
    ptyManager.write(ptyId, data)
  })

  // Destination terminals may fit before their transfer ack reroutes the PTY;
  // keep resize unguarded so that first fit is never dropped.
  registrar.on('pty:resize', (_e, ptyId: string, cols: number, rows: number) => {
    ptyManager.resize(ptyId, cols, rows)
  })

  registrar.handle('pty:kill', (e, ptyId: string) => {
    return killPtyIfAllowed({
      getOwner: (id) => windowManager.getPtyOwner(id),
      unroute: (id) => windowManager.unroutePty(id),
      release: (id) => ptyOutputRouter.releasePty(id),
      kill: (id) => ptyManager.kill(id),
    }, ptyId, e.sender.id)
  })

  registrar.handle('shell:open-folder', (_e, folderPath: string) => shell.openPath(folderPath))

  registrar.handle('shell:open-external', (_e, url: string) => {
    openExternalUrl(url)
  })

  registrar.handle('shell:copy-to-clipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })

  registrar.handle('shell:vscode-available', () => vsCodeAvailable)

  registrar.handle('git:branch', (_e, cwd: string) => gitBranchWatcher.watchCwd(cwd))
  registrar.handle('git:unwatch-branch', (_e, cwd: string) => gitBranchWatcher.unwatchCwd(cwd))

  registrar.handle('shell:open-vscode', (_e, cwd: string) => {
    shell.openExternal(encodeURI(`vscode://file/${cwd.replace(/\\/g, '/')}`))
  })

  registrar.handle('dirs:recent-get', () => getRecentDirs())
  registrar.handle('dirs:recent-add', (_e, dir: string) => addRecentDir(dir))

  registrar.handle('dialog:pick-directory', async (e, title?: string, defaultPath?: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    const result = await dialog.showOpenDialog(senderWin, {
      title: title ?? 'Select Directory',
      properties: ['openDirectory'],
      defaultPath: defaultPath || os.homedir(),
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  registrar.handle('sessions:validate', async (_e, agentKind: AgentKind, sessionId: string, cwd: string) => {
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

  registrar.handle('sessions:recover-pending', async (_e, agentKind: AgentKind, cwd: string, startedAt: number) => {
    if ((agentKind !== 'claude' && agentKind !== 'codex') || typeof cwd !== 'string' || typeof startedAt !== 'number') {
      return null
    }
    const scanner = agentKind === 'codex' ? codexScanner : claudeScanner
    const sessions = await scanner.scanAll()
    const normalizedCwd = normalizePath(cwd)

    // Filter by cwd first, then stat each file to get birthtime (creation time).
    // Using birthtime prevents false matches from old sessions in the same directory
    // that have recent mtimes due to ongoing activity. The 2-minute upper bound
    // excludes files created after the app restarted (a new unrelated session).
    const RECOVERY_GRACE_MS = 5_000
    const RECOVERY_WINDOW_MS = 120_000
    const cwdSessions = sessions.filter(
      (s) => s.agentKind === agentKind && normalizePath(s.cwd) === normalizedCwd
    )
    const candidates: ScannedSession[] = []
    for (const session of cwdSessions) {
      try {
        const stat = await fs.promises.stat(session.transcriptPath)
        // Prefer birthtime; fall back to mtime when birthtime equals mtime (some
        // filesystems set both identically on creation) or is zero/unavailable.
        const createdAt =
          stat.birthtimeMs > 0 && stat.birthtimeMs < stat.mtimeMs
            ? stat.birthtimeMs
            : stat.mtimeMs
        if (createdAt >= startedAt - RECOVERY_GRACE_MS && createdAt <= startedAt + RECOVERY_WINDOW_MS) {
          candidates.push(session)
        }
      } catch {
        // skip files that can't be stat'd
      }
    }

    if (candidates.length !== 1) return null
    index.upsert(candidates[0])
    return candidates[0].sessionId
  })

  registrar.handle('mcp:get-status', () => mcpManager.getStatus())

  registrar.handle('mcp:get-settings', () => mcpManager.getSettings())

  registrar.handle('mcp:save-settings', (_e, settings: McpSettings) => {
    mcpManager.saveSettings(settings)
  })

  registrar.handle('mcp:probe-stdio', async (_e, command: string, args: string[], env?: Record<string, string>) => {
    const tools = await probeStdioServer(command, args, env)
    return { tools }
  })

  // --- Agent provider settings ---
  const AGENT_PROVIDER_FILE = path.join(app.getPath('userData'), 'agent-provider-settings.json')

  function loadAgentProviderSettings(): AgentProviderSettings {
    try {
      const raw = fs.readFileSync(AGENT_PROVIDER_FILE, 'utf-8')
      return sanitizeAgentProviderSettings(JSON.parse(raw))
    } catch {
      return defaultAgentProviderSettings()
    }
  }

  // Load and apply on startup
  setAgentProviderSettings(loadAgentProviderSettings())

  registrar.handle('settings:get-agent-providers', () => loadAgentProviderSettings())

  registrar.handle('settings:save-agent-providers', (_e, settings: AgentProviderSettings) => {
    // Sanitize before persisting/applying so a buggy or hostile renderer payload
    // cannot poison the file or crash agent spawns.
    const sanitized = sanitizeAgentProviderSettings(settings)
    writeJsonAtomic(AGENT_PROVIDER_FILE, sanitized, 2)
    setAgentProviderSettings(sanitized)
  })

  // --- GPU feature status ---
  registrar.handle('gpu:feature-status', () => {
    const status = app.getGPUFeatureStatus()
    const featureStatus = status as unknown as Record<string, string>
    const softwareValues = new Set(['software_only', 'disabled_software', 'unavailable_software'])
    const softwareOnly = Object.values(featureStatus).some((v) => softwareValues.has(v))
    return { softwareOnly, featureStatus }
  })

  // --- Multi-window IPC ---

  registrar.handle('window:get-id', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.id ?? null
  })

  registrar.handle('window:get-init-data', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const data = windowManager.pendingInitData.get(win.id)
    if (data) windowManager.pendingInitData.delete(win.id)
    return data ?? null
  })

  registrar.handle('window:get-all-bounds', () => {
    return windowManager.getAllBounds()
  })

  registrar.handle('window:minimize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    win.minimize()
  })

  registrar.handle('window:toggle-maximize', (e) => {
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

  registrar.handle('window:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    win.close()
  })

  registrar.handle('window:is-maximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })

  registrar.handle('window:start-drag', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if ('startSystemMove' in win && typeof win.startSystemMove === 'function') {
      win.startSystemMove()
    }
  })

  registrar.handle('window:snap-apply', (e, targetWindowId: number, side: 'left' | 'right' | 'top' | 'bottom') => {
    const fromWin = BrowserWindow.fromWebContents(e.sender)
    if (!fromWin) return
    windowManager.applySnap(fromWin, targetWindowId, side)
  })

  return {
    cleanup: () => {
      if (cleanupPromise) return cleanupPromise
      registrar.disposeAll()
      clearInterval(contentTimer)
      ptyOutputRouter.dispose()
      index.close()
      spawner.dispose()
      cleanupPromise = Promise.all([
        gitBranchWatcher.dispose(),
        ptyManager.destroy(),
      ]).then(() => undefined)
      return cleanupPromise
    },
    registerWindowHandlers,
    performShutdownSave: layoutStore.performShutdownSave,
  }
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
