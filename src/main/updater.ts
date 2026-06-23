import { ipcMain, BrowserWindow, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatus } from '../shared/types'

const GH_UPDATE_TOKEN: string = process.env.GH_UPDATE_TOKEN ?? ''

let autoUpdateEnabled = false

export function initUpdater(mainWindow: BrowserWindow): void {
  const updaterActive = !!GH_UPDATE_TOKEN
  ipcMain.handle('updater:get-version', () => app.getVersion())
  ipcMain.handle('updater:is-enabled', () => updaterActive)

  if (!updaterActive) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.forceDevUpdateConfig = true
  autoUpdater.logger = null

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'itsbreaded',
    repo: 'multiagent',
    private: true,
    token: GH_UPDATE_TOKEN,
  })

  function send(status: UpdaterStatus): void {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', status)
    }
  }

  let lastPercent = -1

  autoUpdater.on('update-available', (info) => {
    send({ state: 'available', version: info.version })
    if (autoUpdateEnabled) {
      autoUpdater.downloadUpdate().catch(() => {})
    }
  })

  autoUpdater.on('update-not-available', () => {
    send({ state: 'up-to-date' })
  })

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent)
    if (pct !== lastPercent) {
      lastPercent = pct
      send({ state: 'downloading', percent: pct })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    send({ state: 'ready', version: info.version })
  })

  autoUpdater.on('error', () => {
    send({ state: 'error' })
  })

  ipcMain.on('updater:install', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.on('updater:set-enabled', (_, enabled: boolean) => {
    autoUpdateEnabled = enabled
  })

  ipcMain.on('updater:download', () => {
    autoUpdater.downloadUpdate().catch(() => {})
  })

  ipcMain.handle('updater:check', async () => {
    await autoUpdater.checkForUpdates().catch(() => {})
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 10_000)

  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000)
}
