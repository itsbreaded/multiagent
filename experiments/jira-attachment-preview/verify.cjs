const { _electron } = require('@playwright/test')
const path = require('node:path')

async function main() {
  const app = await _electron.launch({ args: [path.resolve(__dirname)] })
  const errors = []
  try {
    const window = await app.firstWindow()
    window.on('pageerror', (error) => errors.push(error.message))
    window.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await window.waitForFunction(() => document.querySelector('#status-pill')?.textContent !== 'Requesting…', null, { timeout: 12000 })
    await window.locator('#attachment-image').waitFor({ state: 'visible' })
    const result = await window.evaluate(() => ({
      title: document.title,
      status: document.querySelector('#status-pill').textContent,
      http: document.querySelector('#http-status').textContent,
      imageWidth: document.querySelector('#attachment-image').naturalWidth,
      imageHeight: document.querySelector('#attachment-image').naturalHeight,
      loadingHidden: document.querySelector('#loading-state').hidden,
      imageVisible: getComputedStyle(document.querySelector('#attachment-image')).display !== 'none',
      attachmentName: document.querySelector('#attachment-name').textContent
    }))

    if (result.status !== 'Preview ready' || !result.http.startsWith('206') || result.imageWidth < 1 || !result.loadingHidden || !result.imageVisible) {
      throw new Error(`Preview did not render: ${JSON.stringify({ result, errors })}`)
    }

    await window.locator('#preview-button').click()
    await window.locator('#image-dialog[open]').waitFor()
    console.log(JSON.stringify({ ...result, clickToView: true, errors }))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
