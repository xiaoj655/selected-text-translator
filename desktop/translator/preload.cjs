const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopTranslator', {
  settings: () => ipcRenderer.invoke('translator:settings'),
  saveSettings: (values) => ipcRenderer.invoke('translator:save-settings', values),
  translate: (request) => ipcRenderer.invoke('translator:translate', request),
  cancel: (requestId) => ipcRenderer.invoke('translator:cancel', requestId),
  copy: (text) => ipcRenderer.invoke('translator:copy', text),
  onResult: (callback) => ipcRenderer.on('translator:result', (_event, payload) => callback(payload)),
})
