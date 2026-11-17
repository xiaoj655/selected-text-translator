const noop = () => {}
const store = {
  reading_mode: 'translate',
  desktop_prefs: { theme: 'dark', font: 'normal', accent: 'indigo', reducedMotion: false },
}

const entry = {
  id: 'verify-1',
  requestId: 'verify-r1',
  text: 'The quick brown fox jumps over the lazy dog.',
  mode: 'translate',
  status: 'done',
  translatedText: '敏捷的棕色狐狸跳过了懒狗。',
  lexical: null,
  guide: null,
  error: '',
  createdAt: Date.now(),
  hintCount: 1,
  answerRevealed: false,
}

window.sttDesktop = {
  loadHistory: async () => [entry],
  saveHistory: noop,
  clearHistory: noop,
  getHotkey: async () => 'Alt+Shift+E',
  getFlags: async () => ({ alwaysOnTop: false, loginItem: false, clipboardOnly: false }),
  getPlatform: async () => 'linux',
  platform: async () => 'linux',
  setTheme: noop,
  setCaptureMode: noop,
  setAlwaysOnTop: noop,
  setLoginItem: noop,
  setHotkey: async () => true,
  copyText: noop,
  openLibrary: noop,
  openLog: noop,
  hide: noop,
  hideCard: noop,
  resizeCard: noop,
  setCardPinned: noop,
  onSelection: noop,
  onCardEntry: noop,
  onStatus: noop,
  openMainWithText: noop,
}

const listeners = []
Object.defineProperty(window, 'chrome', {
  configurable: true,
  value: {
    storage: {
      sync: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : Object.keys(store)
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]))
        },
        set: async (items) => Object.assign(store, items),
      },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: noop },
    },
    runtime: {
      sendMessage: async () => ({ accepted: true }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => `app://local/${p}`,
      lastError: undefined,
    },
    i18n: { getMessage: (k) => k },
  },
})
