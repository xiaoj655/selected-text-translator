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

function attachErrorCollectors(win) {
  win.webContents.on('console-message', (...args) => {
    const details = args[1]
    const level = typeof details === 'object' && details !== null ? details.level : args[1]
    const message = typeof details === 'object' && details !== null ? details.message : args[2]
    const isError = typeof level === 'number' ? level >= 2 : level === 'error' || level === 'warning'
    if (isError) consoleErrors.push(String(message))
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    pageErrors.push(`render-process-gone: ${details.reason}`)
  })
}

function createWindow(width, height) {
  return new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      preload: join(root, 'scripts', 'electron-preload-stub.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  })
}

app.whenReady().then(async () => {
  const win = createWindow(1080, 780)
  attachErrorCollectors(win)

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

    const cardWin = createWindow(460, 360)
    attachErrorCollectors(cardWin)
    await cardWin.loadFile(join(appDir, 'card.html'))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await cardWin.webContents.executeJavaScript(
      'window.__fireSelection({ text: "The quick brown fox jumps over the lazy dog.", source: "simulated-copy", selectionId: "verify-s1", requestId: "verify-r1" })',
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 600))

    const cardProbe = await cardWin.webContents.executeJavaScript(`(() => {
      const result = document.getElementById('result')
      return {
        hasResult: Boolean(result),
        resultText: result ? (result.innerText || '') : '',
        hasPrimaryAction: Boolean(document.querySelector('.actions button.is-primary')),
        hasMoreAction: Boolean(document.querySelector('.actions .action-more')),
        bodyText: (document.body.innerText || '').slice(0, 300),
      }
    })()`, true)

    console.log('[electron] cardProbe:', JSON.stringify(cardProbe, null, 2))

    assert.equal(cardProbe.hasResult, true, 'card result element must render')
    assert.ok(cardProbe.resultText.includes('敏捷的棕色狐狸'), 'real card.js must render translated text via the translation event flow')
    assert.equal(cardProbe.hasPrimaryAction, true, 'card primary copy action must render')
    assert.equal(cardProbe.hasMoreAction, true, 'card overflow action must render')

    assert.deepEqual(pageErrors, [], 'no renderer crashes (main + card)')
    assert.deepEqual(consoleErrors, [], 'no console errors (main + card)')

    console.log('[electron] ok - real Electron launched main + card (real card.js translation flow) from file:// with no errors')
    cardWin.close()
  } catch (error) {
    console.error('[electron] FAILED:', error.message)
    process.exitCode = 1
  } finally {
    win.close()
    app.quit()
  }
})
