import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStorage } from '../src/storage.js'
import { installMainChrome } from '../src/chrome-shim-main.js'
import { createCapture } from '../src/capture.js'
import { shouldShowMainWindow } from '../src/hotkey-route.js'
import { verifyTranslationRequestScopes } from './translation-scope-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const vendorDir = join(desktopDir, 'vendor', 'src')
const userDataDir = mkdtempSync(join(tmpdir(), 'stt-smoke-'))

const sent = []
const windows = {
  broadcast: () => {},
  sendToWindow: (id, channel, payload) => sent.push({ id, channel, payload }),
  open: () => {},
  mainId: () => 7,
}
const tts = { getVoices: async () => [], speak: () => {}, stop: () => {} }

const storage = createStorage(userDataDir)
const { chrome, dispatch } = installMainChrome({ storage, windows, tts, logger: () => {} })

assert.equal(chrome.runtime.lastError, undefined)
assert.equal(chrome.runtime.getURL('src/library.html'), 'app://local/src/library.html')

let seen = null
chrome.storage.onChanged.addListener((changes, areaName) => {
  seen = { changes, areaName }
})
await chrome.storage.sync.set({ reading_mode: 'guide' })
assert.equal(seen.areaName, 'sync')
assert.equal(seen.changes.reading_mode.newValue, 'guide')
assert.deepEqual(await chrome.storage.sync.get(['reading_mode']), { reading_mode: 'guide' })
assert.deepEqual(await chrome.storage.sync.get(['missing']), {})

await import(pathToFileURL(join(vendorDir, 'background.js')).href)

const sender = { tab: { id: 7 }, frameId: 0, url: 'app://local/card.html', documentId: 'card' }
const reply = await dispatch({
  type: 'START_TRANSLATION',
  payload: {
    selectionId: 'smoke-1',
    requestId: 'req-1',
    text: 'hello',
    kind: 'translate',
    context: '',
    contextStart: null,
    contextEnd: null,
  },
}, sender)
assert.deepEqual(reply, { accepted: true })

await new Promise((resolve) => setTimeout(resolve, 80))
const statuses = sent
  .filter((item) => item.channel === 'stt:message' && item.payload?.type === 'TRANSLATION_EVENT')
  .map((item) => item.payload?.payload?.status)
assert.ok(statuses.includes('missing-configuration'), `unexpected events: ${JSON.stringify(statuses)}`)

let clipboardText = '  clipboard word  '
const capture = createCapture({
  clipboard: {
    readText: () => clipboardText,
    writeText: (value) => {
      clipboardText = value
    },
  },
  run: async () => false,
  delay: async () => {},
})
const result = await capture.capture()
assert.equal(result.text, '')
assert.equal(result.source, 'error')
assert.equal(clipboardText, '  clipboard word  ')

// Electron 45 returns a Promise from clipboard.readText(); capture must await it.
const asyncClipboard = createCapture({
  clipboard: {
    readText: async () => '  async clipboard sentence  ',
    writeText: async (value) => {
      clipboardText = value
    },
  },
  run: async () => true,
  delay: async () => {},
})
const asyncResult = await asyncClipboard.capture()
assert.equal(asyncResult.text, 'async clipboard sentence')
assert.equal(typeof asyncResult.text, 'string')
assert.ok(!(asyncResult.text instanceof Promise), 'capture text must never be a Promise')

let selectionClipboard = 'STALE CLIPBOARD CONTENT'
const selectionCapture = createCapture({
  clipboard: {
    readText: () => selectionClipboard,
    writeText: (value) => {
      selectionClipboard = value
    },
  },
  run: async () => {
    selectionClipboard = 'SELECTED TEXT FROM APP'
    return true
  },
  delay: async () => {},
})
const selectionResult = await selectionCapture.capture()
assert.equal(selectionResult.text, 'SELECTED TEXT FROM APP')
assert.equal(selectionResult.source, 'simulated-copy')
assert.equal(selectionClipboard, 'STALE CLIPBOARD CONTENT')

selectionCapture.setMode('clipboard')
const clipboardOnly = await selectionCapture.capture()
assert.equal(clipboardOnly.text, 'STALE CLIPBOARD CONTENT')
assert.equal(clipboardOnly.source, 'clipboard-only')

assert.equal(shouldShowMainWindow({ text: 'hello' }, false), false)
assert.equal(shouldShowMainWindow({ text: 'hello' }, true), true)
assert.equal(shouldShowMainWindow({ text: '' }, false), true)
assert.equal(shouldShowMainWindow({ text: '   ' }, false), true)
assert.equal(shouldShowMainWindow({}, false), true)

await verifyTranslationRequestScopes()

rmSync(userDataDir, { recursive: true, force: true })
console.log('[smoke] ok - storage, chrome shim, background message chain, capture fallback, article request isolation')
