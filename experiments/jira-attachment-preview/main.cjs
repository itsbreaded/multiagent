const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'known-attachment.svg')
const DEMO_USER = 'preview-demo'
const DEMO_TOKEN = 'fixture-only-token'
const ATTACHMENT_PATH = '/rest/api/3/attachment/thumbnail/fixture-7421'
const MAX_ATTACHMENT_BYTES = 1024 * 1024

let attachmentServer
let attachmentUrl
let mainWindow

function startFixtureServer() {
  const fixture = fs.readFileSync(FIXTURE_PATH)
  const expectedAuthorization = `Basic ${Buffer.from(`${DEMO_USER}:${DEMO_TOKEN}`).toString('base64')}`

  attachmentServer = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== ATTACHMENT_PATH) {
      response.writeHead(404).end()
      return
    }

    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end()
      return
    }

    const range = request.headers.range
    if (range && /^bytes=0-\d*$/.test(range)) {
      const requestedEnd = Number(range.slice(range.indexOf('-') + 1))
      const end = Math.min(Number.isFinite(requestedEnd) && requestedEnd > 0 ? requestedEnd : fixture.length - 1, fixture.length - 1)
      const body = fixture.subarray(0, end + 1)
      response.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': body.length,
        'Content-Range': `bytes 0-${end}/${fixture.length}`,
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store'
      }).end(body)
      return
    }

    response.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': fixture.length,
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }).end(fixture)
  })

  return new Promise((resolve, reject) => {
    attachmentServer.once('error', reject)
    attachmentServer.listen(0, '127.0.0.1', () => {
      attachmentServer.removeListener('error', reject)
      const address = attachmentServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind the local fixture endpoint'))
        return
      }
      attachmentUrl = `http://127.0.0.1:${address.port}${ATTACHMENT_PATH}`
      resolve()
    })
  })
}

async function fetchKnownAttachment() {
  if (!attachmentUrl) throw new Error('The fixture endpoint is not ready')

  const response = await fetch(attachmentUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${DEMO_USER}:${DEMO_TOKEN}`).toString('base64')}`,
      Range: `bytes=0-${MAX_ATTACHMENT_BYTES - 1}`
    },
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  })

  if (response.status !== 206) {
    throw new Error(`Expected a partial-content response, received HTTP ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('image/svg+xml')) {
    throw new Error(`Unexpected attachment content type: ${contentType || 'missing'}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment size is outside the allowed range: ${bytes.byteLength} bytes`)
  }

  return {
    bytes,
    contentType: 'image/svg+xml',
    fileName: 'incident-7421-diagnostic.svg',
    byteLength: bytes.byteLength,
    status: response.status,
    contentRange: response.headers.get('content-range') || 'not provided'
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    title: 'Jira Attachment Preview Demo',
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.on('closed', () => { mainWindow = undefined })
}

app.whenReady().then(async () => {
  app.setName('jira-attachment-preview-demo')
  await startFixtureServer()
  ipcMain.handle('attachment-demo:preview-known', fetchKnownAttachment)
  createWindow()
}).catch((error) => {
  console.error('Could not start the Jira attachment preview demo:', error)
  app.quit()
})

app.on('before-quit', () => {
  if (attachmentServer) attachmentServer.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
