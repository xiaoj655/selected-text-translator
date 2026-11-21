import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { dashScopeSpeechKey, synthesizeDashScopeSpeech } from '../desktop/src/dashscope-tts.js'

const API_KEY = 'mock-speech-key'
const TTS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

function speechEvent(data, finishReason) {
  return `id: 1\r\nevent: result\r\ndata: ${JSON.stringify({
    output: { audio: { data, url: 'https://mock.invalid/audio.wav' }, finish_reason: finishReason },
  })}\r\n\r\n`
}

function speechResponse(...chunks) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

test('dedicated speech credentials take precedence and work with a separate translation provider', () => {
  assert.equal(dashScopeSpeechKey({
    api_key: 'another-key', base_url: 'https://example.com/v1', desktop_tts_api_key: ` ${API_KEY} `,
  }), API_KEY)
  assert.equal(dashScopeSpeechKey({ api_key: 'another-key', base_url: 'https://example.com/v1' }), '')
})

test('fallback credentials are accepted only for the default or official mainland compatible endpoint', () => {
  for (const baseUrl of ['', ' https://dashscope.aliyuncs.com/compatible-mode/v1/ ']) {
    assert.equal(dashScopeSpeechKey({ api_key: ` ${API_KEY} `, base_url: baseUrl }), API_KEY)
  }
  for (const baseUrl of [
    '/',
    'http://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1?proxy=1',
    'https://dashscope.aliyuncs.com.evil.invalid/compatible-mode/v1',
    'https://dashscope.aliyuncs.com@evil.invalid/compatible-mode/v1',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  ]) {
    assert.equal(dashScopeSpeechKey({ api_key: API_KEY, base_url: baseUrl }), '')
  }
  assert.equal(dashScopeSpeechKey(), '')
})

test('DashScope English synthesis sends a single fixed-host request and assembles PCM chunks into WAV', async () => {
  const text = 'Did you record that?'
  const firstChunk = speechEvent('AQACAA==')
  const secondChunk = speechEvent('AwAEAA==', 'null')
  const complete = speechEvent('', 'stop')
  let requests = 0
  const signal = new AbortController().signal

  const wav = await synthesizeDashScopeSpeech(text, {
    apiKey: API_KEY,
    signal,
    fetchImpl: async (url, options) => {
      assert.equal(++requests, 1)
      assert.equal(url, TTS_ENDPOINT)
      assert.equal(options.method, 'POST')
      assert.equal(options.redirect, 'error')
      assert.equal(options.signal, signal)
      assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`)
      assert.equal(options.headers['X-DashScope-SSE'], 'enable')
      assert.deepEqual(JSON.parse(options.body), {
        model: 'qwen3-tts-flash', input: { text, voice: 'Jennifer', language_type: 'English' },
      })
      return speechResponse(firstChunk.slice(0, -1), firstChunk.slice(-1) + secondChunk.slice(0, 66),
        secondChunk.slice(66) + complete)
    },
  })

  assert.equal(requests, 1)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(4), wav.length - 8)
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ')
  assert.equal(wav.readUInt16LE(20), 1)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 24000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.toString('ascii', 36, 40), 'data')
  assert.equal(wav.readUInt32LE(40), 8)
  assert.deepEqual(wav.subarray(44), Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]))
})

test('DashScope synthesis rejects incomplete, empty, malformed, and failed responses without leaking upstream data',
  async () => {
    const badResponses = [
      speechResponse(speechEvent('AQACAA==')),
      speechResponse(speechEvent('', 'stop')),
      speechResponse(speechEvent('%%%%', 'stop')),
      speechResponse(speechEvent('AQ==', 'stop')),
      speechResponse('event: result\ndata: {"status_code":401,"message":"private-provider-error"}\n\n'),
      new Response('private-provider-error', { status: 401 }),
      new Response('private-provider-error'),
    ]
    for (const response of badResponses) {
      await assert.rejects(synthesizeDashScopeSpeech('Hello', {
        apiKey: API_KEY, fetchImpl: async () => response,
      }), { message: 'DashScope speech synthesis failed.' })
    }
  })

test('DashScope synthesis propagates cancellation and avoids a request when already aborted', async () => {
  const controller = new AbortController()
  let requests = 0
  const settings = {
    apiKey: API_KEY,
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      requests += 1
      return new Response(new ReadableStream({
        start(stream) {
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true })
          stream.enqueue(new TextEncoder().encode(speechEvent('AQACAA==')))
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    },
  }
  const request = synthesizeDashScopeSpeech('Hello', settings)
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  await assert.rejects(synthesizeDashScopeSpeech('Hello', settings), { name: 'AbortError' })
  assert.equal(requests, 1)
})
