import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, clipboard, globalShortcut, ipcMain, nativeTheme, Notification, safeStorage, shell } from 'electron'
import { createStorage, setCrypto } from './storage.js'
import { createHistory } from './history.js'
import { installMainChrome } from './chrome-shim-main.js'
import { createWindows } from './windows.js'
import { createCapture } from './capture.js'
import { createTts } from './tts.js'
import { createShortcuts, HOTKEY_OPTIONS } from './shortcuts.js'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const vendorDir = join(desktopDir, 'vendor', 'src')

let logFile = ''
let windows
let shortcuts
let capture
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

async function onHotkey() {
  let payload
  try {
    payload = await capture.capture()
    logger('capture', { source: payload.source, length: payload.text.length })
  } catch (error) {
    logger('capture-failed', error)
    payload = { text: '', context: '', contextStart: null, contextEnd: null, source: 'error' }
  }
  try {
    await windows.showMainWindow(payload)
  } catch (error) {
    logger('show-failed', error)
  }
}

function installIpc(storage, history) {
  ipcMain.handle('stt:history-load', () => history.load())
  ipcMain.handle('stt:history-save', (_event, entries) => history.save(entries))
  ipcMain.handle('stt:history-clear', () => history.clear())
  ipcMain.handle('stt:message', (event, message) => dispatch(message, windows.senderFor(event.sender)))
  ipcMain.handle('stt:storage', (_event, request) => {
    const store = request?.area === 'local' ? storage.local : storage.sync
    return request?.op === 'set' ? store.set(request.items) : store.get(request.keys)
  })
  ipcMain.handle('stt:tabs-query', () => [{ id: windows.mainId(), url: '', active: true }])
  ipcMain.handle('stt:open', (_event, name) => {
    windows.open(name)
    return true
  })
  ipcMain.handle('stt:hotkey-options', () => HOTKEY_OPTIONS)
  ipcMain.handle('stt:get-hotkey', () => shortcuts.current() || '')
  ipcMain.handle('stt:set-hotkey', (_event, value) => shortcuts.register(value))
  ipcMain.handle('stt:platform', () => process.platform)
  ipcMain.handle('stt:get-flags', () => ({
    alwaysOnTop: windows.getAlwaysOnTop(),
    loginItem: app.getLoginItemSettings().openAtLogin,
    clipboardOnly: capture.getMode() === 'clipboard',
  }))
  ipcMain.handle('stt:set-theme', (_event, theme) => {
    windows.setTheme(theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors))
    return true
  })
  ipcMain.handle('stt:set-capture-mode', (_event, mode) => {
    capture.setMode(mode)
    void storage.sync.set({ desktop_capture_mode: mode === 'clipboard' ? 'clipboard' : 'auto' })
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
  ipcMain.handle('stt:open-log', () => {
    if (logFile) void shell.openPath(logFile)
    return true
  })
  ipcMain.on('stt:hide', () => windows.hideMainWindow())
}

async function bootstrap() {
  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  logFile = join(userDataDir, 'desktop.log')
  if (typeof safeStorage.encryptString === 'function' && typeof safeStorage.decryptString === 'function') {
    setCrypto({
      encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    })
  }

  const storage = createStorage(userDataDir)
  const history = createHistory(userDataDir)
  const tts = createTts({ logger })
  windows = createWindows({ desktopDir, userDataDir, logger })
  try {
    const flags = await storage.sync.get(['desktop_always_on_top', 'desktop_login_item'])
    if (flags?.desktop_always_on_top) windows.setAlwaysOnTop(true)
    if (flags?.desktop_login_item) app.setLoginItemSettings({ openAtLogin: true })
  } catch {
    // window flags are best effort
  }
  const shim = installMainChrome({ storage, windows, tts, logger })
  dispatch = shim.dispatch
  capture = createCapture({ clipboard, logger })
  try {
    const savedMode = await storage.sync.get(['desktop_capture_mode'])
    if (savedMode?.desktop_capture_mode === 'clipboard') capture.setMode('clipboard')
  } catch {
    // capture mode is best effort
  }
  shortcuts = createShortcuts({ globalShortcut, storage, onTrigger: onHotkey, logger })

  installIpc(storage, history)

  await import(pathToFileURL(join(vendorDir, 'background.js')).href)
  logger('background module loaded')

  windows.createTray({
    onTrigger: onHotkey,
    onQuit: () => app.quit(),
    onOpenLog: () => {
      if (logFile) void shell.openPath(logFile)
    },
    hotkeyOptions: HOTKEY_OPTIONS,
    onHotkeyChange: (value) => shortcuts.register(value),
    currentHotkey: () => shortcuts.current(),
  })

  const registered = await shortcuts.init()
  if (registered) {
    logger('hotkey', registered)
    windows.notifyStatus({ hotkey: registered, message: `热键 ${registered} 已就绪` })
  } else {
    logger('hotkey-unavailable', 'no accelerator could be registered')
    new Notification({
      title: 'Selected Text Translator',
      body: '全局热键被占用,请用托盘菜单打开主窗口,或换一个快捷键。',
    }).show()
    windows.notifyStatus({ hotkey: '', message: '热键注册失败,请用托盘菜单打开主窗口' })
  }

  if (process.platform === 'darwin' && app.dock) app.dock.hide()
  logger('ready', process.platform)
}

app.whenReady().then(bootstrap).catch((error) => {
  logger('bootstrap failed', error)
  app.exit(1)
})

app.on('window-all-closed', (event) => event.preventDefault())
app.on('before-quit', () => windows?.setQuitting())
app.on('will-quit', () => globalShortcut.unregisterAll())
