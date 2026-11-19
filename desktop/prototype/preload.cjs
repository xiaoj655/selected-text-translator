const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('translationPreview', {
  settings: () => ipcRenderer.invoke('preview:settings'),
  saveSettings: (values) => ipcRenderer.invoke('preview:save-settings', values),
  translate: (request) => ipcRenderer.invoke('preview:translate', request),
  cancel: (requestId) => ipcRenderer.invoke('preview:cancel', requestId),
  copy: (text) => ipcRenderer.invoke('preview:copy', text),
  onResult: (callback) => ipcRenderer.on('preview:result', (_event, payload) => callback(payload)),
})
