import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createTts } from '../desktop/src/tts.js'

const cloudSettings = { desktop_tts_cloud: true, desktop_tts_api_key: 'fixture-key' }

function setup(overrides = {}) {
  const children = []
  const events = []
  const tts = createTts({
    platform: 'linux',
    readCloudSettings: async () => cloudSettings,
    play: async () => {},
    spawnImpl(_command, args) {
      const child = new EventEmitter()
      child.text = args.at(-1)
      child.kill = () => { child.killed = true }
      children.push(child)
      return child
    },
    ...overrides,
  })
  const speak = (text, lang = 'en-US', pronunciation) => {
    tts.speak(text, { lang, pronunciation, rate: 0.8, onEvent: (event) => events.push([text, event.type]) })
  }
  return { tts, speak, children, events }
}

test('English cloud speech preserves the selected rate through playback', async () => {
  const payload = Buffer.from('mock audio')
  const { speak, children, events } = setup({
    synthesize: async (text, { apiKey }) => {
      assert.equal(text, 'Preview.')
      assert.equal(apiKey, cloudSettings.desktop_tts_api_key)
      return payload
    },
    play: async (wav, { rate, onStart }) => {
      assert.equal(wav, payload)
      assert.equal(rate, 0.8)
      onStart()
    },
  })
  speak('Preview.')
  await setImmediate()
  assert.equal(children.length, 0)
  assert.deepEqual(events, [['Preview.', 'start'], ['Preview.', 'end']])
})

test('cloud word speech applies the selected rate during synthesis and passes the contextual pronunciation', async () => {
  const { speak, children, events } = setup({
    synthesize: async (text, { isEnglishWord, pronunciation, rate }) => {
      assert.equal(text, 'record')
      assert.equal(isEnglishWord, true)
      assert.equal(pronunciation, 'R EH1 K ER0 D')
      assert.equal(rate, 0.8)
      return Buffer.from('mock word audio')
    },
    play: async (_wav, { rate, onStart }) => {
      assert.equal(rate, 1)
      onStart()
    },
  })
  speak('record', 'en-US', 'R EH1 K ER0 D')
  await setImmediate()
  assert.equal(children.length, 0)
  assert.deepEqual(events, [['record', 'start'], ['record', 'end']])
})

test('cloud speech sends each saved voice ID to its matching synthesis model', async () => {
  const voices = []
  const { tts } = setup({
    readCloudSettings: async () => ({
      ...cloudSettings, desktop_tts_word_voice: 'custom-word-voice', desktop_tts_text_voice: 'custom-text-voice',
      desktop_tts_text_model: 'qwen-audio-3.1-tts-flash',
    }),
    synthesize: async (_text, { isEnglishWord, voice, textModel }) => {
      voices.push([isEnglishWord, voice, textModel])
      return Buffer.from('mock audio')
    },
  })
  tts.speak('record', { lang: 'en-US' })
  await setImmediate()
  tts.speak('Read this passage.', { lang: 'en-US' })
  await setImmediate()
  assert.deepEqual(voices, [
    [true, 'custom-word-voice', 'qwen-audio-3.1-tts-flash'],
    [false, 'custom-text-voice', 'qwen-audio-3.1-tts-flash'],
  ])
})

test('a cloud error retries ordinary words with Jennifer and avoids substituting a different contextual pronunciation', async () => {
  const calls = []
  const { speak, children, events } = setup({
    synthesize: async (text, { isEnglishWord }) => {
      calls.push([text, isEnglishWord])
      if (isEnglishWord) throw new Error('Word voice unavailable')
      return Buffer.from('mock fallback audio')
    },
    play: async (_wav, { rate, onStart }) => {
      assert.equal(rate, 0.8)
      onStart()
    },
  })
  speak('hello')
  await setImmediate()
  speak('read', 'en-US', 'R EH1 D')
  await setImmediate()
  assert.deepEqual(calls, [['hello', true], ['hello', false], ['read', true]])
  assert.deepEqual(events, [['hello', 'fallback'], ['hello', 'start'], ['hello', 'end'], ['read', 'error']])
  assert.equal(children.length, 0)
})

test('stopping cloud synthesis aborts it and ignores any late audio', async () => {
  let request
  let resolveAudio
  let playCount = 0
  const { tts, speak, children, events } = setup({
    synthesize: async (_text, { signal }) => {
      request = signal
      return new Promise((resolve) => { resolveAudio = resolve })
    },
    play: async () => { playCount += 1 },
  })
  speak('Pending.')
  await setImmediate()
  tts.stop()
  assert.equal(request.aborted, true)
  resolveAudio(Buffer.from('late audio'))
  await setImmediate()
  assert.equal(playCount, 0)
  assert.equal(children.length, 0)
  assert.deepEqual(events, [['Pending.', 'cancelled']])
})

test('fallback and replaced system processes cannot finish a newer request', async () => {
  let requests = 0
  const { speak, children, events } = setup({
    synthesize: async () => {
      requests += 1
      throw new Error('Unavailable')
    },
  })
  speak('Fallback.')
  await setImmediate()
  assert.deepEqual(events, [['Fallback.', 'fallback']])
  assert.equal(requests, 1)
  speak('こんにちは', 'ja-JP')
  assert.equal(requests, 1)
  assert.equal(children[0].killed, true)
  children[0].emit('close', 1)
  children[1].emit('close', 0)
  assert.deepEqual(events, [
    ['Fallback.', 'fallback'], ['Fallback.', 'interrupted'], ['こんにちは', 'end'],
  ])
})
