import { ipcMain, BrowserWindow, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as fs from 'fs'
import * as path from 'path'
import type { UpdaterStatus } from '../shared/types'

const GH_UPDATE_TOKEN: string = process.env.GH_UPDATE_TOKEN ?? ''

// Persists the version of the most recently downloaded-but-not-installed
// update so a restart surfaces "ready to install" instead of "download again".
const STATE_FILE = path.join(app.getPath('userData'), 'update-state.json')

interface PersistedUpdateState {
  readyVersion?: string
}

function readPersistedState(): PersistedUpdateState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.readyVersion === 'string') {
      return { readyVersion: parsed.readyVersion }
    }
  } catch {
    // missing or corrupt — treat as empty
  }
  return {}
}

function writePersistedState(state: PersistedUpdateState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8')
  } catch {
    // best-effort persistence
  }
}

function clearPersistedState(): void {
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {
    // already gone
  }
}

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
  // When resuming an already-downloaded update we re-fetch the installer
  // silently and must not flicker the banner through the "downloading" state.
  let suppressProgress = false

  // Defensive: clear a stale ready marker once the running app is exactly the
  // version we marked downloaded (i.e. the update was installed and we
  // restarted into it). Exact equality avoids wrongly clearing prereleases such
  // as 0.4.0-beta.1; a genuinely-newer running version is cleared by the next
  // update-not-available / download instead.
  const initial = readPersistedState()
  if (initial.readyVersion && app.getVersion() === initial.readyVersion) {
    clearPersistedState()
  }
  // Captured once per session: the version we already downloaded before this launch.
  const resumeReadyVersion = readPersistedState().readyVersion ?? ''

  autoUpdater.on('update-available', (info) => {
    if (resumeReadyVersion && resumeReadyVersion === info.version) {
      // Already downloaded this version in a previous session. Do NOT expose
      // 'ready' yet — the cached installer must be restored and validated first
      // (quitAndInstall fails with "No update filepath provided" otherwise).
      // Show a preparing state and only flip to 'ready' on update-downloaded.
      send({ state: 'preparing', version: info.version })
      suppressProgress = true
      autoUpdater.downloadUpdate().catch(() => {
        suppressProgress = false
        send({ state: 'error' })
      })
      return
    }
    send({ state: 'available', version: info.version })
    if (autoUpdateEnabled) {
      autoUpdater.downloadUpdate().catch(() => {})
    }
  })

  autoUpdater.on('update-not-available', () => {
    clearPersistedState()
    send({ state: 'up-to-date' })
  })

  autoUpdater.on('download-progress', (progress) => {
    if (suppressProgress) return
    const pct = Math.round(progress.percent)
    if (pct !== lastPercent) {
      lastPercent = pct
      send({ state: 'downloading', percent: pct })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    suppressProgress = false
    lastPercent = -1
    writePersistedState({ readyVersion: info.version })
    send({ state: 'ready', version: info.version })
  })

  autoUpdater.on('error', () => {
    suppressProgress = false
    send({ state: 'error' })
  })

  ipcMain.on('updater:install', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.on('updater:set-enabled', (_, enabled: boolean) => {
    autoUpdateEnabled = enabled
  })

  ipcMain.on('updater:download', () => {
    // Immediate feedback: flip the banner to "Downloading…" without waiting for
    // the first progress chunk from electron-updater.
    suppressProgress = false
    lastPercent = 0
    send({ state: 'downloading', percent: 0 })
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
