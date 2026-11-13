import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'

const guide = { hints: ['Look at her reaction.', 'Is she eager?', 'Something holds her back.'],
  answer: { meaning: 'Hesitant.', explanation: 'She has doubts.', example: 'I was reluctant to leave.' } }

async function withBackground({ fetchImpl, storageFailure = false, learningModel = 'generic' } = {}, callback) {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch }
  const listeners = []
  const events = []
  const requests = []
  const storageListeners = []
  const storage = { base_url: 'https://api.example.com/v1', api_key: 'test-token', model: 'qwen-mt-flash',
    learning_model: learningModel }
  globalThis.chrome = {
    runtime: { lastError: null, onMessage: { addListener(fn) { listeners.push(fn) } } },
    storage: { onChanged: { addListener(listener) { storageListeners.push(listener) } }, sync: { async get(keys) {
      if (storageFailure && keys.includes('base_url')) throw new Error('Storage unavailable')
      return { ...storage }
    } } },
    tabs: { sendMessage(tabId, event, options, done) { events.push({ tabId, ...event, options }); done() } },
  }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) })
    return fetchImpl ? fetchImpl(url, options) : Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] })
  }
  try {
    await import(`../src/background.js?test=${Math.random()}`)
    const send = (payload, type = 'START_TRANSLATION', tabId = 7) => {
      for (const listener of listeners) listener({ type, payload }, { tab: { id: tabId }, frameId: 3 }, () => {})
    }
    const waitFor = async (predicate) => {
      for (let i = 0; i < 500; i++) { if (predicate()) return; await wait(2) }
      assert.fail('Expected background event was not emitted')
    }
    const changeSettings = (values) => {
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]))
      Object.assign(storage, values)
      for (const listener of storageListeners) listener(changes, 'sync')
    }
    await callback({ send, waitFor, events, requests, changeSettings })
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


test('repeated completed guide requests reuse results with current tab and correlation IDs', async () => {
  await withBackground({}, async ({ send, waitFor, events, requests }) => {
    send(payload)
    await waitFor(() => events.some((event) => event.payload.status === 'success'))
    send({ ...payload, selectionId: 'another-selection', requestId: 'another-request' }, 'START_TRANSLATION', 12)
    await waitFor(() => events.some((event) => event.payload.requestId === 'another-request'))
    assert.equal(requests.length, 1)
    const replay = events.at(-1)
    assert.equal(replay.payload.status, 'success')
    assert.equal(replay.tabId, 12)
    assert.equal(replay.payload.requestId, 'another-request')
    assert.equal(replay.payload.selectionId, 'another-selection')
    assert.deepEqual(replay.payload.result, { phonetic: '', ...guide })
  })
})

test('context changes and explicit regeneration issue new provider requests', async () => {
  await withBackground({}, async ({ send, waitFor, events, requests }) => {
    for (const [requestId, extra] of [
      ['one', {}], ['two', { context: 'A different sentence.' }], ['three', { forceRefresh: true }],
    ]) {
      send({ ...payload, ...extra, requestId })
      await waitFor(() => events.some((event) => event.payload.requestId === requestId && event.payload.status === 'success'))
    }
    assert.equal(requests.length, 3)
    send({ ...payload, requestId: 'four' })
    await waitFor(() => events.some((event) => event.payload.requestId === 'four'))
    assert.equal(requests.length, 3)
  })
})

test('provider setting changes clear results while speech preferences do not invalidate them', async () => {
  await withBackground({}, async ({ send, waitFor, events, requests, changeSettings }) => {
    send({ ...payload, requestId: 'first' })
    await waitFor(() => events.some((event) => event.payload.status === 'success'))
    changeSettings({ model: 'another-translation-model' })
    send({ ...payload, requestId: 'after-change' })
    await waitFor(() => events.some((event) => event.payload.requestId === 'after-change' && event.payload.status === 'success'))
    assert.equal(requests.length, 2)
    changeSettings({ speech_rate: 1.2 })
    send({ ...payload, requestId: 'speech-only-change' })
    await waitFor(() => events.some((event) => event.payload.requestId === 'speech-only-change'))
    assert.equal(requests.length, 2)
  })
})

