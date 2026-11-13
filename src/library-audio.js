import { getContextSentence } from './context-sentence.js'

const MAX_SPEECH_LENGTH = 1200
const FINAL_SPEECH_EVENTS = new Set(['end', 'interrupted', 'cancelled', 'error'])
const SPEECH_ERROR_MESSAGE = '朗读暂时不可用，请检查系统语音后重试。'

function createUniqueId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${id}`
}

function getSpeechText(value) {
  const text = String(value || '').trim()
  return text.length <= MAX_SPEECH_LENGTH ? text : ''
}

export function getEntrySpeechTargets(entry = {}) {
  const context = String(entry.context || '').trim()
  const sentence = getContextSentence({
    text: entry.text,
    context: entry.context,
    contextStart: entry.contextStart ?? undefined,
    contextEnd: entry.contextEnd ?? undefined,
  })
  const canReadContext = context && context !== String(entry.text || '').trim()
  return {
    word: getSpeechText(entry.text),
    context: canReadContext ? sentence || getSpeechText(context) : '',
    contextLabel: sentence ? '读原句' : '读语境',
    example: getSpeechText(entry.example),
  }
}

export function createLibraryAudio({ send, onChange = () => {}, onStatus = () => {} }) {
  const clientId = createUniqueId('library')
  let desiredSpeech = null
  let ownedSpeech = null
  let reconcilePromise = null

  async function request(type, payload) {
    try {
      const response = await send(type, { ...payload, clientId })
      return response || { ok: false }
    } catch {
      return { ok: false }
    }
  }

  function requestStop(speech) {
    if (!speech.stopPromise) {
      speech.stopPromise = request('STOP_SPEECH', { speechId: speech.speechId })
    }
    return speech.stopPromise
  }

  async function reconcile() {
    while (ownedSpeech !== desiredSpeech) {
      if (ownedSpeech) {
        const previous = ownedSpeech
        const response = await requestStop(previous)
        if (ownedSpeech !== previous) continue
        if (!response.ok) {
          previous.stopPromise = null
          desiredSpeech = previous
          onChange()
          onStatus('暂时无法停止朗读，请再点一次停止。', true)
          return
        }
        ownedSpeech = null
        onChange()
        continue
      }
      if (!desiredSpeech) continue
      const speech = desiredSpeech
      ownedSpeech = speech
      const response = await request('SPEAK_LIBRARY_TEXT', { speechId: speech.speechId, text: speech.text })
      if (response.ok || ownedSpeech !== speech) continue
      ownedSpeech = null
      if (desiredSpeech === speech) {
        desiredSpeech = null
        onStatus(SPEECH_ERROR_MESSAGE, true)
      }
      onChange()
    }
  }

  function scheduleReconcile() {
    if (!reconcilePromise) {
      reconcilePromise = reconcile().finally(() => {
        reconcilePromise = null
        if (ownedSpeech !== desiredSpeech) void scheduleReconcile()
      })
    }
    return reconcilePromise
  }

  function getActiveKey() {
    return (desiredSpeech || ownedSpeech)?.key || ''
  }

  function stop() {
    desiredSpeech = null
    if (ownedSpeech) void requestStop(ownedSpeech)
    onChange()
    return scheduleReconcile()
  }

  function toggle(key, text) {
    if (getActiveKey() === key) return stop()
    const speechText = getSpeechText(text)
    if (!speechText) return Promise.resolve()
    desiredSpeech = { key, text: speechText, speechId: createUniqueId('speech') }
    if (ownedSpeech) void requestStop(ownedSpeech)
    onStatus()
    onChange()
    return scheduleReconcile()
  }

  function handleEvent(payload = {}) {
    if (payload.clientId !== clientId || payload.speechId !== ownedSpeech?.speechId) return
    if (!FINAL_SPEECH_EVENTS.has(payload.status)) return
    const isCurrent = desiredSpeech === ownedSpeech
    if (isCurrent) desiredSpeech = null
    ownedSpeech = null
    onChange()
    if (isCurrent && payload.status === 'error') onStatus(SPEECH_ERROR_MESSAGE, true)
    void scheduleReconcile()
  }

  return { clientId, getActiveKey, toggle, stop, handleEvent }
}
