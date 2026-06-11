import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { BrowserViewManager } from './browser/BrowserViewManager'
import { mcpManager } from './mcp/McpManager'
import { openExternalUrl } from './external'

interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

const DEFAULTS: WindowState = { x: 0, y: 0, width: 1280, height: 800, isMaximized: false }

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), 'utf-8')
    const saved = JSON.parse(raw) as WindowState
    // Verify the saved position is still on a connected display
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.bounds
      return saved.x < b.x + b.width && saved.x + saved.width > b.x &&
             saved.y < b.y + b.height && saved.y + saved.height > b.y
    })
    return visible ? saved : DEFAULTS
  } catch {
    return DEFAULTS
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
    writeFileSync(windowStatePath(), JSON.stringify(next))
  } catch { /* ignore write errors */ }
}

// Keep references so resources can be cleaned up on quit
let cleanupFn: (() => void) | null = null
let browserViewManager: BrowserViewManager | null = null

async function createWindow(): Promise<void> {
  const state = loadWindowState()

  const mainWindow = new BrowserWindow({
    x: state.x || undefined,
    y: state.y || undefined,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    // Use standard frame on Windows, frameless on macOS
    frame: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

  mainWindow.on('close', () => saveWindowState(mainWindow))
  mainWindow.on('closed', () => app.quit())

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
  const cleanup = await registerIpcHandlers(mainWindow)
  cleanupFn = cleanup ?? null

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
}

app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.multiagent.app')

  // Default open or close DevTools by F12 in dev and ignore CommandOrControl + R in production
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
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

app.on('before-quit', () => {
  cleanupFn?.()
  mcpManager.cleanup()
  browserViewManager?.destroy()
})
