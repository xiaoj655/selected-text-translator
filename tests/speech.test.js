import test from 'node:test'
import assert from 'node:assert/strict'
import { handleSpeechMessage } from '../src/speech.js'

async function withSpeech(callback) {
  const previous = globalThis.chrome
  const spoken = []
  const events = []
  let stops = 0
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL(path) { return `chrome-extension://selected-test/${path}` },
      sendMessage(message, done) { events.push({ route: 'runtime', message }); done() },
    },
    storage: { sync: { async get() { return { speech_voice: 'English', speech_rate: 0.75 } } } },
    tts: {
      async getVoices() { return [{ voiceName: 'English', lang: 'en-GB', remote: false }] },
      speak(text, options, done) { spoken.push({ text, ...options }); done() },
      stop() { stops++ },
    },
    tabs: { sendMessage(tabId, message, options, done) { events.push({ tabId, message, options }); done() } },
  }
  const send = (type, payload, tabId = 1) => new Promise((resolve) => {
    handleSpeechMessage({ type, payload }, { tab: typeof tabId === 'number' ? { id: tabId } : undefined, frameId: 2 }, resolve)
  })
  const sendFrom = (type, payload, sender) => new Promise((resolve) => {
    handleSpeechMessage({ type, payload }, sender, resolve)
  })
  try { await callback({ send, sendFrom, spoken, events, getStops: () => stops }) }
  finally { globalThis.chrome = previous }
}

test('speech uses the chosen voice and rate without needing provider credentials', async () => {
  await withSpeech(async ({ send, spoken, events }) => {
    assert.equal((await send('SPEAK_TEXT', { speechId: 'one', text: 'hello' })).ok, true)
    assert.equal(spoken[0].voiceName, 'English')
    assert.equal(spoken[0].rate, 0.75)
    spoken[0].onEvent({ type: 'end' })
    assert.deepEqual(events[0].options, { frameId: 2 })
    assert.equal(events[0].message.payload.speechId, 'one')
  })
})

test('speech falls back to the source language when the chosen voice is incompatible', async () => {
  await withSpeech(async ({ send, spoken }) => {
    await send('SPEAK_TEXT', { speechId: 'chinese', text: '你好' })
    assert.equal(spoken[0].lang, 'zh-CN')
    assert.equal('voiceName' in spoken[0], false)
    await send('STOP_SPEECH', { speechId: 'chinese' })
  })
})

test('a stale stop request cannot interrupt another tab', async () => {
  await withSpeech(async ({ send, getStops }) => {
    await send('SPEAK_TEXT', { speechId: 'active', text: 'hello' }, 2)
    await send('STOP_SPEECH', { speechId: 'active' }, 1)
    assert.equal(getStops(), 0)
    await send('STOP_SPEECH', { speechId: 'active' }, 2)
    assert.equal(getStops(), 1)
  })
})

test('voice listing and settings preview work without a sender tab', async () => {
  await withSpeech(async ({ send, spoken }) => {
    assert.equal((await send('GET_SPEECH_VOICES', {}, null)).voices[0].voiceName, 'English')
    assert.equal((await send('PREVIEW_SPEECH', {
      speechId: 'preview', text: 'hello', voiceName: 'English', rate: 1.2,
    }, null)).ok, true)
    assert.equal(spoken[0].rate, 1.2)
    await send('STOP_SPEECH', { speechId: 'preview' }, null)
  })
})

async function flushSpeechTasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

test('speech continues with defaults when reading preferences cannot be read', async () => {
  await withSpeech(async ({ send, spoken }) => {
    chrome.storage.sync.get = async () => { throw new Error('Storage unavailable') }
    const result = await send('SPEAK_TEXT', { speechId: 'fallback-settings', text: 'hello' })
    assert.equal(result.ok, true)
    assert.equal(spoken[0].rate, 0.9)
    assert.equal(spoken[0].lang, 'en-US')
    assert.equal('voiceName' in spoken[0], false)
    await send('STOP_SPEECH', { speechId: 'fallback-settings' })
  })
})

test('speech continues with the default language when voice discovery fails', async () => {
  await withSpeech(async ({ send, spoken }) => {
    chrome.tts.getVoices = async () => { throw new Error('Voice discovery unavailable') }
    const result = await send('SPEAK_TEXT', { speechId: 'fallback-voices', text: 'hello' })
    assert.equal(result.ok, true)
    assert.equal(spoken[0].rate, 0.75)
    assert.equal(spoken[0].lang, 'en-US')
    assert.equal('voiceName' in spoken[0], false)
    await send('STOP_SPEECH', { speechId: 'fallback-voices' })
  })
})

test('voice discovery has a bounded wait before default speech starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSpeech(async ({ send, spoken }) => {
    chrome.tts.getVoices = () => new Promise(() => {})
    const resultPromise = send('SPEAK_TEXT', { speechId: 'slow-voices', text: 'hello' })
    await flushSpeechTasks()
    t.mock.timers.tick(1000)
    await flushSpeechTasks()
    assert.equal(spoken.length, 1)
    assert.equal((await resultPromise).ok, true)
    await send('STOP_SPEECH', { speechId: 'slow-voices' })
  })
})