test('provider errors are never reused', async () => {
  let shouldFail = true
  await withBackground({ fetchImpl: () => shouldFail ? new Response('', { status: 503 })
    : Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] }) },
  async ({ send, waitFor, events, requests }) => {
    send({ ...payload, requestId: 'failed' })
    await waitFor(() => events.some((event) => event.payload.status === 'error'))
    shouldFail = false
    send({ ...payload, requestId: 'retry' })
    await waitFor(() => events.some((event) => event.payload.requestId === 'retry' && event.payload.status === 'success'))
    assert.equal(requests.length, 2)
  })
})


test('an in-flight result from an older settings epoch cannot repopulate cleared cache', async () => {
  let completeFirst
  let count = 0
  await withBackground({ fetchImpl: () => ++count === 1 ? new Promise((resolve) => { completeFirst = resolve })
    : Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] }) },
  async ({ send, waitFor, events, requests, changeSettings }) => {
    send({ ...payload, requestId: 'old-epoch' })
    await waitFor(() => requests.length === 1)
    changeSettings({ model: 'another-translator' })
    completeFirst(Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] }))
    await waitFor(() => events.some((event) => event.payload.requestId === 'old-epoch' && event.payload.status === 'success'))
    send({ ...payload, requestId: 'new-epoch' })
    await waitFor(() => events.some((event) => event.payload.requestId === 'new-epoch' && event.payload.status === 'success'))
    assert.equal(requests.length, 2)
  })
})

test('a late result in another tab cannot overwrite explicitly regenerated cache', async () => {
  let completeOld
  let count = 0
  const newerGuide = { ...guide, answer: { ...guide.answer, meaning: 'Freshly regenerated meaning.' } }
  await withBackground({ fetchImpl: () => ++count === 1 ? new Promise((resolve) => { completeOld = resolve })
    : Response.json({ choices: [{ message: { content: JSON.stringify(newerGuide) } }] }) },
  async ({ send, waitFor, events, requests }) => {
    send({ ...payload, requestId: 'old-tab' })
    await waitFor(() => requests.length === 1)
    send({ ...payload, requestId: 'force-tab', forceRefresh: true }, 'START_TRANSLATION', 12)
    await waitFor(() => events.some((event) => event.payload.requestId === 'force-tab' && event.payload.status === 'success'))
    completeOld(Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] }))
    await waitFor(() => events.some((event) => event.payload.requestId === 'old-tab' && event.payload.status === 'success'))
    send({ ...payload, requestId: 'later-tab' }, 'START_TRANSLATION', 13)
    await waitFor(() => events.some((event) => event.payload.requestId === 'later-tab'))
    assert.equal(requests.length, 2)
    assert.equal(events.at(-1).payload.result.answer.meaning, newerGuide.answer.meaning)
  })
})

test('a failed regeneration removes the old cache instead of silently replaying it', async () => {
  let count = 0
  await withBackground({ fetchImpl: () => ++count === 2 ? new Response('', { status: 503 })
    : Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] }) },
  async ({ send, waitFor, events, requests }) => {
    send({ ...payload, requestId: 'initial' })
    await waitFor(() => events.some((event) => event.payload.status === 'success'))
    send({ ...payload, requestId: 'force-failed', forceRefresh: true })
    await waitFor(() => events.some((event) => event.payload.requestId === 'force-failed' && event.payload.status === 'error'))
    send({ ...payload, requestId: 'following' })
    await waitFor(() => events.some((event) => event.payload.requestId === 'following' && event.payload.status === 'success'))
    assert.equal(requests.length, 3)
  })
})

test('cancelled requests cannot populate a reusable successful result', async () => {
  let count = 0
  await withBackground({ fetchImpl: (url, options) => ++count === 1
    ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
    : Response.json({ choices: [{ message: { content: JSON.stringify(guide) } }] }) },
  async ({ send, waitFor, events, requests }) => {
    send({ ...payload, requestId: 'cancel-me' })
    await waitFor(() => requests.length === 1)
    send({ requestId: 'cancel-me' }, 'CANCEL_TRANSLATION')
    send({ ...payload, requestId: 'after-cancel' })
    await waitFor(() => events.some((event) => event.payload.requestId === 'after-cancel' && event.payload.status === 'success'))
    assert.equal(requests.length, 2)
    assert.equal(events.filter((event) => event.payload.requestId === 'cancel-me' && event.payload.status === 'success').length, 0)
  })
})
