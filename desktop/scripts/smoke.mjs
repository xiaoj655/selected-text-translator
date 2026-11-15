import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStorage } from '../src/storage.js'
import { installMainChrome } from '../src/chrome-shim-main.js'
import { createCapture } from '../src/capture.js'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const vendorDir = join(desktopDir, 'vendor', 'src')
const userDataDir = mkdtempSync(join(tmpdir(), 'stt-smoke-'))

const sent = []
const windows = {
  broadcast: () => {},
  sendToWindow: (id, channel, payload) => sent.push({ id, channel, payload }),
  open: () => {},
  cardId: () => 7,
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
assert.equal(result.text, 'clipboard word')
assert.equal(result.source, 'clipboard')
assert.equal(clipboardText, '  clipboard word  ')

rmSync(userDataDir, { recursive: true, force: true })
console.log('[smoke] ok - storage, chrome shim, background message chain, capture fallback')
