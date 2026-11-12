import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'

const guide = { hints: ['Look at her reaction.', 'Is she eager?', 'Something holds her back.'],
  answer: { meaning: 'Hesitant.', explanation: 'She has doubts.', example: 'I was reluctant to leave.' } }

async function withBackground({ fetchImpl, storageFailure = false, learningModel = 'generic' } = {}, callback) {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch }
  const listeners = []
  const events = []
  const requests = []
  globalThis.chrome = {
    runtime: { lastError: null, onMessage: { addListener(fn) { listeners.push(fn) } } },
    storage: { onChanged: { addListener() {} }, sync: { async get(keys) {
      if (storageFailure && keys.includes('base_url')) throw new Error('Storage unavailable')
      return { base_url: 'https://api.example.com/v1', api_key: 'test-token', model: 'qwen-mt-flash',
        learning_model: learningModel }
    } } },
    tabs: { sendMessage(tabId, event, options, done) { events.push({ tabId, ...event, options }); done() } },
  }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) })
    return fetchImpl ? fetchImpl(url, options) : Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] })
  }
  try {
    await import(`../src/background.js?test=${Math.random()}`)
    const send = (payload, type = 'START_TRANSLATION') => {
      for (const listener of listeners) listener({ type, payload }, { tab: { id: 7 }, frameId: 3 }, () => {})
    }
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await setImmediate() }
      assert.fail('Expected background event was not emitted')
    }
    await callback({ send, waitFor, events, requests })
  } finally {
    globalThis.chrome = previous.chrome
    globalThis.fetch = previous.fetch
  }
}

const payload = { selectionId: 'selection', requestId: 'request', text: 'reluctant',
  context: 'She was reluctant to accept the offer.', kind: 'guide' }

test('background sends contextual guide through the learning model and routes to the originating frame', async () => {
  await withBackground({}, async ({ send, waitFor, events, requests }) => {
    send(payload)
    await waitFor(() => events.some((event) => event.payload.status === 'success'))
    assert.equal(requests[0].body.model, 'generic')
    assert.equal(JSON.parse(requests[0].body.messages[1].content).surroundingContext, payload.context)
    assert.deepEqual(events.at(-1).payload.result, { phonetic: '', ...guide })
    assert.deepEqual(events.at(-1).options, { frameId: 3 })
  })
})

test('qwen-mt alone prompts for a learning model without sending an unsupported request', async () => {
  await withBackground({ learningModel: '' }, async ({ send, waitFor, events, requests }) => {
    send(payload)
    await waitFor(() => events.length)
    assert.equal(events[0].payload.status, 'missing-configuration')
    assert.equal(requests.length, 0)
  })
})

test('storage read failure emits a visible terminal error', async () => {
  await withBackground({ storageFailure: true }, async ({ send, waitFor, events }) => {
    send(payload)
    await waitFor(() => events.length)
    assert.equal(events[0].payload.status, 'error')
    assert.match(events[0].payload.message, /Storage unavailable/)
  })
})

test('qwen SSE parser retains the last event even without a trailing newline', async () => {
  await withBackground({ fetchImpl: () => new Response('data: {"choices":[{"delta":{"content":"你好"}}]}') },
    async ({ send, waitFor, events }) => {
      send({ ...payload, kind: 'translate' })
      await waitFor(() => events.some((event) => event.payload.status === 'success'))
      assert.equal(events.at(-1).payload.translatedText, '你好')
    })
})

test('superseding a request aborts the old fetch and suppresses stale errors', async () => {
  let firstSignal
  await withBackground({ fetchImpl(url, options) {
    if (!firstSignal) {
      firstSignal = options.signal
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] })
  } }, async ({ send, waitFor, events, requests }) => {
    send(payload)
    await waitFor(() => requests.length === 1)
    send({ ...payload, requestId: 'new-request' })
    await waitFor(() => events.some((event) => event.payload.status === 'success'))
    assert.equal(firstSignal.aborted, true)
    assert.equal(events.filter((event) => event.payload.status === 'error').length, 0)
    assert.equal(events.at(-1).payload.requestId, 'new-request')
  })
})

test('HTTP errors do not expose response bodies containing credentials', async () => {
  await withBackground({ fetchImpl: () => new Response('secret echoed by upstream', { status: 401 }) },
    async ({ send, waitFor, events }) => {
      send(payload)
      await waitFor(() => events.some((event) => event.payload.status === 'error'))
      assert.doesNotMatch(events.at(-1).payload.message, /secret/)
      assert.match(events.at(-1).payload.message, /401/)
    })
})
