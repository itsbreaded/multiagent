import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'

// Playwright launches the real compiled app. When an explicit E2E profile is
// supplied, redirect every app-owned file and Chromium cache away from the
// developer's actual profile before modules compute paths at import time.
const e2eUserData = process.env['MULTIAGENT_E2E_USER_DATA_DIR']
if (e2eUserData) {
  const sessionData = join(e2eUserData, 'session-data')
  mkdirSync(e2eUserData, { recursive: true })
  mkdirSync(sessionData, { recursive: true })
  app.setPath('userData', e2eUserData)
  app.setPath('sessionData', sessionData)
}
