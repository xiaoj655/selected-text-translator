import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Menu, Tray, globalShortcut, nativeImage, screen } from 'electron'

const AUX_FILES = {
  settings: 'popup.html',
  options: 'options.html',
  library: 'library.html',
  card: 'card.html',
}

const CARD_WIDTH = 380
const CARD_HEIGHT = 300
const CARD_MIN_HEIGHT = 120
const CARD_MAX_HEIGHT = 640
const CARD_MARGIN = 14

function cardHeightLimit(workArea) {
  return Math.max(CARD_MIN_HEIGHT, Math.min(CARD_MAX_HEIGHT, workArea.height - 2 * CARD_MARGIN))
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function createWindows({ desktopDir, userDataDir, logger = () => {} }) {
  const appDir = join(desktopDir, 'app')
  const vendorDir = join(desktopDir, 'vendor', 'src')
  const preloadPath = join(desktopDir, 'src', 'preload.cjs')
  const boundsFile = join(userDataDir, 'window-bounds.json')
  const aux = new Map()
  let main = null
  let mainReady = null
  let card = null
  let cardReady = null
  let pendingCardHeight = 0
  let isQuitting = false
  let alwaysOnTop = false
  let windowBackground = '#f7f8f6'
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
      backgroundColor: windowBackground,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: false,
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

  function positionCardWindow(win) {
    const point = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    const x = clamp(point.x + CARD_MARGIN, area.x, area.x + area.width - CARD_WIDTH)
    const y = clamp(point.y + CARD_MARGIN, area.y, area.y + area.height - CARD_HEIGHT)
    win.setBounds({ x, y, width: CARD_WIDTH, height: CARD_HEIGHT })
  }

  let escRegistered = false
  let cardPinned = false

  function setCardPinned(flag) {
    cardPinned = Boolean(flag)
    if (card && !card.isDestroyed()) {
      card.setAlwaysOnTop(true, cardPinned ? 'screen-saver' : 'floating')
    }
  }

  function registerCardEscape() {
    if (escRegistered) return
    try {
      escRegistered = globalShortcut.register('Escape', () => {
        if (card && !card.isDestroyed()) card.webContents.send('stt:card-escape')
      })
    } catch {
      escRegistered = false
    }
  }

  function unregisterCardEscape() {
    if (!escRegistered) return
    try {
      globalShortcut.unregister('Escape')
    } catch {
      // the shortcut may already be gone
    }
    escRegistered = false
  }

  function ensureCardWindow() {
    if (card && !card.isDestroyed()) return card
    card = new BrowserWindow({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      title: '划词翻译',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    if (process.platform === 'darwin') {
      card.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    card.setAlwaysOnTop(true, 'screen-saver')
    card.loadFile(join(appDir, 'card.html'))
    cardReady = new Promise((resolve) => {
      card.webContents.once('did-finish-load', resolve)
    })
    card.on('closed', () => {
      unregisterCardEscape()
      aux.delete('card')
      card = null
      cardReady = null
    })
    aux.set('card', card)
    return card
  }

  async function showCardWindow(payload) {
    const win = ensureCardWindow()
    await cardReady
    if (win.isDestroyed()) return
    cardPinned = false
    positionCardWindow(win)
    if (pendingCardHeight) {
      applyCardHeight(pendingCardHeight)
      pendingCardHeight = 0
    }
    win.showInactive()
    registerCardEscape()
    win.webContents.send('stt:selection', payload || {})
  }

  function hideCardWindow() {
    cancelCardSpeech()
    unregisterCardEscape()
    if (card && !card.isDestroyed()) card.hide()
  }

  function applyCardHeight(next) {
    const bounds = card.getBounds()
    if (Math.abs(bounds.height - next) < 4) return
    const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
    const y = clamp(bounds.y, area.y, area.y + area.height - next)
    card.setBounds({ x: bounds.x, y, width: CARD_WIDTH, height: next })
  }

  function resizeCardWindow(height) {
    if (!card || card.isDestroyed()) return
    const bounds = card.getBounds()
    const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
    const next = clamp(Math.round(Number(height) || 0), CARD_MIN_HEIGHT, cardHeightLimit(area))
    if (!card.isVisible()) {
      pendingCardHeight = next
      return
    }
    applyCardHeight(next)
  }

  function cardMetrics() {
    if (!card || card.isDestroyed()) return null
    const bounds = card.getBounds()
    return {
      bounds,
      visible: card.isVisible(),
      workArea: screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea,
    }
  }

  function cancelCardSpeech() {
    if (card && !card.isDestroyed()) {
      card.webContents.send('stt:message', { type: 'CARD_HIDE' })
    }
  }

  function sendToMainWindow(channel, payload) {
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload)
  }

  function setTheme(isDark) {
    windowBackground = isDark ? '#1b211d' : '#f7f8f6'
    if (main && !main.isDestroyed()) main.setBackgroundColor(windowBackground)
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
        contextIsolation: false,
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
    sendToMainWindow,
    senderFor,
    ensureMainWindow,
    showMainWindow,
    hideMainWindow,
    showCardWindow,
    hideCardWindow,
    resizeCardWindow,
    cardMetrics,
    setCardPinned,
    toggleMainWindow,
    setAlwaysOnTop,
    setTheme,
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
