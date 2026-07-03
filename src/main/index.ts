import { app, BrowserWindow, screen } from 'electron'
import './e2eIsolation'
import { join } from 'path'
import { readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { initUpdater } from './updater'
import { BrowserViewManager } from './browser/BrowserViewManager'
import { mcpManager } from './mcp/McpManager'
import { openExternalUrl } from './external'
import { windowManager } from './window/WindowManager'
import { writeJsonAtomic } from './atomicJson'
import { coerceWindowState, DEFAULT_WINDOW_STATE, type WindowState } from './windowState'

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), 'utf-8')
    const saved = coerceWindowState(JSON.parse(raw))
    // Verify the saved position is still on a connected display
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.bounds
      return saved.x < b.x + b.width && saved.x + saved.width > b.x &&
             saved.y < b.y + b.height && saved.y + saved.height > b.y
    })
    return visible ? saved : DEFAULT_WINDOW_STATE
  } catch {
    return DEFAULT_WINDOW_STATE
  }
}

function saveWindowState(win: BrowserWindow): void {
  const isMaximized = win.isMaximized()
  const bounds = isMaximized ? undefined : win.getBounds()
  try {
    const current = loadWindowState()
    const next: WindowState = {
      x: bounds?.x ?? current.x,
      y: bounds?.y ?? current.y,
      width: bounds?.width ?? current.width,
      height: bounds?.height ?? current.height,
      isMaximized,
    }
    writeJsonAtomic(windowStatePath(), next)
  } catch { /* ignore write errors */ }
}

// Keep references so resources can be cleaned up on quit
let cleanupFn: (() => Promise<void>) | null = null
let browserViewManager: BrowserViewManager | null = null
// Set by registerIpcHandlers; called during primary-window shutdown to flush detached state.
let performShutdownSaveFn: (() => Promise<void>) | null = null

async function createWindow(): Promise<void> {
  const state = loadWindowState()

  const mainWindow = new BrowserWindow({
    x: state.x || undefined,
    y: state.y || undefined,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32'
      ? { color: '#111315', symbolColor: '#c9cdd1', height: 42 }
      : false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (state.isMaximized) mainWindow.maximize()
    mainWindow.show()
  })

  let isShutdownSaveComplete = false
  mainWindow.on('close', async (event) => {
    saveWindowState(mainWindow)
    // On the first close, do a final authoritative layout save that flushes the latest
    // detached-window state before the debounce could have written it. We prevent the
    // default close, await the save (with an internal timeout), then re-close. On the
    // second pass isShutdownSaveComplete is true, so we allow the close through.
    if (!isShutdownSaveComplete && performShutdownSaveFn) {
      event.preventDefault()
      isShutdownSaveComplete = true
      try {
        await performShutdownSaveFn()
      } finally {
        mainWindow.close()
      }
    }
  })
  mainWindow.on('closed', () => {
    // Close all detached windows so PTYs and timers are cleaned up promptly.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.close()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalUrl(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url === mainWindow.webContents.getURL()) return
      event.preventDefault()
      openExternalUrl(url)
    })
  })

  // Wire IPC handlers (sessions, PTY, shell, layout)
  const { cleanup, registerWindowHandlers, performShutdownSave } = await registerIpcHandlers(mainWindow)
  cleanupFn = cleanup ?? null
  performShutdownSaveFn = performShutdownSave

  // Configure WindowManager so it can create detached windows with the correct preload/renderer.
  const rendererUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : null
  windowManager.configure(
    join(__dirname, '../preload/index.js'),
    rendererUrl,
    rendererUrl ? null : join(__dirname, '../renderer/index.html'),
    registerWindowHandlers
  )
  windowManager.startMoveTracking(mainWindow)

  // Set up browser window (MCP-controlled separate window)
  browserViewManager = new BrowserViewManager()
  browserViewManager.initialize()

  mcpManager.start(browserViewManager).then(() => {
    console.log(`[MultiAgent] Browser MCP server listening on port ${mcpManager.getStatus().port}`)
  }).catch((err) => {
    console.error('[MultiAgent] Browser MCP server failed to start:', err)
  })

  // Load renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  initUpdater(mainWindow)
}

const gotTheLock = process.env.MULTIAGENT_ALLOW_MULTI_INSTANCE ? true : app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.multiagent.app')

    // F12 opens DevTools in both dev and packaged builds
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      window.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12') {
          window.webContents.toggleDevTools()
          event.preventDefault()
        }
      })
    })

    await createWindow()

    app.on('activate', function () {
      // On macOS re-create a window when dock icon is clicked and no windows are open
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Quit when all windows are closed, except on macOS
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  let shutdownComplete = false
  let shutdownPromise: Promise<void> | null = null
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownPromise) return
    try { mcpManager.cleanup() } catch (error) { console.error('[MultiAgent] MCP cleanup failed:', error) }
    try { browserViewManager?.destroy() } catch (error) { console.error('[MultiAgent] browser cleanup failed:', error) }
    shutdownPromise = (cleanupFn?.() ?? Promise.resolve())
      .catch((error) => console.error('[MultiAgent] shutdown cleanup failed:', error))
      .then(() => {
        shutdownComplete = true
        app.quit()
      })
  })
}
