import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Menu, Tray, nativeImage } from 'electron'

const AUX_FILES = {
  settings: 'popup.html',
  options: 'options.html',
  library: 'library.html',
}

export function createWindows({ desktopDir, userDataDir, logger = () => {} }) {
  const appDir = join(desktopDir, 'app')
  const vendorDir = join(desktopDir, 'vendor', 'src')
  const preloadPath = join(desktopDir, 'src', 'preload.cjs')
  const boundsFile = join(userDataDir, 'window-bounds.json')
  const aux = new Map()
  let main = null
  let mainReady = null
  let isQuitting = false
  let alwaysOnTop = false
  let tray = null

  function loadBounds() {
    try {
      if (!existsSync(boundsFile)) return null
      const value = JSON.parse(readFileSync(boundsFile, 'utf8'))
      return Number.isFinite(value?.width) && Number.isFinite(value?.height) ? value : null
    } catch {
      return null
    }
  }

  function saveBounds(win) {
    if (!win || win.isDestroyed()) return
    try {
      writeFileSync(boundsFile, JSON.stringify(win.getBounds()))
    } catch {
      // bounds persistence is best effort
    }
  }

  function allWindows() {
    return [main, ...aux.values()].filter((win) => win && !win.isDestroyed())
  }

  function broadcast(channel, payload) {
    for (const win of allWindows()) win.webContents.send(channel, payload)
  }

  function sendToWindow(windowId, channel, payload) {
    const win = allWindows().find((item) => item.id === windowId)
    if (win) win.webContents.send(channel, payload)
  }

  function senderFor(webContents) {
    const win = BrowserWindow.fromWebContents(webContents)
    if (!win) return { tab: { id: 0 }, frameId: 0, url: '', documentId: '' }
    if (win === main) {
      return { tab: { id: win.id }, frameId: 0, url: 'app://local/index.html', documentId: 'main' }
    }
    const name = [...aux.entries()].find(([, value]) => value === win)?.[0] || 'settings'
    return {
      tab: { id: win.id },
      frameId: 0,
      url: `app://local/src/${AUX_FILES[name] || 'popup.html'}`,
      documentId: name,
    }
  }

  function ensureMainWindow() {
    if (main && !main.isDestroyed()) return main
    const saved = loadBounds()
    main = new BrowserWindow({
      width: saved?.width || 920,
      height: saved?.height || 720,
      ...(Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? { x: saved.x, y: saved.y } : {}),
      minWidth: 560,
      minHeight: 480,
      title: 'Selected Text Translator',
      backgroundColor: '#f7f8f6',
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    mainReady = new Promise((resolve) => {
      main.webContents.once('did-finish-load', resolve)
    })
    main.setAlwaysOnTop(alwaysOnTop, 'floating')
    main.loadFile(join(appDir, 'index.html'))
    main.on('close', (event) => {
      saveBounds(main)
      if (!isQuitting) {
        event.preventDefault()
        main.hide()
      }
    })
    main.on('closed', () => {
      main = null
      mainReady = null
    })
    return main
  }

  async function showMainWindow(payload) {
    const win = ensureMainWindow()
    await mainReady
    if (win.isDestroyed()) return
    if (!win.isVisible()) win.show()
    win.focus()
    win.webContents.send('stt:selection', payload || {})
  }

  function hideMainWindow() {
    if (main && !main.isDestroyed()) main.hide()
  }

  function setAlwaysOnTop(flag) {
    alwaysOnTop = Boolean(flag)
    if (main && !main.isDestroyed()) main.setAlwaysOnTop(alwaysOnTop, 'floating')
  }

  function toggleMainWindow() {
    if (!main || main.isDestroyed() || !main.isVisible()) void showMainWindow({ text: '', source: 'tray' })
    else main.hide()
  }

  function open(name) {
    const key = AUX_FILES[name] ? name : 'settings'
    const existing = aux.get(key)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return existing
    }
    const win = new BrowserWindow({
      width: key === 'library' ? 960 : 500,
      height: key === 'library' ? 720 : 660,
      title: key === 'library' ? '我的表达本' : key === 'options' ? '高级设置' : '设置',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    win.loadFile(join(vendorDir, AUX_FILES[key]))
    aux.set(key, win)
    win.on('closed', () => aux.delete(key))
    return win
  }

  function createTray({ onTrigger, onQuit, hotkeyOptions, onHotkeyChange, currentHotkey, onOpenLog }) {
    let image = nativeImage.createFromPath(join(desktopDir, 'vendor', 'assets', 'icon128.png'))
    if (image.isEmpty()) image = nativeImage.createEmpty()
    if (process.platform === 'darwin' && !image.isEmpty()) image = image.resize({ width: 18, height: 18 })
    tray = new Tray(image)
    if (process.platform !== 'darwin') tray.on('click', toggleMainWindow)

    const hotkeyMenu = hotkeyOptions.map((option) => ({
      label: option,
      type: 'radio',
      checked: option === currentHotkey(),
      click: () => onHotkeyChange(option),
    }))

    tray.setToolTip('Selected Text Translator')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => void showMainWindow({ text: '', source: 'tray' }) },
      { label: '查词 / 翻译', click: onTrigger },
      { type: 'separator' },
      { label: '设置', click: () => open('settings') },
      { label: '高级设置', click: () => open('options') },
      { label: '我的表达本', click: () => open('library') },
      { type: 'separator' },
      { label: '快捷键', submenu: hotkeyMenu },
      { label: '打开日志', click: onOpenLog },
      { type: 'separator' },
      { label: '退出', click: onQuit },
    ]))
  }

  return {
    broadcast,
    sendToWindow,
    senderFor,
    showMainWindow,
    hideMainWindow,
    toggleMainWindow,
    setAlwaysOnTop,
    getAlwaysOnTop: () => alwaysOnTop,
    open,
    createTray,
    notifyStatus: (payload) => broadcast('stt:status', payload),
    mainId: () => (main && !main.isDestroyed() ? main.id : 0),
    setQuitting: () => {
      isQuitting = true
    },
    logger,
  }
}
