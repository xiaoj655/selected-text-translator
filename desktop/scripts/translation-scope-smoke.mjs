import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'
import { routeDesktopMessageSender } from '../src/message-sender.js'

export async function verifyTranslationRequestScopes() {
  const mainSender = { tab: { id: 7 }, frameId: 0, documentId: 'main', url: 'app://local/index.html' }
  const readingMessage = { type: 'START_TRANSLATION', payload: { requestScope: 'reading', frameId: 99 } }
  assert.equal(routeDesktopMessageSender(readingMessage, mainSender, true).frameId, 1)
  assert.equal(mainSender.frameId, 0, 'routing must not mutate the original sender')
  assert.throws(() => routeDesktopMessageSender(readingMessage, mainSender, false), /main window/u)
  assert.throws(() => routeDesktopMessageSender(readingMessage, { ...mainSender, documentId: 'card' }, true), /main window/u)
  for (const type of ['SPEAK_TEXT', 'STOP_SPEECH', 'VOCABULARY_SAVE', 'VOCABULARY_LIST']) {
    assert.equal(routeDesktopMessageSender({ type, payload: readingMessage.payload }, mainSender, true), mainSender,
      `${type} must retain its normal sender and ownership`)
  }
  for (const requestScope of [undefined, '', 'other', 99]) {
    assert.equal(routeDesktopMessageSender({ type: 'START_TRANSLATION', payload: { requestScope, frameId: 99 } },
      mainSender, true), mainSender, 'only the fixed reading scope may change routing')
  }

  const previousChrome = globalThis.chrome
  const listeners = []
  const events = []
  const requests = []
  const settings = { base_url: 'https://example.test/v1', api_key: 'local-fixture', model: 'scope-fixture' }
  const scopedChrome = {
    runtime: { lastError: undefined, onMessage: { addListener: (listener) => listeners.push(listener) } },
    storage: {
      onChanged: { addListener() {} },
      sync: { get: async () => settings },
      local: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
      sendMessage(_tabId, message, _options, callback) {
        if (message.type === 'TRANSLATION_EVENT') events.push(message.payload)
        callback?.()
      },
    },
    providerFetch: () => (_url, options) => new Promise((resolve, reject) => {
      const request = {
        signal: options.signal,
        text: JSON.parse(options.body).messages.at(-1).content,
        finish: (translation = 'fixture translation') => resolve(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ translation }) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      }
      requests.push(request)
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }),
  }
  globalThis.chrome = scopedChrome

  async function until(predicate, message) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate()) return
      await wait(2)
    }
    assert.fail(message)
  }

  function send(type, requestId, requestScope) {
    const message = { type, payload: {
      selectionId: `selection-${requestId}`, requestId, text: `Text for ${requestId}.`, kind: 'translate',
      ...(requestScope ? { requestScope } : {}),
    } }
    const sender = routeDesktopMessageSender(message, mainSender, true)
    let response
    for (const listener of listeners) listener(message, sender, (reply) => { response = reply })
    assert.deepEqual(response, { accepted: true })
  }

  async function start(requestId, requestScope) {
    send('START_TRANSLATION', requestId, requestScope)
    await until(() => requests.some(({ text }) => text === `Text for ${requestId}.`), `request ${requestId} never started`)
    return requests.find(({ text }) => text === `Text for ${requestId}.`)
  }

  try {
    await import(`../vendor/src/background.js?translation-scope-smoke=${Date.now()}`)
    const translation = await start('default-1')
    const reading = await start('reading-1', 'reading')
    assert.equal(translation.signal.aborted, false, 'reading must not cancel a normal translation')
    assert.equal(reading.signal.aborted, false)

    const nextReading = await start('reading-2', 'reading')
    assert.equal(reading.signal.aborted, true, 'a newer article lookup must cancel the previous lookup')
    assert.equal(translation.signal.aborted, false)
    nextReading.finish()
    await until(() => events.some(({ requestId, status }) => requestId === 'reading-2' && status === 'success'),
      'article completion must retain its request ID')

    const cancelReading = await start('reading-3', 'reading')
    send('CANCEL_TRANSLATION', 'reading-3')
    assert.equal(cancelReading.signal.aborted, false, 'a normal cancel must not reach the reading slot')
    send('CANCEL_TRANSLATION', 'default-1')
    assert.equal(translation.signal.aborted, true, 'normal cancellation must cancel its own request')
    assert.equal(cancelReading.signal.aborted, false)
    send('CANCEL_TRANSLATION', 'reading-3', 'reading')
    assert.equal(cancelReading.signal.aborted, true, 'reading cancellation must cancel its own request')

    const defaultAgain = await start('default-2')
    const readingAgain = await start('reading-4', 'reading')
    send('CANCEL_TRANSLATION', 'default-2', 'reading')
    assert.equal(defaultAgain.signal.aborted, false, 'reading cancellation must not reach the normal slot')
    assert.equal(readingAgain.signal.aborted, false, 'a mismatched request ID must not cancel an article lookup')
    const nextDefault = await start('default-3')
    assert.equal(defaultAgain.signal.aborted, true)
    assert.equal(readingAgain.signal.aborted, false, 'a normal translation must not cancel an article lookup')
    nextDefault.finish('normal result')
    readingAgain.finish('article result')
    await until(() => ['default-3', 'reading-4'].every((id) => events.some(({ requestId, status }) => requestId === id && status === 'success')),
      'both scopes must independently deliver their result')
    assert.equal(events.some(({ requestId, status }) => ['reading-1', 'reading-3', 'default-1', 'default-2'].includes(requestId)
      && status === 'success'), false, 'cancelled requests must not produce successful results')
  } finally {
    for (const request of requests) request.finish()
    // Let aborted handlers finish while their fixture chrome object is installed.
    await wait(0)
    globalThis.chrome = previousChrome
  }
}
