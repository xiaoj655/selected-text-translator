import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, shell } from 'electron'
import { createStorage, setCrypto } from './storage.js'
import { createHistory } from './history.js'
import { installMainChrome } from './chrome-shim-main.js'
import { routeDesktopMessageSender } from './message-sender.js'
import { createWindows } from './windows.js'
import { createTts } from './tts.js'
import { createSpeechPlayer } from './speech-player.js'
import { coachError, createTutor } from './tutor.js'
import { createReadingDiscovery } from './reading-sources.js'
import { importReadingPage } from './reading-web.js'
import { createReadingTutor } from './reading-tutor.js'
import { createReadingHistory } from './reading-history.js'
import { publicReadingUrl } from './reading-network.js'
import { handleReadingMediaRequest } from './reading-media.js'
import { synthesizeDashScopeSpeech } from './dashscope-tts.js'
import { createRequestDebug } from './request-debug.js'
import { createDesktopUpdater, fetchReleasePage, findDesktopUpdate } from './update.js'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const vendorDir = join(desktopDir, 'vendor', 'src')
const MAIN_WINDOW_URL = pathToFileURL(join(desktopDir, 'app', 'index.html')).href
const RELEASES_URL = 'https://github.com/xiaoj655/selected-text-translator/releases'
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const API_CREDENTIAL_KEYS = ['api_key', 'desktop_tts_api_key', 'desktop_iqs_api_key']
const IQS_CONSOLE_URL = 'https://aisearch.aliyun.com/web-parsing?tab=docs&apiTab=scrape'
const BAILIAN_CONSOLE_URL = 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key'

protocol.registerSchemesAsPrivileged([{ scheme: 'stt-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

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

function installReadingIpc(storage, fetcher) {
  const readingTutor = createReadingTutor({ storage, fetcher })
  const readingHistory = createReadingHistory(app.getPath('userData'))
  const readingDiscovery = createReadingDiscovery({ fetchImpl: net.fetch, storage })
  const articles = new Map()
  function rememberArticle(article) {
    articles.delete(article.id)
    articles.set(article.id, article)
    while (articles.size > 150) articles.delete(articles.keys().next().value)
  }
  const handlers = {
    async 'stt:reading-discover'(category) {
      const result = await readingDiscovery.discover(category)
      for (const article of result.articles) rememberArticle(article)
      return result
    },
    async 'stt:reading-feed-add'(url) {
      try {
        return await readingDiscovery.addFeed(url)
      } catch (error) {
        throw coachError(error.message)
      }
    },
    async 'stt:reading-feed-remove'(id) {
      try {
        return await readingDiscovery.removeFeed(id)
      } catch {
        throw coachError('Could not remove this feed. Try again.')
      }
    },
    async 'stt:reading-import'(url) {
      const saved = await storage.sync.get('desktop_iqs_api_key')
      const imported = await importReadingPage(url, { apiKey: saved.desktop_iqs_api_key || '', fetchImpl: net.fetch })
      const article = readingHistory.save(imported)
      rememberArticle(article)
      return article
    },
    'stt:reading-paste'(value) {
      if (typeof value !== 'string' || !value.trim()) throw coachError('Paste some English text to continue.')
      const text = value.trim()
      const title = text.split(/\r?\n/u).find((line) => line.trim())?.trim().slice(0, 100) || 'Pasted text'
      const article = readingHistory.save({ id: `paste-${Date.now()}`, kind: 'pasted_text', title, text })
      rememberArticle(article)
      return article
    },
    'stt:reading-history'() { return readingHistory.list() },
    'stt:reading-restore'(id) {
      const article = readingHistory.restore(id)
      if (!article) throw coachError('This article is no longer in reading history.')
      rememberArticle(article)
      return article
    },
    'stt:reading-history-remove'(id) { return readingHistory.remove(id) },
    'stt:reading-history-clear'() { return readingHistory.clear() },
    'stt:reading-position'({ id, position } = {}) { return readingHistory.savePosition(id, position) },
    'stt:reading-console'() {
      return shell.openExternal(IQS_CONSOLE_URL)
    },
    'stt:reading-discuss'({ articleId, pastedText, question, history, focusText } = {}) {
      const article = articleId
        ? readingDiscovery.getArticle(articleId) ?? articles.get(articleId)
        : typeof pastedText === 'string' && { title: 'Pasted text', text: pastedText.trim() }
      if (!article) throw coachError('This article is no longer in the list. Refresh and choose it again.')
      const focus = typeof focusText === 'string' && focusText.trim().length <= 12000
        && article.text?.includes(focusText.trim()) ? focusText.trim() : ''
      return readingTutor.ask({ article, question, history, focusText: focus })
    },
    'stt:reading-open'(articleId) {
      const article = readingDiscovery.getArticle(articleId) ?? articles.get(articleId)
      if (!article?.url.startsWith('https://')) throw new Error('Could not open the original article. Refresh the list and try again.')
      return shell.openExternal(article.url)
    },
  }
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, input) => {
      if (!isMainWindowEvent(event)) throw new Error('Open the main window to read an article.')
      return handle(input)
    })
  }
}

function installIpc(storage, history, requestDebug) {
  const fetchTutor = requestDebug.forKind('tutor')
  const tutor = createTutor({ storage, history, fetcher: fetchTutor })
  installReadingIpc(storage, fetchTutor)
  ipcMain.handle('stt:history-load', () => history.load())
  ipcMain.handle('stt:history-save', (_event, entries) => history.save(entries))
  ipcMain.handle('stt:history-clear', () => history.clear())
  ipcMain.handle('stt:app-version', () => app.getVersion())
  ipcMain.handle('stt:open-releases', () => shell.openExternal(RELEASES_URL))
  ipcMain.handle('stt:reading-link', (event, url) => {
    if (!isMainWindowEvent(event)) throw new Error('Open the main window to follow an article link.')
    return shell.openExternal(publicReadingUrl(url).href)
  })
  ipcMain.handle('stt:open-bailian-console', (event) => {
    if (!isMainWindowEvent(event)) throw new Error('Open Settings in the main window.')
    return shell.openExternal(BAILIAN_CONSOLE_URL)
  })
  ipcMain.handle('stt:tutor-plan', () => tutor.getPlan())
  ipcMain.handle('stt:tutor-lesson', (_event, sourceId) => tutor.startLesson(sourceId))
  ipcMain.handle('stt:tutor-lookup', (_event, lookup) => tutor.recordLookup(lookup))
  ipcMain.handle('stt:tutor-result', (_event, result) => tutor.recordResult(result))
  ipcMain.handle('stt:message', (event, message) => dispatch(message,
    routeDesktopMessageSender(message, windows.senderFor(event.sender), isMainWindowEvent(event))))
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
  ipcMain.handle('stt:get-main-zoom', (event) => {
    if (isMainWindowEvent(event)) return windows.getMainZoom()
  })
  ipcMain.handle('stt:set-main-zoom', (event, factor) => {
    if (isMainWindowEvent(event)) return windows.setMainZoom(factor)
  })
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
  protocol.handle('stt-media', handleReadingMediaRequest)
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
  const { desktop_main_zoom } = await storage.local.get('desktop_main_zoom')
  windows = createWindows({
    desktopDir, userDataDir, logger,
    initialZoom: desktop_main_zoom,
    saveZoom: (factor) => storage.local.set({ desktop_main_zoom: factor }),
  })
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

if (process.platform === 'win32') {
  app.setAppUserModelId('io.github.xiaoj655.selected-text-translator')
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
