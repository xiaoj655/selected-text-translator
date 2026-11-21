import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, net, safeStorage, shell } from 'electron'
import { createStorage, setCrypto } from './storage.js'
import { createHistory } from './history.js'
import { installMainChrome } from './chrome-shim-main.js'
import { createWindows } from './windows.js'
import { createTts } from './tts.js'
import { createSpeechPlayer } from './speech-player.js'
import { createTutor } from './tutor.js'
import { synthesizeDashScopeSpeech } from './dashscope-tts.js'
import { createRequestDebug } from './request-debug.js'
import { createDesktopUpdater, fetchReleasePage, findDesktopUpdate } from './update.js'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const vendorDir = join(desktopDir, 'vendor', 'src')
const MAIN_WINDOW_URL = pathToFileURL(join(desktopDir, 'app', 'index.html')).href
const RELEASES_URL = 'https://github.com/xiaoj655/selected-text-translator/releases'
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const API_CREDENTIAL_KEYS = ['api_key', 'desktop_tts_api_key']

let logFile = ''
let windows
let dispatch

function logger(event, detail) {
  let text = ''
  if (detail instanceof Error) text = detail.message
  else if (typeof detail === 'string') text = detail
  else if (detail !== undefined) {
    try {
      text = JSON.stringify(detail)
    } catch {
      text = String(detail)
    }
  }
  const short = text.slice(0, 400)
  const line = `[${new Date().toISOString()}] ${event} ${short}\n`
  try {
    if (logFile) appendFileSync(logFile, line)
  } catch {
    // logging must never break the app
  }
  console.log('[desktop]', event, short)
}

async function setupDesktopUpdater() {
  if (process.platform !== 'win32' || !app.isPackaged) return null
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return null
  try {
    const { default: { NsisUpdater } } = await import('electron-updater')
    return createDesktopUpdater({
      updater: new NsisUpdater(),
      findRelease: () => findDesktopUpdate((page) => fetchReleasePage(net.fetch, page)),
      sendState: (state) => windows.sendToMainWindow('stt:update-state', state),
      logger,
    })
  } catch (error) {
    logger('update-init-failed', error)
    return null
  }
}

function isMainWindowEvent(event) {
  const frame = event.senderFrame
  return windows.senderFor(event.sender).documentId === 'main'
    && frame?.parent === null && frame.url === MAIN_WINDOW_URL
}

function installUpdateIpc(updates) {
  const handlers = {
    'stt:update-status': () => updates.getState(),
    'stt:update-check': () => updates.check(),
    'stt:update-install': () => updates.install(),
  }
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event) => {
      if (!updates || !isMainWindowEvent(event)) {
        return { status: 'unsupported' }
      }
      return handle()
    })
  }
}

function installRequestDebugIpc(requestDebug) {
  const handlers = {
    'stt:request-debug-state': () => requestDebug.getState(),
    'stt:request-debug-enable': (flag) => requestDebug.setEnabled(flag),
    'stt:request-debug-clear': () => requestDebug.clear(),
  }
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, flag) => {
      if (!isMainWindowEvent(event)) return { enabled: false, entries: [] }
      return handle(flag)
    })
  }
}

function installIpc(storage, history, requestDebug) {
  const tutor = createTutor({ storage, history, fetcher: requestDebug.forKind('tutor') })
  ipcMain.handle('stt:history-load', () => history.load())
  ipcMain.handle('stt:history-save', (_event, entries) => history.save(entries))
  ipcMain.handle('stt:history-clear', () => history.clear())
  ipcMain.handle('stt:app-version', () => app.getVersion())
  ipcMain.handle('stt:open-releases', () => shell.openExternal(RELEASES_URL))
  ipcMain.handle('stt:tutor-plan', () => tutor.getPlan())
  ipcMain.handle('stt:tutor-lesson', (_event, sourceId) => tutor.startLesson(sourceId))
  ipcMain.handle('stt:tutor-lookup', (_event, lookup) => tutor.recordLookup(lookup))
  ipcMain.handle('stt:tutor-result', (_event, result) => tutor.recordResult(result))
  ipcMain.handle('stt:message', (event, message) => dispatch(message, windows.senderFor(event.sender)))
  ipcMain.handle('stt:storage', (_event, request) => {
    const store = request?.area === 'local' ? storage.local : storage.sync
    if (request?.op === 'set') return store.set(request.items)
    if (request?.op === 'remove') return store.remove(request.keys)
    return store.get(request.keys)
  })
  ipcMain.handle('stt:tabs-query', () => [{ id: windows.mainId(), url: '', active: true }])
  ipcMain.handle('stt:open', (_event, name) => {
    windows.open(name)
    return true
  })
  ipcMain.handle('stt:get-flags', () => ({
    alwaysOnTop: windows.getAlwaysOnTop(),
    loginItem: app.getLoginItemSettings().openAtLogin,
  }))
  ipcMain.handle('stt:set-theme', (_event, theme) => {
    windows.setTheme(theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors))
    return true
  })
  ipcMain.handle('stt:set-always-on-top', (_event, flag) => {
    windows.setAlwaysOnTop(flag)
    void storage.sync.set({ desktop_always_on_top: Boolean(flag) })
    return true
  })
  ipcMain.handle('stt:set-login-item', (_event, flag) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(flag) })
    void storage.sync.set({ desktop_login_item: Boolean(flag) })
    return true
  })
  ipcMain.handle('stt:copy-text', (_event, text) => {
    clipboard.writeText(String(text || ''))
    return true
  })
  ipcMain.handle('stt:read-clipboard', async () => {
    try {
      return String(await clipboard.readText() || '')
    } catch {
      return ''
    }
  })
  ipcMain.handle('stt:open-log', () => {
    if (logFile) void shell.openPath(logFile)
    return true
  })
  ipcMain.on('stt:hide', () => windows.hideMainWindow())
  ipcMain.on('stt:hide-card', () => windows.hideCardWindow())
  ipcMain.on('stt:card-resize', (_event, height) => windows.resizeCardWindow(height))
  ipcMain.on('stt:card-pin', (_event, flag) => windows.setCardPinned(flag))
  ipcMain.handle('stt:card-entry', (_event, entry) => {
    windows.sendToMainWindow('stt:card-entry', entry)
    return true
  })
  ipcMain.handle('stt:open-main-text', async (_event, text) => {
    await windows.showMainWindow({ text: String(text || ''), source: 'card' })
    return true
  })
  if (process.env.STT_E2E === '1') {
    ipcMain.handle('stt:e2e:show-card', async (_event, payload) => {
      await windows.showCardWindow(payload || {})
      return true
    })
    ipcMain.handle('stt:e2e:hide-card', () => {
      windows.hideCardWindow()
      return true
    })
    ipcMain.handle('stt:e2e:card-metrics', () => windows.cardMetrics())
  }
}