test('an active speaker can stop while another tab prepares without stopping the later speech', async () => {
  await withSpeech(async ({ send, spoken, getStops }) => {
    await send('SPEAK_TEXT', { speechId: 'playing', text: 'first' }, 1)
    let resolveVoices
    chrome.tts.getVoices = () => new Promise((resolve) => { resolveVoices = resolve })
    const next = send('SPEAK_TEXT', { speechId: 'preparing', text: 'second' }, 2)
    await flushSpeechTasks()
    await send('STOP_SPEECH', { speechId: 'playing' }, 1)
    assert.equal(getStops(), 1)
    resolveVoices([])
    assert.equal((await next).ok, true)
    assert.equal(spoken.length, 2)
    await send('STOP_SPEECH', { speechId: 'playing' }, 1)
    assert.equal(getStops(), 1)
    await send('STOP_SPEECH', { speechId: 'preparing' }, 2)
    assert.equal(getStops(), 2)
  })
})

test('cancelling a pending utterance does not stop another tab that is still speaking', async () => {
  await withSpeech(async ({ send, spoken, getStops }) => {
    await send('SPEAK_TEXT', { speechId: 'still-playing', text: 'first' }, 1)
    let resolveVoices
    chrome.tts.getVoices = () => new Promise((resolve) => { resolveVoices = resolve })
    const next = send('SPEAK_TEXT', { speechId: 'cancel-pending', text: 'second' }, 2)
    await flushSpeechTasks()
    await send('STOP_SPEECH', { speechId: 'cancel-pending' }, 2)
    assert.equal(getStops(), 0)
    resolveVoices([])
    assert.equal((await next).ok, false)
    assert.equal(spoken.length, 1)
    await send('STOP_SPEECH', { speechId: 'still-playing' }, 1)
    assert.equal(getStops(), 1)
  })
})

test('slow reading preferences also fall back without delaying speech indefinitely', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withSpeech(async ({ send, spoken }) => {
    chrome.storage.sync.get = () => new Promise(() => {})
    const resultPromise = send('SPEAK_TEXT', { speechId: 'slow-settings', text: 'hello' })
    await flushSpeechTasks()
    t.mock.timers.tick(1000)
    await flushSpeechTasks()
    assert.equal(spoken.length, 1)
    assert.equal(spoken[0].rate, 0.9)
    assert.equal((await resultPromise).ok, true)
    await send('STOP_SPEECH', { speechId: 'slow-settings' })
  })
})

test('an unavailable replacement engine does not lose ownership of an existing utterance', async () => {
  await withSpeech(async ({ send, getStops }) => {
    await send('SPEAK_TEXT', { speechId: 'original', text: 'first' }, 1)
    chrome.tts.speak = () => { throw new Error('Engine unavailable') }
    assert.equal((await send('SPEAK_TEXT', { speechId: 'replacement', text: 'second' }, 2)).ok, false)
    await send('STOP_SPEECH', { speechId: 'original' }, 1)
    assert.equal(getStops(), 1)
  })
})

test('late terminal events from an interrupted utterance do not clear the newer owner', async () => {
  await withSpeech(async ({ send, spoken, getStops }) => {
    await send('SPEAK_TEXT', { speechId: 'earlier', text: 'first' }, 1)
    await send('SPEAK_TEXT', { speechId: 'later', text: 'second' }, 2)
    spoken[0].onEvent({ type: 'interrupted' })
    await send('STOP_SPEECH', { speechId: 'later' }, 2)
    assert.equal(getStops(), 1)
  })
})

test('a stop request from a settings page is harmless when no utterance exists', async () => {
  await withSpeech(async ({ send, getStops }) => {
    assert.equal((await send('STOP_SPEECH', { speechId: 'none' }, null)).ok, true)
    assert.equal(getStops(), 0)
  })
})


test('library speech works without a content tab and routes terminal events by client', async () => {
  await withSpeech(async ({ sendFrom, spoken, events }) => {
    const sender = { url: 'chrome-extension://selected-test/src/library.html', documentId: 'library-a' }
    const payload = { speechId: 'audio-1', clientId: 'client-a', text: 'reluctant' }
    assert.equal((await sendFrom('SPEAK_LIBRARY_TEXT', payload, sender)).ok, true)
    spoken[0].onEvent({ type: 'end' })
    assert.equal(events[0].route, 'runtime')
    assert.equal(events[0].message.payload.clientId, 'client-a')
    assert.equal(events[0].message.payload.speechId, 'audio-1')
  })
})

test('a library document cannot stop another document and webpages cannot invoke library speech', async () => {
  await withSpeech(async ({ sendFrom, getStops, spoken }) => {
    const senderA = { url: 'chrome-extension://selected-test/src/library.html', documentId: 'library-a' }
    const senderB = { ...senderA, documentId: 'library-b' }
    const payload = { speechId: 'shared-id', clientId: 'client-b', text: 'record' }
    await sendFrom('SPEAK_LIBRARY_TEXT', payload, senderB)
    assert.equal((await sendFrom('STOP_SPEECH', payload, senderA)).ok, true)
    assert.equal(getStops(), 0)
    const denied = await sendFrom('SPEAK_LIBRARY_TEXT', payload, { url: 'https://example.com', tab: { id: 7 } })
    assert.equal(denied.ok, false)
    assert.equal(spoken.length, 1)
    await sendFrom('STOP_SPEECH', payload, senderB)
    assert.equal(getStops(), 1)
  })
})
