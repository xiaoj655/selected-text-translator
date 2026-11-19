export function installMainChrome({ storage, sendToTab }) {
  const messageListeners = new Set()
  const storageListeners = new Set()

  storage.onChangedSubscribe((changes, areaName) => {
    for (const listener of storageListeners) listener(changes, areaName)
  })

  function dispatch(message, sender) {
    let response
    for (const listener of messageListeners) {
      listener(message, sender, (value) => { response = value })
      if (response !== undefined) return response
    }
  }

  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(fn) {
          messageListeners.add(fn)
        },
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
      sendMessage(tabId, message, _options, callback) {
        sendToTab(tabId, message)
        callback?.()
      },
    },
  }

  globalThis.chrome = chrome
  return { chrome, dispatch }
}
