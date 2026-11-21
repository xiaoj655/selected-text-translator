const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, Tray } = require('electron')

app.setPath('userData', process.env.STT_ICON_USER_DATA_DIR)
app.setPath('sessionData', process.env.STT_ICON_USER_DATA_DIR)
app.on('window-all-closed', (event) => event.preventDefault())

function expectedSize(assetsDir, filename) {
  const png = readFileSync(join(assetsDir, filename))
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filename}: invalid PNG signature`)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function inspectImage(image, expected, label) {
  assert.ok(image && !image.isEmpty(), `${label}: image must not be empty`)
  const size = image.getSize(1)
  assert.deepEqual(size, expected, `${label}: image dimensions must match the expected icon`)
  const bitmap = image.toBitmap({ scaleFactor: 1 })
  assert.equal(bitmap.length, size.width * size.height * 4, `${label}: incomplete bitmap`)
  let visiblePixels = 0
  for (let offset = 3; offset < bitmap.length; offset += 4) {
    if (bitmap[offset] > 0) visiblePixels += 1
  }
  assert.ok(visiblePixels > 0, `${label}: icon must contain visible pixels`)
  return { size, bitmap }
}

async function inspectDirectory(desktopDir, label) {
  const assetsDir = join(desktopDir, 'assets')
  const { loadDesktopIcons } = await import(pathToFileURL(join(desktopDir, 'src', 'icons.js')).href)
  const { appIcon, trayIcon } = loadDesktopIcons(assetsDir)
  const images = { app: appIcon, tray: trayIcon }
  const sizes = {
    app: expectedSize(assetsDir, 'icon.png'),
    tray: process.platform === 'darwin'
      ? expectedSize(assetsDir, 'trayTemplate.png')
      : { width: 32, height: 32 },
  }
  const inspected = {}
  for (const [name, image] of Object.entries(images)) {
    inspected[name] = inspectImage(image, sizes[name], `${label} ${name}`)
    writeFileSync(join(process.env.STT_ICON_ARTIFACTS_DIR, `${label}-${name}.png`),
      image.toPNG({ scaleFactor: 1 }))
  }
  let window
  let tray
  try {
    window = new BrowserWindow({ show: false, icon: appIcon, webPreferences: { sandbox: true } })
    tray = new Tray(trayIcon)
    assert.equal(window.isDestroyed(), false, `${label}: native window must accept the icon`)
    assert.equal(tray.isDestroyed(), false, `${label}: native tray must accept the icon`)
  } finally {
    tray?.destroy()
    window?.destroy()
  }
  return inspected
}

app.whenReady().then(async () => {
  assert.ok(app.getAppPath().endsWith('.asar'), 'verification must run from a packaged ASAR app')
  const source = await inspectDirectory(process.env.STT_ICON_SOURCE_DIR, 'source')
  const packaged = await inspectDirectory(app.getAppPath(), 'asar')
  for (const name of ['app', 'tray']) {
    assert.deepEqual(packaged[name].size, source[name].size, `${name}: ASAR dimensions differ from source`)
    assert.deepEqual(packaged[name].bitmap, source[name].bitmap, `${name}: ASAR pixels differ from source`)
  }
  app.exit(0)
}).catch((error) => {
  console.error('[icons] FAIL', error)
  app.exit(1)
})
