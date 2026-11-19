import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installMainChrome } from '../src/chrome-shim-main.js'
import { createStorage } from '../src/storage.js'

const userDataDir = mkdtempSync(join(tmpdir(), 'stt-smoke-'))
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 5000)

try {
  const events = new EventEmitter()
  const storage = createStorage(userDataDir)
  const { chrome, dispatch } = installMainChrome({
    storage,
    sendToTab: (id, message) => events.emit('message', id, message),
  })
  let change
  chrome.storage.onChanged.addListener((changes, areaName) => {
    change = { changes, areaName }
  })
  await chrome.storage.sync.set({ model: 'translator-smoke' })
  assert.equal(change.areaName, 'sync')
  assert.equal(change.changes.model.newValue, 'translator-smoke')
  assert.deepEqual(await chrome.storage.sync.get(['model', 'api_key']), { model: 'translator-smoke' })

  await import('../vendor/src/background.js')

  const [[id, message], reply] = await Promise.all([
    once(events, 'message', { signal: controller.signal }),
    Promise.resolve().then(() => dispatch({
      type: 'START_TRANSLATION',
      payload: { selectionId: 'smoke-1', requestId: 'req-1', text: 'hello' },
    }, { tab: { id: 7 }, frameId: 0 })),
  ])
  assert.deepEqual(reply, { accepted: true })
  assert.equal(id, 7)
  assert.equal(message.type, 'TRANSLATION_EVENT')
  assert.equal(message.payload.requestId, 'req-1')
  assert.equal(message.payload.status, 'missing-configuration')
} finally {
  clearTimeout(timeout)
  rmSync(userDataDir, { recursive: true, force: true })
}

console.log('[smoke] ok - storage changes and translation message flow')
