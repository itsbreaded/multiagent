import { ipcMain, BrowserWindow, shell, clipboard } from 'electron'
import * as path from 'path'
import * as os from 'os'
import { SessionIndex } from '../sessions/SessionIndex'
import { TranscriptScanner } from '../sessions/TranscriptScanner'
import { LiveSessionWatcher } from '../sessions/LiveSessionWatcher'
import { SessionSpawner } from '../sessions/SessionSpawner'
import { PtyManager } from '../pty/PtyManager'
import { defaultShell } from '../pty/shell'

export async function registerIpcHandlers(mainWindow: BrowserWindow): Promise<() => void> {
  const index = new SessionIndex()
  const scanner = new TranscriptScanner()
  const ptyManager = new PtyManager()
  const watcher = new LiveSessionWatcher(index)
  const spawner = new SessionSpawner(ptyManager, watcher)

  // Send current index state as soon as the renderer finishes loading.
  // This clears the 'loading' flag even before the scan completes, avoiding
  // a race where the scan finishes before the renderer has subscribed.
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('sessions:updated', index.getAll())
  })

  // Scan all transcripts and push the results when done
  scanner.scanAll().then((sessions) => {
    sessions.forEach((s) => {
      try { index.upsert(s) } catch { /* skip malformed entries */ }
    })
    mainWindow.webContents.send('sessions:updated', index.getAll())
  }).catch((err) => {
    console.error('[MultiAgent] Session scan failed:', err)
    mainWindow.webContents.send('sessions:updated', [])
  })

  // Watch transcript directory for changes
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const { watch } = await import('chokidar')
  const transcriptWatcher = watch(path.join(projectsDir, '**', '*.jsonl'), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  })

  transcriptWatcher.on('add', async (filePath) => {
    const session = await scanner.scanFile(filePath)
    if (session) {
      index.upsert(session)
      mainWindow.webContents.send('sessions:updated', index.getAll())
    }
  })

  transcriptWatcher.on('change', async (filePath) => {
    const session = await scanner.scanFile(filePath)
    if (session) {
      index.upsert(session)
      mainWindow.webContents.send('sessions:updated', index.getAll())
    }
  })

  // Watch live sessions
  watcher.start()
  watcher.on('change', () => {
    mainWindow.webContents.send('sessions:updated', index.getAll())
  })

  // PTY data -> renderer
  ptyManager.on('data', (ptyId: string, data: string) => {
    mainWindow.webContents.send('pty:data', ptyId, data)
  })

  // Show exit code in the terminal when a process exits non-zero — helps diagnose
  // silent crashes (e.g. claude exiting immediately with no output).
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
    ptyId: ptyManager.createDeferred(cwd, [defaultShell()])
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

  // Stubbed until LayoutPersistence is implemented
  ipcMain.handle('layout:load', () => null)
  ipcMain.handle('layout:save', () => {})

  // Return cleanup function so the caller can close the DB on quit
  return () => {
    transcriptWatcher.close()
    watcher.stop()
    index.close()
    ptyManager.destroy()
  }
}
