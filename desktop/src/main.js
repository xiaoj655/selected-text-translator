import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, clipboard, globalShortcut, ipcMain, safeStorage } from 'electron'
import { createStorage, setCrypto } from './storage.js'
import { installMainChrome } from './chrome-shim-main.js'
import { createWindows } from './windows.js'
import { createCapture } from './capture.js'
import { createTts } from './tts.js'
import { createShortcuts, HOTKEY_OPTIONS } from './shortcuts.js'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const vendorDir = join(desktopDir, 'vendor', 'src')

const logger = (event, detail) => console.log('[desktop]', event, detail ?? '')

let windows
let shortcuts
let capture
let dispatch

async function onHotkey() {
  try {
    const payload = await capture.capture()
    logger('capture', payload.source)
    await windows.showCard(payload)
  } catch (error) {
    logger('hotkey failed', error?.message || error)
  }
}

function installIpc(storage) {
  ipcMain.handle('stt:message', (event, message) => dispatch(message, windows.senderFor(event.sender)))
  ipcMain.handle('stt:storage', (_event, request) => {
    const store = request?.area === 'local' ? storage.local : storage.sync
    return request?.op === 'set' ? store.set(request.items) : store.get(request.keys)
  })
  ipcMain.handle('stt:tabs-query', () => [{ id: windows.cardId(), url: '', active: true }])
  ipcMain.handle('stt:open', (_event, name) => {
    windows.open(name)
    return true
  })
  ipcMain.handle('stt:hotkey-options', () => HOTKEY_OPTIONS)
  ipcMain.handle('stt:set-hotkey', (_event, value) => shortcuts.register(value))
  ipcMain.on('stt:hide', () => windows.hideCard())
}

async function bootstrap() {
  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  if (safeStorage.isEncryptionAvailable()) {
    setCrypto({
      encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    })
  }

  const storage = createStorage(userDataDir)
  const tts = createTts({ logger })
  windows = createWindows({ desktopDir, logger })
  const shim = installMainChrome({ storage, windows, tts, logger })
  dispatch = shim.dispatch
  capture = createCapture({ clipboard, logger })
  shortcuts = createShortcuts({ globalShortcut, storage, onTrigger: onHotkey, logger })

  installIpc(storage)

  await import(pathToFileURL(join(vendorDir, 'background.js')).href)
  logger('background module loaded')

  windows.createTray({
    onTrigger: onHotkey,
    onQuit: () => app.quit(),
    hotkeyOptions: HOTKEY_OPTIONS,
    onHotkeyChange: (value) => shortcuts.register(value),
    currentHotkey: () => shortcuts.current(),
  })
  await shortcuts.init()

  if (process.platform === 'darwin' && app.dock) app.dock.hide()
  logger('ready', process.platform)
}

app.whenReady().then(bootstrap).catch((error) => {
  logger('bootstrap failed', error)
  app.exit(1)
})

app.on('window-all-closed', (event) => event.preventDefault())
app.on('will-quit', () => globalShortcut.unregisterAll())
