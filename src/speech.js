import { readReadingSettings } from './reading-support.js'

const PREPARATION_TIMEOUT_MS = 500
const DEFAULT_SPEECH_SETTINGS = Object.freeze({ voiceName: '', rate: 0.9 })
const FINAL_SPEECH_EVENTS = new Set(['end', 'interrupted', 'cancelled', 'error'])
let activeSpeech = null
let pendingSpeech = null

function matchesSpeech(speech, { tabId, frameId, speechId, clientId = '', documentId = '' }) {
  return Boolean(speech && speech.tabId === tabId && speech.frameId === frameId && speech.speechId === speechId
    && (speech.clientId || '') === clientId && (speech.documentId || '') === documentId)
}

export function handleSpeechMessage(message, sender, sendResponse) {
  if (!['SPEAK_TEXT', 'SPEAK_LIBRARY_TEXT', 'STOP_SPEECH', 'GET_SPEECH_VOICES', 'PREVIEW_SPEECH'].includes(message?.type)) return false
  if (message.type === 'GET_SPEECH_VOICES') {
    void getVoices(sendResponse)
    return true
  }
  const tabId = sender?.tab?.id
  const frameId = sender?.frameId || 0
  const speechId = String(message.payload?.speechId || '')
  const isLibrary = message.type === 'SPEAK_LIBRARY_TEXT'
    || (message.type === 'STOP_SPEECH' && Boolean(message.payload?.clientId))
  const clientId = isLibrary ? String(message.payload?.clientId || '') : ''
  const documentId = isLibrary ? String(sender.documentId || '') : ''
  if (isLibrary && (!clientId || clientId.length > 100
    || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL('src/library.html'))) {
    sendResponse({ ok: false, message: 'Open your vocabulary book to use this speech control.' })
    return false
  }
  if (message.type === 'STOP_SPEECH') {
    try {
      const owner = { tabId, frameId, speechId, clientId, documentId }
      if (matchesSpeech(pendingSpeech, owner)) pendingSpeech = null
      if (matchesSpeech(activeSpeech, owner)) {
        activeSpeech = null
        chrome.tts.stop()
      }
      sendResponse({ ok: true })
    } catch {
      sendResponse({ ok: false, message: 'Unable to stop speech. Please try again.' })
    }
    return false
  }
  if (message.type === 'SPEAK_TEXT' && typeof tabId !== 'number') return false
  void startSpeech({ message, tabId, frameId, speechId, clientId, documentId, sendResponse })
  return true
}

async function withFallback(operation, fallback) {
  let timeoutId
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => fallback),
      new Promise((resolve) => { timeoutId = setTimeout(() => resolve(fallback), PREPARATION_TIMEOUT_MS) }),
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function readVoices() {
  return withFallback(async () => {
    const voices = await chrome.tts.getVoices()
    return Array.isArray(voices) ? { ok: true, voices } : { ok: false, voices: [] }
  }, { ok: false, voices: [] })
}

async function getVoices(sendResponse) {
  try {
    const result = await readVoices()
    sendResponse({ ok: result.ok, voices: result.voices
      .filter((voice) => voice && typeof voice.voiceName === 'string')
      .map(({ voiceName, lang, remote }) => ({ voiceName, lang, remote })) })
  } catch {
    sendResponse({ ok: false, voices: [] })
  }
}

function restorePreviousSpeech(speech, previousSpeech) {
  if (activeSpeech === speech) activeSpeech = previousSpeech && !previousSpeech.isFinished ? previousSpeech : null
}

async function startSpeech({ message, tabId, frameId, speechId, clientId, documentId, sendResponse }) {
  const text = String(message.payload?.text || '').trim()
  if (!text || !speechId || text.length > 12000) {
    sendResponse({ ok: false, message: 'Select up to 12,000 characters to read aloud.' })
    return
  }
  const speech = { tabId, frameId, speechId, clientId, documentId, isFinished: false }
  pendingSpeech = speech
  let previousSpeech = null
  try {
    const isPreview = message.type === 'PREVIEW_SPEECH'
    const [settings, { voices }] = await Promise.all([
      isPreview ? DEFAULT_SPEECH_SETTINGS : withFallback(readReadingSettings, DEFAULT_SPEECH_SETTINGS),
      readVoices(),
    ])
    if (pendingSpeech !== speech) {
      sendResponse({ ok: false, message: 'Speech was cancelled.' })
      return
    }
    const voiceName = isPreview ? String(message.payload?.voiceName || '') : settings.voiceName
    const voice = voices.find((item) => item?.voiceName === voiceName)
    const lang = /[\u3400-\u9fff]/u.test(text) ? 'zh-CN' : 'en-US'
    const canUseVoice = voice && (isPreview || voice.lang?.split('-')[0] === lang.split('-')[0])
    const rate = isPreview ? Number(message.payload?.rate) : settings.rate
    pendingSpeech = null
    previousSpeech = activeSpeech
    activeSpeech = speech
    chrome.tts.speak(text, {
      lang: canUseVoice ? voice.lang : lang,
      ...(canUseVoice ? { voiceName: voice.voiceName } : {}),
      rate: Number.isFinite(rate) && rate >= 0.5 && rate <= 1.5 ? rate : 0.9,
      enqueue: false,
      onEvent(event) {
        if (FINAL_SPEECH_EVENTS.has(event.type)) {
          speech.isFinished = true
          if (activeSpeech === speech) activeSpeech = null
        }
        const notification = {
          type: 'SPEECH_EVENT',
          payload: {
            speechId,
            ...(clientId ? { clientId } : {}),
            status: event.type,
            message: event.type === 'error' ? 'Unable to speak. Check the installed system voices.' : '',
          },
        }
        if (clientId) {
          chrome.runtime.sendMessage(notification, () => { void chrome.runtime.lastError })
        } else if (typeof tabId === 'number') {
          chrome.tabs.sendMessage(tabId, notification, { frameId }, () => { void chrome.runtime.lastError })
        }
      },
    }, () => {
      const error = chrome.runtime.lastError
      if (error) restorePreviousSpeech(speech, previousSpeech)
      sendResponse(error
        ? { ok: false, message: 'Unable to start speech. Check the installed system voices.' }
        : { ok: true })
    })
  } catch {
    if (pendingSpeech === speech) pendingSpeech = null
    restorePreviousSpeech(speech, previousSpeech)
    sendResponse({ ok: false, message: 'Speech is unavailable. Reload the extension and check system voices.' })
  }
}
