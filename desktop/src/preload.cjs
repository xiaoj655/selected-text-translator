const { contextBridge, ipcRenderer } = require('electron')

const messageListeners = new Set()
const storageListeners = new Set()

ipcRenderer.on('stt:message', (_event, message) => {
  for (const fn of messageListeners) {
    try {
      fn(message, {}, () => {})
    } catch {
      // one listener must not block the others
    }
  }
})

ipcRenderer.on('stt:storage-changed', (_event, payload) => {
  for (const fn of storageListeners) {
    try {
      fn(payload?.changes || {}, payload?.areaName)
    } catch {
      // one listener must not block the others
    }
  }
})

function storageArea(area) {
  return {
    get(keys) {
      return ipcRenderer.invoke('stt:storage', { area, op: 'get', keys })
    },
    set(items) {
      return ipcRenderer.invoke('stt:storage', { area, op: 'set', items })
    },
  }
}

function withCallback(promise, callback) {
  if (typeof callback === 'function') promise.then(callback).catch(() => callback())
  return promise
}

const chrome = {
  runtime: {
    lastError: undefined,
    onMessage: {
      addListener(fn) {
        messageListeners.add(fn)
      },
      removeListener(fn) {
        messageListeners.delete(fn)
      },
    },
    sendMessage(message, callback) {
      return withCallback(ipcRenderer.invoke('stt:message', message), callback)
    },
    getURL(path) {
      return `app://local/${String(path || '')}`
    },
    openOptionsPage(callback) {
      return withCallback(ipcRenderer.invoke('stt:open', 'settings'), callback)
    },
  },
  storage: {
    sync: storageArea('sync'),
    local: storageArea('local'),
    onChanged: {
      addListener(fn) {
        storageListeners.add(fn)
      },
      removeListener(fn) {
        storageListeners.delete(fn)
      },
    },
  },
  tabs: {
    query() {
      return ipcRenderer.invoke('stt:tabs-query')
    },
    create(options, callback) {
      const name = String(options?.url || '').includes('library') ? 'library' : 'settings'
      return withCallback(ipcRenderer.invoke('stt:open', name), callback)
    },
    sendMessage() {},
  },
}

contextBridge.exposeInMainWorld('chrome', chrome)
contextBridge.exposeInMainWorld('sttDesktop', {
  onSelection(callback) {
    ipcRenderer.on('stt:selection', (_event, payload) => callback(payload))
  },
  onStatus(callback) {
    ipcRenderer.on('stt:status', (_event, payload) => callback(payload))
  },
  copyText(text) {
    return ipcRenderer.invoke('stt:copy-text', text)
  },
  openSettings() {
    return ipcRenderer.invoke('stt:open', 'settings')
  },
  openLibrary() {
    return ipcRenderer.invoke('stt:open', 'library')
  },
  openLog() {
    return ipcRenderer.invoke('stt:open-log')
  },
  hide() {
    ipcRenderer.send('stt:hide')
  },
  loadHistory() {
    return ipcRenderer.invoke('stt:history-load')
  },
  saveHistory(entries) {
    return ipcRenderer.invoke('stt:history-save', entries)
  },
  clearHistory() {
    return ipcRenderer.invoke('stt:history-clear')
  },
  hotkeyOptions() {
    return ipcRenderer.invoke('stt:hotkey-options')
  },
  getHotkey() {
    return ipcRenderer.invoke('stt:get-hotkey')
  },
  setHotkey(value) {
    return ipcRenderer.invoke('stt:set-hotkey', value)
  },
  platform() {
    return ipcRenderer.invoke('stt:platform')
  },
})
