import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, ipcMain, safeStorage } from 'electron'
import { readProviderSettings, saveProviderSettings } from '../vendor/src/provider-settings.js'
import { installMainChrome } from '../src/chrome-shim-main.js'
import { createStorage, setCrypto } from '../src/storage.js'

const WINDOW_TITLE = 'Selected Text Translator'
const MAX_SOURCE_LENGTH = 12000
const SELECTION_ID = 'translator-editor'
const LANGUAGES = new Set(['auto', 'Chinese', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Russian'])
const rendererPath = fileURLToPath(new URL('./index.html', import.meta.url))

if (process.env.STT_DESKTOP_TEST_PROFILE) {
  const profileDir = resolve(process.env.STT_DESKTOP_TEST_PROFILE)
  mkdirSync(profileDir, { recursive: true })
  app.setPath('userData', profileDir)
}

let windowRef = null
let activeRequestId = null

function openWindow() {
  if (windowRef) {
    if (windowRef.isMinimized()) windowRef.restore()
    windowRef.focus()
    return
  }
  const window = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 1000,
    height: 660,
    minWidth: 380,
    minHeight: 460,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  })
  windowRef = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { windowRef = null })
  return window.loadFile(rendererPath)
}

async function bootstrap() {
  const storage = createStorage(app.getPath('userData'))
  setCrypto({
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  })
  let sessionSettings = null
  const { dispatch } = installMainChrome({
    storage: {
      ...storage,
      sync: {
        async get(keys) {
          const saved = await storage.sync.get(keys)
          return sessionSettings ? { ...saved, ...sessionSettings } : saved
        },
        async set(values) {
          try {
            if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
              throw new Error('Secure storage is unavailable')
            }
            await storage.sync.set(values)
            sessionSettings = null
          } catch {
            sessionSettings = values
          }
        },
      },
    },
    windows: {
      broadcast() {},
      sendToWindow(id, _channel, message) {
        const contents = windowRef?.webContents
        if (contents?.id !== id || message?.type !== 'TRANSLATION_EVENT') return
        if (message.payload.requestId !== activeRequestId) return
        if (['success', 'error', 'missing-configuration'].includes(message.payload.status)) activeRequestId = null
        contents.send('translator:result', message.payload)
      },
    },
  })
  await import('../vendor/src/background.js')

  function handle(channel, callback) {
    ipcMain.handle(`translator:${channel}`, (event, value) => {
      if (event.sender !== windowRef?.webContents) throw new Error('Invalid sender')
      return callback(value, { tab: { id: event.sender.id }, frameId: 0 })
    })
  }

  handle('settings', async () => {
    const { baseUrl, model, apiKey } = await readProviderSettings()
    return { baseUrl, model, hasKey: Boolean(apiKey) }
  })
  handle('save-settings', async ({ baseUrl, model, apiKey }) => {
    let url
    try {
      url = new URL(baseUrl)
    } catch {
      return { ok: false }
    }
    const previous = await readProviderSettings()
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return { ok: false }
    }
    const saved = await saveProviderSettings({ baseUrl: url.href, model, apiKey: apiKey || previous.apiKey })
    return { ok: saved.ok, isSessionOnly: Boolean(sessionSettings) }
  })
  handle('translate', (payload, sender) => {
    const { requestId, text, sourceLanguage, targetLanguage } = payload
    if (typeof requestId !== 'string' || typeof text !== 'string' || !text.trim() || text.length > MAX_SOURCE_LENGTH
      || !LANGUAGES.has(sourceLanguage) || !LANGUAGES.has(targetLanguage)) return { accepted: false }
    activeRequestId = requestId
    return dispatch({
      type: 'START_TRANSLATION',
      payload: { requestId, selectionId: SELECTION_ID, text, sourceLanguage, targetLanguage },
    }, sender)
  })
  handle('cancel', (requestId, sender) => {
    if (activeRequestId !== requestId) return
    activeRequestId = null
    return dispatch({ type: 'CANCEL_TRANSLATION', payload: { requestId } }, sender)
  })
  handle('copy', (text) => clipboard.writeText(String(text || '')))

  await openWindow()
  app.on('activate', () => { void openWindow() })
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (windowRef) openWindow()
  })
  app.on('window-all-closed', () => app.quit())
  app.whenReady().then(bootstrap).catch((error) => {
    console.error('Unable to start the desktop translator:', error.message)
    app.exit(1)
  })
} else {
  app.quit()
}
