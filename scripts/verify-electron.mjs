import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { app, BrowserWindow } = require('electron')

const root = fileURLToPath(new URL('..', import.meta.url))
const appDir = join(root, 'desktop', 'app')

const pageErrors = []
const consoleErrors = []

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    show: false,
    webPreferences: {
      preload: join(root, 'scripts', 'electron-preload-stub.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  })

  win.webContents.on('console-message', (...args) => {
    const details = args[1]
    const level = typeof details === 'object' && details !== null ? details.level : args[1]
    const message = typeof details === 'object' && details !== null ? details.message : args[2]
    const isError = typeof level === 'number' ? level >= 2 : level === 'error' || level === 'warning'
    if (isError) consoleErrors.push(message)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    pageErrors.push(`render-process-gone: ${details.reason}`)
  })

  await win.loadFile(join(appDir, 'index.html'))
  await new Promise((resolve) => setTimeout(resolve, 1200))

  try {
    const probe = await win.webContents.executeJavaScript(`(() => {
      const stream = document.getElementById('stream')
      return {
        hasInput: Boolean(document.getElementById('input')),
        hasTopbar: Boolean(document.querySelector('.topbar')),
        hasStatusbar: Boolean(document.getElementById('statusbar')),
        entries: document.querySelectorAll('.entry').length,
        streamChildren: stream ? stream.children.length : -1,
        bodyText: (document.body.innerText || '').slice(0, 400),
        moduleRan: Boolean(document.querySelector('.entry') || document.querySelector('.empty')),
      }
    })()`, true)

    console.log('[electron] probe:', JSON.stringify(probe, null, 2))
    console.log('[electron] pageErrors:', JSON.stringify(pageErrors))
    console.log('[electron] consoleErrors:', JSON.stringify(consoleErrors))

    assert.equal(probe.hasInput, true, 'composer input must render')
    assert.equal(probe.hasTopbar, true, 'topbar must render')
    assert.equal(probe.hasStatusbar, true, 'statusbar must render')
    assert.equal(probe.moduleRan, true, 'app.js ES module must execute under file:// in real Electron')
    assert.equal(probe.entries >= 1, true, 'mock history entry must render as a card')
    assert.deepEqual(pageErrors, [], 'no renderer crashes')
    assert.deepEqual(consoleErrors, [], 'no console errors')

    console.log('[electron] ok - real Electron launched the v0.9.x UI from file:// with no errors')
  } catch (error) {
    console.error('[electron] FAILED:', error.message)
    process.exitCode = 1
  } finally {
    win.close()
    app.quit()
  }
})
