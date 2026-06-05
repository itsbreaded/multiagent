import { ipcMain, BrowserWindow, shell, clipboard, app } from 'electron'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { SessionIndex } from '../sessions/SessionIndex'
import { TranscriptScanner } from '../sessions/TranscriptScanner'
import { SessionSpawner } from '../sessions/SessionSpawner'
import { PtyManager } from '../pty/PtyManager'
import { defaultShell } from '../pty/shell'

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

export async function registerIpcHandlers(mainWindow: BrowserWindow): Promise<() => void> {
  const index = new SessionIndex()
  const scanner = new TranscriptScanner()
  const ptyManager = new PtyManager()
  const spawner = new SessionSpawner(ptyManager, mainWindow)

  // Send current index state as soon as the renderer finishes loading.
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('sessions:updated', index.getAll())
  })

  // Initial full scan on startup.
  scanner.scanAll().then((sessions) => {
    sessions.forEach((s) => {
      try { index.upsert(s) } catch { /* skip malformed entries */ }
    })
    mainWindow.webContents.send('sessions:updated', index.getAll())
  }).catch((err) => {
    console.error('[MultiAgent] Session scan failed:', err)
    mainWindow.webContents.send('sessions:updated', [])
  })

  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })

  let lastSessionsJson = ''

  async function pollSessions(): Promise<void> {
    try {
      const sessions = await scanner.scanAll()
      for (const session of sessions) {
        index.upsert(session)
      }
      const all = index.getAll()
      const json = JSON.stringify(all)
      if (json !== lastSessionsJson) {
        lastSessionsJson = json
        mainWindow.webContents.send('sessions:updated', all)
      }
    } catch (err) {
      console.error('[MultiAgent] pollSessions error:', err)
    }
  }

  const contentTimer = setInterval(() => { void pollSessions() }, 5000)

  // PTY data -> renderer
  ptyManager.on('data', (ptyId: string, data: string) => {
    mainWindow.webContents.send('pty:data', ptyId, data)
    const cwd = parseOsc7(data)
    if (cwd) mainWindow.webContents.send('pty:cwd', ptyId, cwd)
  })

  ptyManager.on('exit', (ptyId: string, exitCode: number) => {
    if (exitCode !== 0) {
      const msg = `\r\n\x1b[33m[process exited with code ${exitCode}]\x1b[0m\r\n`
      mainWindow.webContents.send('pty:data', ptyId, msg)
    }
  })

  // --- IPC handlers ---

  ipcMain.handle('sessions:search', (_e, query: string) => index.search(query))

  ipcMain.handle('sessions:delete', (_e, sessionId: string) => index.delete(sessionId))

  ipcMain.handle('session:new', (_e, cwd: string) => spawner.spawnNew(cwd))

  ipcMain.handle('session:resume', (_e, sessionId: string, cwd: string) =>
    spawner.spawnResume(sessionId, cwd)
  )

  ipcMain.handle('pty:create', (_e, cwd: string) => ({
    ptyId: ptyManager.createShell(cwd)
  }))

  ipcMain.handle('pty:write', (_e, ptyId: string, data: string) => ptyManager.write(ptyId, data))

  ipcMain.handle('pty:resize', (_e, ptyId: string, cols: number, rows: number) =>
    ptyManager.resize(ptyId, cols, rows)
  )

  ipcMain.handle('pty:kill', (_e, ptyId: string) => ptyManager.kill(ptyId))

  ipcMain.handle('shell:open-folder', (_e, folderPath: string) => shell.openPath(folderPath))

  ipcMain.handle('shell:copy-to-clipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })

  const layoutPath = path.join(app.getPath('userData'), 'layout.json')

  ipcMain.handle('layout:load', () => {
    try {
      return JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('layout:save', (_e, tabs: unknown, sidebarWidth: unknown, sidebarOpen: unknown) => {
    try {
      fs.writeFileSync(layoutPath, JSON.stringify({ tabs, sidebarWidth, sidebarOpen }))
    } catch (err) {
      console.error('[MultiAgent] layout:save failed:', err)
    }
  })

  return () => {
    clearInterval(contentTimer)
    index.close()
    ptyManager.destroy()
  }
}
