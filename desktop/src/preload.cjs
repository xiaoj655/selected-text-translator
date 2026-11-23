const { ipcRenderer } = require('electron')

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
    remove(keys) {
      return ipcRenderer.invoke('stt:storage', { area, op: 'remove', keys })
    },
  }
}

function withCallback(promise, callback) {
  if (typeof callback === 'function') promise.then(callback).catch(() => callback())
  return promise
}

const chromeShim = {
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

try {
  delete window.chrome
} catch {
  // chromium exposes a built-in chrome object in some versions
}
try {
  Object.defineProperty(window, 'chrome', { value: chromeShim, configurable: true, writable: true })
} catch {
  window.chrome = chromeShim
}

window.sttDesktop = {
  getMainZoom() {
    return ipcRenderer.invoke('stt:get-main-zoom')
  },
  setMainZoom(factor) {
    return ipcRenderer.invoke('stt:set-main-zoom', factor)
  },
  onMainZoomChanged(callback) {
    ipcRenderer.on('stt:main-zoom-changed', (_event, factor) => callback(factor))
  },
  onSelection(callback) {
    ipcRenderer.on('stt:selection', (_event, payload) => callback(payload))
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
  getAppVersion() {
    return ipcRenderer.invoke('stt:app-version')
  },
  openReleases() {
    return ipcRenderer.invoke('stt:open-releases')
  },
  getUpdateStatus() {
    return ipcRenderer.invoke('stt:update-status')
  },
  checkForUpdates() {
    return ipcRenderer.invoke('stt:update-check')
  },
  installUpdate() {
    return ipcRenderer.invoke('stt:update-install')
  },
  onUpdateState(callback) {
    ipcRenderer.on('stt:update-state', (_event, state) => callback(state))
  },
  requestDebug: {
    getState: () => ipcRenderer.invoke('stt:request-debug-state'),
    setEnabled: (flag) => ipcRenderer.invoke('stt:request-debug-enable', flag),
    clear: () => ipcRenderer.invoke('stt:request-debug-clear'),
    onChanged(callback) {
      const listener = () => callback()
      ipcRenderer.on('stt:request-debug-changed', listener)
      return () => ipcRenderer.removeListener('stt:request-debug-changed', listener)
    },
  },
  tutor: {
    getPlan: () => ipcRenderer.invoke('stt:tutor-plan'),
    startLesson: (sourceId) => ipcRenderer.invoke('stt:tutor-lesson', sourceId),
    recordLookup: (lookup) => ipcRenderer.invoke('stt:tutor-lookup', lookup),
    recordResult: (result) => ipcRenderer.invoke('stt:tutor-result', result),
  },
  openBailianConsole: () => ipcRenderer.invoke('stt:open-bailian-console'),
  reading: {
    discover: (category) => ipcRenderer.invoke('stt:reading-discover', category),
    addFeed: (url) => ipcRenderer.invoke('stt:reading-feed-add', url),
    removeFeed: (id) => ipcRenderer.invoke('stt:reading-feed-remove', id),
    importPage: (url) => ipcRenderer.invoke('stt:reading-import', url),
    paste: (text) => ipcRenderer.invoke('stt:reading-paste', text),
    history: () => ipcRenderer.invoke('stt:reading-history'),
    restore: (id) => ipcRenderer.invoke('stt:reading-restore', id),
    removeHistory: (id) => ipcRenderer.invoke('stt:reading-history-remove', id),
    clearHistory: () => ipcRenderer.invoke('stt:reading-history-clear'),
    savePosition: (input) => ipcRenderer.invoke('stt:reading-position', input),
    openConsole: () => ipcRenderer.invoke('stt:reading-console'),
    discuss: (input) => ipcRenderer.invoke('stt:reading-discuss', input),
    openArticle: (id) => ipcRenderer.invoke('stt:reading-open', id),
    openLink: (url) => ipcRenderer.invoke('stt:reading-link', url),
  },
  getFlags() {
    return ipcRenderer.invoke('stt:get-flags')
  },
  setAlwaysOnTop(flag) {
    return ipcRenderer.invoke('stt:set-always-on-top', flag)
  },
  setLoginItem(flag) {
    return ipcRenderer.invoke('stt:set-login-item', flag)
  },
  readClipboard() {
    return ipcRenderer.invoke('stt:read-clipboard')
  },
  setTheme(theme) {
    return ipcRenderer.invoke('stt:set-theme', theme)
  },
  reportEntry(entry) {
    return ipcRenderer.invoke('stt:card-entry', entry)
  },
  hideCard() {
    ipcRenderer.send('stt:hide-card')
  },
  resizeCard(height) {
    ipcRenderer.send('stt:card-resize', height)
  },
  setCardPinned(flag) {
    ipcRenderer.send('stt:card-pin', flag)
  },
  openMainWithText(text) {
    return ipcRenderer.invoke('stt:open-main-text', text)
  },
  onCardEntry(callback) {
    ipcRenderer.on('stt:card-entry', (_event, entry) => callback(entry))
  },
  onCardEscape(callback) {
    ipcRenderer.on('stt:card-escape', () => callback())
  },
}

if (process.env.STT_E2E === '1') {
  window.sttDesktop.e2e = {
    showCard: (payload) => ipcRenderer.invoke('stt:e2e:show-card', payload),
    hideCard: () => ipcRenderer.invoke('stt:e2e:hide-card'),
    cardMetrics: () => ipcRenderer.invoke('stt:e2e:card-metrics'),
  }
}
