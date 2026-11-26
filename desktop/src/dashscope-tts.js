import { Buffer } from 'node:buffer'

const DASHSCOPE_COMPATIBLE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DASHSCOPE_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
const DASHSCOPE_WORD_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const SAMPLE_RATE = 24000
const MAX_AUDIO_BYTES = 12 * 1024 * 1024
const MAX_EVENT_CHARACTERS = 4 * Math.ceil(MAX_AUDIO_BYTES / 3) + 4096
const CMU_PHONEME = /^(?:(?:AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)[012]?|B|CH|D|DH|F|G|HH|JH|K|L|M|N|NG|P|R|S|SH|T|TH|V|W|Y|Z|ZH)$/u
const XML_TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

export function dashScopeSpeechKey(settings) {
  const speechKey = String(settings?.desktop_tts_api_key || '').trim()
  if (speechKey) return speechKey

  const baseUrl = String(settings?.base_url || '').trim()
  if (baseUrl && baseUrl.replace(/\/$/u, '') !== DASHSCOPE_COMPATIBLE_URL) return ''
  return String(settings?.api_key || '').trim()
}

function createWav(chunks, length) {
  if (!length || length % 2) throw new Error('DashScope returned invalid speech audio.')

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(length + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(length, 40)
  return Buffer.concat([header, ...chunks], header.length + length)
}

async function* readEvents(body, signal) {
  let pending = ''
  let data = []
  let eventLength = 0
  const decoder = new TextDecoder()

  for await (const chunk of body) {
    signal?.throwIfAborted()
    pending += decoder.decode(chunk, { stream: true })
    let lineEnd = pending.indexOf('\n')
    while (lineEnd !== -1) {
      const line = pending.slice(0, lineEnd).replace(/\r$/u, '')
      pending = pending.slice(lineEnd + 1)
      if (!line && data.length) {
        yield data.join('\n')
        data = []
        eventLength = 0
      }
      if (line.startsWith('data:')) {
        eventLength += line.length
        if (eventLength > MAX_EVENT_CHARACTERS) throw new Error('DashScope speech response was too large.')
        data.push(line.slice(5).trimStart())
      }
      lineEnd = pending.indexOf('\n')
    }
    if (pending.length + eventLength > MAX_EVENT_CHARACTERS) throw new Error('DashScope speech response was too large.')
  }
}

async function readSpeechAudio(body, signal) {
  const chunks = []
  let length = 0

  for await (const data of readEvents(body, signal)) {
    const event = JSON.parse(data)
    if (event?.code || Number(event?.status_code) >= 400) throw new Error('DashScope speech synthesis failed.')

    const audioData = event?.output?.audio?.data
    if (audioData) {
      if (typeof audioData !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(audioData) || audioData.length % 4) {
        throw new Error('DashScope returned invalid speech audio.')
      }
      const chunk = Buffer.from(audioData, 'base64')
      length += chunk.length
      if (length > MAX_AUDIO_BYTES) throw new Error('DashScope speech response was too large.')
      chunks.push(chunk)
    }
    if (event?.output?.finish_reason === 'stop') return createWav(chunks, length)
  }
  throw new Error('DashScope speech response ended before synthesis finished.')
}

function wordSpeechInput(text, pronunciation, rate) {
  const input = {
    text,
    voice: 'Abby_v3.1',
    format: 'pcm',
    sample_rate: SAMPLE_RATE,
    rate: Number.isFinite(rate) ? Math.min(1.5, Math.max(0.5, rate)) : 1,
  }
  if (typeof pronunciation === 'string' && pronunciation.length <= 255) {
    const phonemes = pronunciation.trim().split(/\s+/u)
    if (phonemes.every((phoneme) => CMU_PHONEME.test(phoneme))) {
      const escapedText = text.replace(/[&<>]/gu, (character) => XML_TEXT_ESCAPES[character])
      input.text = `<speak><phoneme alphabet="cmu" ph="${phonemes.join(' ')}">${escapedText}</phoneme></speak>`
      input.enable_ssml = true
    }
  }
  return input
}

export async function synthesizeDashScopeSpeech(text, {
  apiKey, signal, fetchImpl = globalThis.fetch, isEnglishWord = false, pronunciation = '', rate = 1,
} = {}) {
  signal?.throwIfAborted()
  if (!apiKey) throw new Error('DashScope speech requires an API key.')
  if (typeof text !== 'string' || !text.trim() || text.length > 600) {
    throw new Error('DashScope speech requires between 1 and 600 characters.')
  }

  try {
    const isWord = isEnglishWord === true
    const body = isWord
      ? { model: 'qwen-audio-3.1-tts-flash', input: wordSpeechInput(text, pronunciation, rate) }
      : { model: 'qwen3-tts-flash', input: { text, voice: 'Jennifer', language_type: 'English' } }
    const response = await fetchImpl(isWord ? DASHSCOPE_WORD_TTS_URL : DASHSCOPE_TTS_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'enable',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await response.body?.cancel()
      throw new Error('DashScope speech did not return an audio stream.')
    }
    const wav = await readSpeechAudio(response.body, signal)
    signal?.throwIfAborted()
    return wav
  } catch {
    signal?.throwIfAborted()
    throw new Error('DashScope speech synthesis failed.')
  }
}
