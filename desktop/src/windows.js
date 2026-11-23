import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Menu, Tray, globalShortcut, screen } from 'electron'
import { loadDesktopIcons } from './icons.js'

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
const MAIN_ZOOM_FACTORS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5]

function bindDeveloperTools(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat) return
    const f12 = input.key === 'F12' && !input.control && !input.meta && !input.alt && !input.shift
    const inspect = input.key.toLowerCase() === 'i' && (process.platform === 'darwin'
      ? input.meta && input.alt && !input.control && !input.shift
      : input.control && input.shift && !input.meta && !input.alt)
    if (!f12 && !inspect) return
    event.preventDefault()
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'detach', activate: false })
  })
}

function bindMainZoom(contents, getFactor, setFactor) {
  contents.setZoomMode('isolated')
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || input.alt) return
    const modifier = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
    if (!modifier) return

    const current = getFactor()
    let next
    if (input.key === '+' || input.key === '=') next = MAIN_ZOOM_FACTORS.find((factor) => factor > current)
    else if (input.key === '-') next = MAIN_ZOOM_FACTORS.findLast((factor) => factor < current)
    else if (input.key === '0') next = 1
    else return

    event.preventDefault()
    if (next !== undefined) setFactor(next)
  })
}

function cardHeightLimit(workArea) {
  return Math.max(CARD_MIN_HEIGHT, Math.min(CARD_MAX_HEIGHT, workArea.height - 2 * CARD_MARGIN))
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function createWindows({ desktopDir, userDataDir, initialZoom, saveZoom, logger = () => {} }) {
  const appDir = join(desktopDir, 'app')
  const assetsDir = join(desktopDir, 'assets')
  const { appIcon, trayIcon } = loadDesktopIcons(assetsDir)
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
  let windowBackground = '#ffffff'
  let tray = null
  let mainZoom = MAIN_ZOOM_FACTORS.includes(initialZoom) ? initialZoom : 1

  function getMainZoom() {
    return { factor: mainZoom, factors: MAIN_ZOOM_FACTORS }
  }

  function setMainZoom(factor) {
    if (MAIN_ZOOM_FACTORS.includes(factor) && factor !== mainZoom) {
      mainZoom = factor
      main.webContents.setZoomFactor(factor)
      main.webContents.send('stt:main-zoom-changed', factor)
      void saveZoom(factor).catch((error) => logger('save-zoom-failed', error))
    }
    return mainZoom
  }

  function createWindow(options) {
    const win = new BrowserWindow({ ...options, icon: appIcon })
    if (process.platform === 'win32' || process.platform === 'linux') win.removeMenu()
    bindDeveloperTools(win.webContents)
    return win
  }

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
    main = createWindow({
      width: saved?.width || 920,
      height: saved?.height || 720,
      ...(Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? { x: saved.x, y: saved.y } : {}),
      minWidth: 560,
      minHeight: 480,
      title: 'Selected Text Translator',
      backgroundColor: windowBackground,
      show: false,
      webPreferences: {
        zoomFactor: mainZoom,
        preload: preloadPath,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    mainReady = new Promise((resolve) => {
      main.webContents.once('did-finish-load', () => {
        main.webContents.setZoomFactor(mainZoom)
        resolve()
      })
    })
    bindMainZoom(main.webContents, () => mainZoom, setMainZoom)
    // Article links are opened through the reading IPC, never in the app page.
    main.webContents.on('will-navigate', (event) => event.preventDefault())
    main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
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

  async function showMainWindow(payload = { text: '', source: 'app' }) {
    const win = ensureMainWindow()
    await mainReady
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    win.webContents.send('stt:selection', payload)
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
    card = createWindow({
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
      title: 'Selection Translation',
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
    windowBackground = isDark ? '#212121' : '#ffffff'
    if (main && !main.isDestroyed()) main.setBackgroundColor(windowBackground)
  }

  function setAlwaysOnTop(flag) {
    alwaysOnTop = Boolean(flag)
    if (main && !main.isDestroyed()) main.setAlwaysOnTop(alwaysOnTop, 'floating')
  }

  function open(name) {
    const key = AUX_FILES[name] ? name : 'settings'
    const existing = aux.get(key)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return existing
    }
    const win = createWindow({
      width: key === 'library' ? 960 : 500,
      height: key === 'library' ? 720 : 660,
      title: key === 'library' ? 'Vocabulary' : key === 'options' ? 'Advanced Settings' : 'Settings',
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

  function createTray({ onQuit, onOpenLog }) {
    tray = new Tray(trayIcon)
    const openMainWindow = () => void showMainWindow()
    if (process.platform !== 'darwin') tray.on('click', openMainWindow)

    tray.setToolTip('Selected Text Translator')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Main Window', click: openMainWindow },
      { type: 'separator' },
      { label: 'Settings', click: () => open('settings') },
      { label: 'Advanced Settings', click: () => open('options') },
      { label: 'Vocabulary', click: () => open('library') },
      { type: 'separator' },
      { label: 'Open Log', click: onOpenLog },
      { label: 'Open Developer Tools', click: async () => {
        await showMainWindow()
        if (main && !main.isDestroyed()) main.webContents.openDevTools({ mode: 'detach' })
      } },
      { type: 'separator' },
      { label: 'Quit', click: onQuit },
    ]))
  }

  return {
    broadcast,
    sendToWindow,
    sendToMainWindow,
    senderFor,
    showMainWindow,
    hideMainWindow,
    showCardWindow,
    hideCardWindow,
    resizeCardWindow,
    cardMetrics,
    setCardPinned,
    setAlwaysOnTop,
    setTheme,
    getMainZoom,
    setMainZoom,
    getAlwaysOnTop: () => alwaysOnTop,
    open,
    createTray,
    mainId: () => (main && !main.isDestroyed() ? main.id : 0),
    setQuitting: () => {
      isQuitting = true
    },
    logger,
  }
}
