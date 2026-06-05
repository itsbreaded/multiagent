import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { BrowserViewManager } from './browser/BrowserViewManager'
import { BrowserMcpServer } from './mcp/BrowserMcpServer'

// Keep a reference so SessionIndex can be closed on quit
let cleanupFn: (() => void) | null = null

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Wire IPC handlers (sessions, PTY, shell, layout)
  const cleanup = await registerIpcHandlers(mainWindow)
  cleanupFn = cleanup ?? null

  // Set up browser panel (MCP-controlled embedded browser)
  const browserViewManager = new BrowserViewManager(mainWindow)
  browserViewManager.initialize()

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _browserMcpServer = new BrowserMcpServer(browserViewManager)

  // Push browser state changes to renderer
  browserViewManager.on('state-changed', (state: string) => {
    const active = state === 'agent-controlled'
    mainWindow.webContents.send('browser:agent-active', active)
  })

  // Toggle browser panel visibility on demand from renderer
  ipcMain.handle('browser:toggle', () => {
    const current = browserViewManager.getState()
    if (current === 'hidden') {
      browserViewManager.show()
    } else {
      browserViewManager.hide()
    }
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
})
