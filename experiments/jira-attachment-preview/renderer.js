const image = document.getElementById('attachment-image')
const previewButton = document.getElementById('preview-button')
const loadingState = document.getElementById('loading-state')
const reloadButton = document.getElementById('reload-button')
const dialog = document.getElementById('image-dialog')
const dialogImage = document.getElementById('dialog-image')
const statusPill = document.getElementById('status-pill')
let currentObjectUrl

function setStatus(text, kind = '') {
  statusPill.textContent = text
  statusPill.className = `status-pill ${kind}`.trim()
}

async function loadPreview() {
  previewButton.disabled = true
  image.hidden = true
  loadingState.hidden = false
  loadingState.textContent = 'Loading attachment…'
  setStatus('Requesting…')

  try {
    const result = await window.attachmentDemo.previewKnownAttachment()
    const blob = new Blob([result.bytes], { type: result.contentType })
    const objectUrl = URL.createObjectURL(blob)
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = objectUrl
    image.src = objectUrl
    dialogImage.src = objectUrl
    image.hidden = false
    loadingState.hidden = true
    previewButton.disabled = false
    document.getElementById('attachment-name').textContent = `${result.fileName} · ${(result.byteLength / 1024).toFixed(1)} KB`
    document.getElementById('http-status').textContent = `${result.status} Partial Content`
    document.getElementById('content-range').textContent = result.contentRange
    document.getElementById('byte-count').textContent = `${result.byteLength.toLocaleString()} bytes`
    document.getElementById('request-summary').textContent = 'Authenticated ranged request succeeded. The image is rendered from an in-memory Blob URL; no attachment file was saved.'
    setStatus('Preview ready', 'success')
  } catch (error) {
    loadingState.hidden = false
    loadingState.textContent = 'Could not load the attachment preview.'
    document.getElementById('request-summary').textContent = error instanceof Error ? error.message : 'Unknown attachment preview error'
    document.getElementById('http-status').textContent = 'Failed'
    setStatus('Preview failed', 'error')
  }
}

previewButton.addEventListener('click', () => {
  if (currentObjectUrl) dialog.showModal()
})
reloadButton.addEventListener('click', loadPreview)
document.getElementById('close-dialog').addEventListener('click', () => dialog.close())
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close()
})
window.addEventListener('beforeunload', () => {
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl)
})

loadPreview()
