import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, ipcMain, safeStorage } from 'electron'
import { readProviderSettings, validateProviderSettings } from '../vendor/src/provider-settings.js'
import { getLearningModel, READING_STORAGE_KEYS } from '../vendor/src/reading-support.js'
import { STORAGE_KEYS } from '../vendor/src/translation-contracts.js'
import { installMainChrome } from '../src/chrome-shim-main.js'
import { createStorage, setCrypto } from '../src/storage.js'
import { createTeacher } from './teacher.js'

const WINDOW_TITLE = 'Selected Text Translator'
const MAX_SOURCE_LENGTH = 12000
const SELECTION_ID = 'translator-editor'
const TEACHER_MODEL_KEY = 'desktop_teacher_model'
const LANGUAGES = new Set(['auto', 'Chinese', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Russian'])
const rendererPath = fileURLToPath(new URL('./index.html', import.meta.url))
const testProfile = process.env.STT_DESKTOP_TEST_PROFILE

if (testProfile) {
  const profileDir = resolve(testProfile)
  mkdirSync(profileDir, { recursive: true })
  app.setPath('userData', profileDir)
}

let windowRef = null

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
  window.once('ready-to-show', () => {
    if (testProfile && process.platform === 'darwin') window.showInactive()
    else window.show()
  })
  window.on('closed', () => { windowRef = null })
  return window.loadFile(rendererPath)
}

async function bootstrap() {
  const userDataDir = app.getPath('userData')
  const storage = createStorage(userDataDir)
  setCrypto({
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  })
  let sessionSettings = null
  let activeRequest = null
  const syncStorage = {
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
  }
  async function readTeacherSettings() {
    const legacyKey = READING_STORAGE_KEYS.LEARNING_MODEL
    const saved = await syncStorage.get([TEACHER_MODEL_KEY, legacyKey])
    const learningModel = getLearningModel('', saved[TEACHER_MODEL_KEY] ?? saved[legacyKey]) || ''
    return { learningModel }
  }
  const teacher = createTeacher({ userDataDir, readProviderSettings, readReadingSettings: readTeacherSettings })
  const { dispatch } = installMainChrome({
    storage: { ...storage, sync: syncStorage },
    sendToTab(id, message) {
      const contents = windowRef?.webContents
      if (contents?.id !== id || message?.type !== 'TRANSLATION_EVENT') return
      const result = message.payload
      if (!activeRequest || result.requestId !== activeRequest.id) return
      contents.send('translator:result', result)
      if (result.status === 'success' && activeRequest.lookupText) teacher.recordLookup(activeRequest.lookupText)
      if (['success', 'error', 'missing-configuration'].includes(result.status)) activeRequest = null
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
    const { learningModel } = await readTeacherSettings()
    return { baseUrl, model, learningModel, hasKey: Boolean(apiKey) }
  })
  handle('save-settings', async ({ baseUrl, model, apiKey, learningModel }) => {
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
    if (learningModel && !getLearningModel('', learningModel)) return { ok: false, code: 'learning-model' }
    const { settings, isValid } = validateProviderSettings({ baseUrl: url.href, model, apiKey: apiKey || previous.apiKey })
    if (!isValid) return { ok: false }
    const didTranslationSettingsChange = Object.keys(previous).some((key) => previous[key] !== settings[key])
    await syncStorage.set({
      [STORAGE_KEYS.BASE_URL]: settings.baseUrl,
      [STORAGE_KEYS.MODEL]: settings.model,
      [STORAGE_KEYS.API_KEY]: settings.apiKey,
      [TEACHER_MODEL_KEY]: String(learningModel || '').trim(),
    })
    return { ok: true, didTranslationSettingsChange, isSessionOnly: Boolean(sessionSettings) }
  })
  handle('translate', (payload, sender) => {
    const { requestId, text, sourceLanguage, targetLanguage } = payload
    if (typeof requestId !== 'string' || typeof text !== 'string' || !text.trim() || text.length > MAX_SOURCE_LENGTH
      || !LANGUAGES.has(sourceLanguage) || !LANGUAGES.has(targetLanguage)) return { accepted: false }
    const lookupText = ['auto', 'English'].includes(sourceLanguage) ? text : ''
    activeRequest = { id: requestId, lookupText }
    return dispatch({
      type: 'START_TRANSLATION',
      payload: { requestId, selectionId: SELECTION_ID, text, sourceLanguage, targetLanguage },
    }, sender)
  })
  handle('cancel', (requestId, sender) => {
    if (activeRequest?.id !== requestId) return
    activeRequest = null
    return dispatch({ type: 'CANCEL_TRANSLATION', payload: { requestId } }, sender)
  })
  handle('copy', (text) => clipboard.writeText(String(text || '')))
  handle('teacher-overview', teacher.overview)
  handle('teacher-start', teacher.start)
  handle('teacher-grade', teacher.grade)
  handle('teacher-guide', teacher.guide)
  handle('teacher-clear', () => {
    const result = teacher.clear()
    if (result.ok && activeRequest) activeRequest.lookupText = ''
    return result
  })

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