async function bootstrap() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { role: 'quit' }] },
      { role: 'editMenu' },
    ]))
  } else {
    Menu.setApplicationMenu(null)
  }
  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  logFile = join(userDataDir, 'desktop.log')
  let cryptoReady = false
  if (typeof safeStorage.encryptString === 'function' && typeof safeStorage.decryptString === 'function') {
    try {
      const probe = safeStorage.encryptString('stt-crypto-probe')
      cryptoReady = safeStorage.decryptString(probe) === 'stt-crypto-probe'
    } catch {
      cryptoReady = false
    }
  }
  if (cryptoReady) {
    setCrypto({
      encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    })
  }

  const storage = createStorage(userDataDir)
  const history = createHistory(userDataDir)
  const requestDebug = createRequestDebug({
    notify: () => windows.sendToMainWindow('stt:request-debug-changed'),
  })
  const fetchSpeech = requestDebug.forKind('cloud-speech')
  const { play } = createSpeechPlayer({ BrowserWindow })
  const tts = createTts({
    logger,
    play,
    readCloudSettings: () => storage.sync.get(['desktop_tts_cloud', 'desktop_tts_api_key', 'base_url', 'api_key']),
    synthesize: (text, options) => synthesizeDashScopeSpeech(text, { ...options, fetchImpl: fetchSpeech }),
  })
  windows = createWindows({ desktopDir, userDataDir, logger })
  try {
    const flags = await storage.sync.get(['desktop_always_on_top', 'desktop_login_item', ...API_CREDENTIAL_KEYS])
    for (const key of API_CREDENTIAL_KEYS) requestDebug.setCredential(key, flags[key])
    if (flags?.desktop_always_on_top) windows.setAlwaysOnTop(true)
    if (flags?.desktop_login_item) app.setLoginItemSettings({ openAtLogin: true })
  } catch {
    // window flags are best effort
  }
  storage.onChangedSubscribe((changes, areaName) => {
    if (areaName !== 'sync') return
    for (const key of API_CREDENTIAL_KEYS) {
      if (Object.hasOwn(changes, key)) requestDebug.setCredential(key, changes[key].newValue)
    }
  })
  const shim = installMainChrome({ storage, windows, tts, providerFetch: requestDebug.forKind, logger })
  dispatch = shim.dispatch
  installIpc(storage, history, requestDebug)
  installRequestDebugIpc(requestDebug)
  const updates = await setupDesktopUpdater()
  installUpdateIpc(updates)

  await import(pathToFileURL(join(vendorDir, 'background.js')).href)
  logger('background module loaded')

  windows.createTray({
    onQuit: () => app.quit(),
    onOpenLog: () => {
      if (logFile) void shell.openPath(logFile)
    },
  })
  await windows.showMainWindow()
  logger('ready', process.platform)
  if (updates) {
    const checkForUpdates = () => void updates.check()
    setTimeout(checkForUpdates, 3000).unref()
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS).unref()
  }
}

function showExistingWindow() {
  void windows?.showMainWindow().catch((error) => logger('show-failed', error))
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', showExistingWindow)
  app.on('activate', showExistingWindow)
  app.whenReady().then(bootstrap).catch((error) => {
    logger('bootstrap failed', error)
    app.exit(1)
  })
} else {
  app.quit()
}

app.on('window-all-closed', (event) => event.preventDefault())
app.on('before-quit', () => windows?.setQuitting())
