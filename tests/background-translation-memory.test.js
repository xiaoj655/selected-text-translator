import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'

function createHarness({ sharedLocal = null, model = 'qwen-mt-flash' } = {}) {
  const previous = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    ServiceWorkerGlobalScope: globalThis.ServiceWorkerGlobalScope,
  }
  globalThis.ServiceWorkerGlobalScope = class ServiceWorkerGlobalScope {}
  const listeners = []
  const events = []
  const requests = []
  const localData = sharedLocal || {}
  let sendResponse = null

  globalThis.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { listeners.push(fn) } },
    },
    storage: {
      onChanged: { addListener() {} },
      sync: {
        async get() {
          return {
            base_url: 'https://api.example.com/v1',
            api_key: 'test-token',
            model,
          }
        },
      },
      local: {
        async get(key) {
          return { [key]: localData[key] }
        },
        async set(values) {
          Object.assign(localData, values)
        },
      },
    },
    tabs: {
      sendMessage(tabId, event, options, done) {
        events.push({ tabId, ...event, options })
        done()
      },
    },
  }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) })
    return new Response('data: {"choices":[{"delta":{"content":"唱片"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  return {
    events,
    requests,
    localData,
    async boot() {
      sendResponse = null
      await import(`../src/background.js?mem=${Math.random()}`)
    },
    send(text, requestId, forceRefresh = false) {
      const message = {
        type: 'START_TRANSLATION',
        payload: { selectionId: `selection-${requestId}`, requestId, text, kind: 'translate', forceRefresh },
      }
      for (const listener of listeners) {
        const result = listener(message, { tab: { id: 7 }, frameId: 3 }, (response) => { sendResponse = response })
        if (result === true) break
      }
      return sendResponse
    },
    async waitFor(predicate) {
      for (let i = 0; i < 500; i += 1) {
        if (predicate()) return
        await wait(2)
      }
      assert.fail('Expected background event was not emitted')
    },
    restore() {
      globalThis.chrome = previous.chrome
      globalThis.fetch = previous.fetch
      globalThis.ServiceWorkerGlobalScope = previous.ServiceWorkerGlobalScope
    },
  }
}

test('background translation memory serves a repeat selection without a new API request', async () => {
  const harness = createHarness()
  try {
    await harness.boot()
    const first = harness.send('memory-repeat-alpha', 'r1')
    assert.equal(first.accepted, true)
    await harness.waitFor(() => harness.events.some((event) => event.payload.status === 'success'))
    assert.equal(harness.requests.length, 1)
    assert.ok(Object.keys(harness.localData.translation_memory || {}).length >= 1)

    harness.send('memory-repeat-alpha', 'r2')
    await harness.waitFor(() => harness.events.some((event) => event.payload.requestId === 'r2'
      && event.payload.status === 'success'))
    assert.equal(harness.requests.length, 1, 'memory hit must not call the API again')
    const hit = harness.events.find((event) => event.payload.requestId === 'r2' && event.payload.status === 'success')
    assert.equal(hit.payload.fromMemory, true)
    assert.equal(hit.payload.translatedText, '唱片')
  } finally {
    harness.restore()
  }
})

test('background translation memory survives a service worker restart', async () => {
  const firstWorker = createHarness()
  try {
    await firstWorker.boot()
    firstWorker.send('memory-restart-alpha', 'r1')
    await firstWorker.waitFor(() => firstWorker.events.some((event) => event.payload.status === 'success'))
    assert.equal(firstWorker.requests.length, 1)
  } finally {
    firstWorker.restore()
  }

  const secondWorker = createHarness({ sharedLocal: firstWorker.localData })
  try {
    await secondWorker.boot()
    secondWorker.send('memory-restart-alpha', 'r2')
    await secondWorker.waitFor(() => secondWorker.events.some((event) => event.payload.status === 'success'))
    assert.equal(secondWorker.requests.length, 0, 'persisted memory should answer without a fresh worker fetching')
    const hit = secondWorker.events.find((event) => event.payload.status === 'success')
    assert.equal(hit.payload.fromMemory, true)
  } finally {
    secondWorker.restore()
  }
})

test('background forceRefresh bypasses translation memory', async () => {
  const harness = createHarness()
  try {
    await harness.boot()
    harness.send('memory-refresh-alpha', 'r1')
    await harness.waitFor(() => harness.events.some((event) => event.payload.requestId === 'r1'
      && event.payload.status === 'success'))
    assert.equal(harness.requests.length, 1)

    harness.send('memory-refresh-alpha', 'r2', true)
    await harness.waitFor(() => harness.events.some((event) => event.payload.requestId === 'r2'
      && event.payload.status === 'success'))
    assert.equal(harness.requests.length, 2, 'force refresh should reach the API')
    const fresh = harness.events.find((event) => event.payload.requestId === 'r2' && event.payload.status === 'success')
    assert.notEqual(fresh.payload.fromMemory, true)
  } finally {
    harness.restore()
  }
})
