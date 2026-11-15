const MESSAGE_TIMEOUT_MS = 30000

export function installMainChrome({ storage, windows, tts, logger = () => {} }) {
  const messageListeners = new Set()
  const storageListeners = new Set()

  storage.onChangedSubscribe((changes, areaName) => {
    for (const fn of storageListeners) {
      try {
        fn(changes, areaName)
      } catch (error) {
        logger('storage listener failed', error)
      }
    }
    windows.broadcast('stt:storage-changed', { changes, areaName })
  })

  function dispatch(message, sender) {
    return new Promise((resolve) => {
      let settled = false
      const sendResponse = (response) => {
        if (settled || response === undefined) return
        settled = true
        resolve(response)
      }
      let asyncListeners = 0
      for (const fn of [...messageListeners]) {
        try {
          if (fn(message, sender, sendResponse) === true) asyncListeners += 1
        } catch (error) {
          logger('message listener failed', error)
        }
      }
      queueMicrotask(() => {
        if (!settled && asyncListeners === 0) resolve(undefined)
      })
      setTimeout(() => {
        if (!settled) resolve(undefined)
      }, MESSAGE_TIMEOUT_MS)
    })
  }

  const callback = (value) => (typeof value === 'function' ? value : () => {})

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
      sendMessage(message, cb) {
        windows.broadcast('stt:message', message)
        callback(cb)()
        return Promise.resolve(undefined)
      },
      getURL(path) {
        return `app://local/${String(path || '')}`
      },
      openOptionsPage(cb) {
        windows.open('settings')
        callback(cb)()
      },
    },
    storage: {
      sync: storage.sync,
      local: storage.local,
      onChanged: {
        addListener(fn) {
          storageListeners.add(fn)
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: windows.cardId(), url: '', active: true }]
      },
      sendMessage(tabId, message, third, fourth) {
        windows.sendToWindow(tabId, 'stt:message', message)
        callback(typeof third === 'function' ? third : fourth)()
      },
      create(options, cb) {
        windows.open(String(options?.url || '').includes('library') ? 'library' : 'settings')
        callback(cb)()
      },
    },
    tts,
  }

  globalThis.chrome = chrome
  return { chrome, dispatch }
}
