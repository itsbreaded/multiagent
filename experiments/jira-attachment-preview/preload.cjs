const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('attachmentDemo', {
  previewKnownAttachment: () => ipcRenderer.invoke('attachment-demo:preview-known')
})
