import { BrowserWindow, Menu, Tray, nativeImage, screen } from 'electron'
import { join } from 'node:path'

const AUX_FILES = {
  settings: 'popup.html',
  options: 'options.html',
  library: 'library.html',
}

export function createWindows({ desktopDir, logger = () => {} }) {
  const appDir = join(desktopDir, 'app')
  const vendorDir = join(desktopDir, 'vendor', 'src')
  const preloadPath = join(desktopDir, 'src', 'preload.cjs')
  const aux = new Map()
  let card = null
  let cardReady = null
  let tray = null

  function allWindows() {
    return [card, ...aux.values()].filter((win) => win && !win.isDestroyed())
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
    if (win === card) {
      return { tab: { id: win.id }, frameId: 0, url: 'app://local/card.html', documentId: 'card' }
    }
    const name = [...aux.entries()].find(([, value]) => value === win)?.[0] || 'settings'
    return {
      tab: { id: win.id },
      frameId: 0,
      url: `app://local/src/${AUX_FILES[name] || 'popup.html'}`,
      documentId: name,
    }
  }

  function ensureCard() {
    if (card && !card.isDestroyed()) return card
    card = new BrowserWindow({
      width: 440,
      height: 620,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    card.setAlwaysOnTop(true, 'floating')
    card.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    cardReady = new Promise((resolve) => {
      card.webContents.once('did-finish-load', resolve)
    })
    card.loadFile(join(appDir, 'card.html'))
    card.on('closed', () => {
      card = null
      cardReady = null
    })
    return card
  }

  function positionCard(win) {
    const point = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    const [width, height] = win.getSize()
    const x = Math.min(Math.max(point.x + 16, area.x), Math.max(area.x, area.x + area.width - width))
    const y = Math.min(Math.max(point.y + 16, area.y), Math.max(area.y, area.y + area.height - height))
    win.setPosition(Math.round(x), Math.round(y))
  }

  async function showCard(payload) {
    const win = ensureCard()
    await cardReady
    if (win.isDestroyed()) return
    positionCard(win)
    win.showInactive()
    win.webContents.send('stt:selection', payload)
  }

  function hideCard() {
    if (card && !card.isDestroyed()) card.hide()
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

  function createTray({ onTrigger, onQuit, hotkeyOptions, onHotkeyChange, currentHotkey }) {
    let image = nativeImage.createFromPath(join(desktopDir, 'vendor', 'assets', 'icon128.png'))
    if (image.isEmpty()) image = nativeImage.createEmpty()
    if (process.platform === 'darwin' && !image.isEmpty()) image = image.resize({ width: 18, height: 18 })
    tray = new Tray(image)

    const hotkeyMenu = hotkeyOptions.map((option) => ({
      label: option,
      type: 'radio',
      checked: option === currentHotkey(),
      click: () => onHotkeyChange(option),
    }))

    tray.setToolTip('Selected Text Translator')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '查词 / 翻译', click: onTrigger },
      { type: 'separator' },
      { label: '设置', click: () => open('settings') },
      { label: '高级设置', click: () => open('options') },
      { label: '我的表达本', click: () => open('library') },
      { type: 'separator' },
      { label: '快捷键', submenu: hotkeyMenu },
      { type: 'separator' },
      { label: '退出', click: onQuit },
    ]))
  }

  return {
    broadcast,
    sendToWindow,
    senderFor,
    showCard,
    hideCard,
    open,
    createTray,
    cardId: () => (card && !card.isDestroyed() ? card.id : 0),
    logger,
  }
}
