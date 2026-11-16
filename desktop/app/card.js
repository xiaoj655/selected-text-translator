import { localizeErrorMessage } from './messages.js'
import { resultPlainText } from './result-text.js'

const $ = (id) => document.getElementById(id)

const state = {
  entry: null,
  counter: 0,
  speechId: null,
  reported: false,
  pinned: false,
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function makeId(prefix) {
  state.counter += 1
  return `${prefix}-${Date.now()}-${state.counter}`
}

function applyPrefs(prefs) {
  const root = document.documentElement
  root.dataset.theme = ['system', 'light', 'dark'].includes(prefs?.theme) ? prefs.theme : 'system'
  root.dataset.font = ['small', 'normal', 'large'].includes(prefs?.font) ? prefs.font : 'normal'
  root.dataset.motion = prefs?.reducedMotion ? 'reduced' : 'full'
  root.dataset.accent = ['indigo', 'ocean', 'emerald', 'rose', 'amber'].includes(prefs?.accent) ? prefs.accent : 'indigo'
}

async function initPrefs() {
  try {
    const saved = await chrome.storage.sync.get(['desktop_prefs'])
    applyPrefs(saved?.desktop_prefs)
  } catch {
    applyPrefs(null)
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes?.desktop_prefs) return
    applyPrefs(changes.desktop_prefs.newValue)
  })
}

function cancelActiveRequest() {
  const entry = state.entry
  if (!entry || !['pending', 'loading', 'streaming'].includes(entry.status)) return
  try {
    chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', payload: { requestId: entry.requestId } }, () => {})
  } catch {
    // the request may already have finished
  }
}

function stopSpeech() {
  const speechId = state.speechId
  state.speechId = null
  if (!speechId) return
  try {
    chrome.runtime.sendMessage({ type: 'STOP_SPEECH', payload: { speechId } }, () => {})
  } catch {
    // ignore
  }
}

function setPinned(flag) {
  state.pinned = Boolean(flag)
  $('btn-pin').classList.toggle('is-active', state.pinned)
  try {
    window.sttDesktop.setCardPinned(state.pinned)
  } catch {
    // pin state is best effort
  }
}

function startSelection(payload) {
  const text = String(payload?.text || '').trim().slice(0, 12000)
  if (!text) return
  if (payload?.prefs) applyPrefs(payload.prefs)
  cancelActiveRequest()
  stopSpeech()
  setPinned(false)
  state.reported = false
  state.entry = {
    id: makeId('s'),
    requestId: makeId('r'),
    text,
    mode: 'translate',
    status: 'pending',
    translatedText: '',
    lexical: null,
    error: '',
    createdAt: Date.now(),
  }
  render()
  sendRequest()
}

function sendRequest(forceRefresh = false) {
  const entry = state.entry
  if (!entry) return
  try {
    chrome.runtime.sendMessage({
      type: 'START_TRANSLATION',
      payload: {
        selectionId: entry.id,
        requestId: entry.requestId,
        kind: 'translate',
        forceRefresh,
        text: entry.text,
        context: '',
        contextStart: null,
        contextEnd: null,
      },
    }, (response) => {
      if (!response?.accepted) failEntry('后台没有接受请求,请重试。')
    })
  } catch {
    failEntry('无法连接后台,请重启应用。')
  }
}

function failEntry(message) {
  const entry = state.entry
  if (!entry) return
  entry.status = 'error'
  entry.error = message
  render()
  reportEntry()
}

function handleTranslationEvent(payload) {
  const entry = state.entry
  if (!entry || payload.requestId !== entry.requestId) return
  switch (payload.status) {
    case 'started':
      entry.status = 'loading'
      break
    case 'stream':
      entry.status = 'streaming'
      entry.translatedText = String(payload.translatedText || '').trim()
      patchStreamResult(entry)
      return
    case 'success': {
      entry.status = 'done'
      const translatedText = String(payload.translatedText || '').trim()
      if (translatedText) entry.translatedText = translatedText
      entry.lexical = payload.lexicalDetails || null
      break
    }
    case 'missing-configuration':
    case 'error':
      entry.status = 'error'
      entry.error = localizeErrorMessage(payload)
      break
    default:
      return
  }
  render()
  if (['done', 'error'].includes(entry.status)) reportEntry()
}

function handleSpeechEvent(payload) {
  if (payload.speechId !== state.speechId) return
  if (!['end', 'error', 'interrupted', 'cancelled'].includes(payload.status)) return
  state.speechId = null
  renderActions()
  const resultEl = $('result')
  if (resultEl && state.entry?.status === 'error' && payload.message) {
    resultEl.textContent = payload.message
  }
}

function patchStreamResult(entry) {
  const resultEl = $('result')
  if (!resultEl || entry.status !== 'streaming') {
    render()
    return
  }
  resultEl.className = 'result'
  resultEl.replaceChildren(document.createTextNode(entry.translatedText || ''), el('span', 'caret'))
  scheduleResize()
}

function reportEntry() {
  const entry = state.entry
  if (!entry || state.reported) return
  state.reported = true
  try {
    void window.sttDesktop.reportEntry({
      id: entry.id,
      requestId: entry.requestId,
      text: entry.text,
      mode: entry.mode,
      status: entry.status,
      translatedText: entry.translatedText,
      lexical: entry.lexical,
      error: entry.error,
      createdAt: entry.createdAt,
    })
  } catch {
    // history sync is best effort
  }
}

function copyText(text, button) {
  void window.sttDesktop.copyText(text)
  if (!button || button.classList.contains('is-done')) return
  const original = button.textContent
  button.textContent = '✓ 已复制'
  button.classList.add('is-done')
  setTimeout(() => {
    button.textContent = original
    button.classList.remove('is-done')
  }, 1400)
}

function toggleSpeech() {
  if (state.speechId) {
    stopSpeech()
    renderActions()
    return
  }
  const entry = state.entry
  if (!entry) return
  const speechId = makeId('speech')
  state.speechId = speechId
  try {
    chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId, text: entry.text } }, (response) => {
      if (!response?.ok && state.speechId === speechId) {
        state.speechId = null
        renderActions()
      }
    })
  } catch {
    state.speechId = null
  }
  renderActions()
}

async function saveVocabulary(button) {
  const entry = state.entry
  if (!entry || entry.status !== 'done' || !entry.translatedText) return
  button.setAttribute('aria-busy', 'true')
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'VOCABULARY_SAVE',
      payload: {
        text: entry.text,
        meaning: entry.translatedText,
        context: '',
        contextStart: null,
        contextEnd: null,
        usage: '',
        explanation: '',
        example: '',
        phonetic: entry.lexical?.phonetic || '',
        sourceUrl: '',
      },
    })
    button.textContent = response?.ok ? '✓ 已收藏' : '收藏失败'
  } catch {
    button.textContent = '收藏失败'
  }
  button.removeAttribute('aria-busy')
}

function openInMainWindow() {
  const entry = state.entry
  reportEntry()
  void window.sttDesktop.openMainWithText(entry?.text || '')
}

let resizeScheduled = false
let lastRequestedHeight = 0

function scheduleResize() {
  if (resizeScheduled) return
  resizeScheduled = true
  requestAnimationFrame(() => {
    resizeScheduled = false
    const height = Math.ceil($('card').getBoundingClientRect().height)
    if (Math.abs(height - lastRequestedHeight) < 4) return
    lastRequestedHeight = height
    window.sttDesktop.resizeCard(height)
  })
}

function render() {
  const entry = state.entry
  if (!entry) return

  const srcEl = $('src')
  srcEl.textContent = entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text
  srcEl.title = entry.text

  const resultEl = $('result')
  resultEl.className = 'result'
  resultEl.replaceChildren()
  if (entry.status === 'error') {
    resultEl.classList.add('is-error')
    resultEl.textContent = entry.error
  } else if (entry.status === 'done') {
    resultEl.textContent = entry.translatedText || '没有返回译文,可以重新生成。'
    const lexical = renderLexical(entry)
    if (lexical) resultEl.append(lexical)
  } else {
    resultEl.classList.add('is-loading')
    resultEl.textContent = entry.status === 'streaming' ? '' : '正在请求模型…'
    if (entry.status === 'streaming') {
      resultEl.append(document.createTextNode(entry.translatedText), el('span', 'caret'))
    }
  }

  renderActions()
  scheduleResize()
}

function renderLexical(entry) {
  const lexical = entry.lexical
  if (!lexical) return null
  const box = el('div', 'lexical')
  if (lexical.phonetic) box.append(lexicalRow('音标', lexical.phonetic))
  if (Array.isArray(lexical.definitions) && lexical.definitions.length) {
    const row = el('div', 'lexical-row')
    row.append(el('span', 'lexical-label', '释义'))
    const list = el('ul', 'definitions')
    for (const definition of lexical.definitions) {
      const parts = []
      if (definition.pos) parts.push(`[${definition.pos}]`)
      parts.push(definition.meaning || '')
      if (definition.example) parts.push(`(${definition.example.source} → ${definition.example.target})`)
      list.append(el('li', '', parts.join(' ')))
    }
    row.append(list)
    box.append(row)
  }
  if (lexical.contextual_analysis) box.append(lexicalRow('语境', lexical.contextual_analysis))
  return box.childElementCount ? box : null
}

function lexicalRow(label, value) {
  const row = el('div', 'lexical-row')
  row.append(el('span', 'lexical-label', label), el('span', '', value))
  return row
}

function renderActions() {
  const entry = state.entry
  const bar = $('actions')
  bar.replaceChildren()
  if (!entry) return
  const add = (label, handler) => {
    const button = el('button', '', label)
    button.type = 'button'
    button.addEventListener('click', handler)
    bar.append(button)
    return button
  }

  if (entry.status === 'done' && entry.translatedText) {
    add('复制结果', (event) => copyText(resultPlainText(entry), event.currentTarget))
  }
  add('复制原文', (event) => copyText(entry.text, event.currentTarget))
  add(state.speechId ? '■ 停止' : '▷ 朗读', toggleSpeech)
  if (['pending', 'loading', 'streaming'].includes(entry.status)) {
    add('取消', () => {
      cancelActiveRequest()
      entry.status = 'error'
      entry.error = '已取消请求,可以重新生成。'
      render()
      reportEntry()
    })
  } else {
    add('重新生成', () => {
      entry.requestId = makeId('r')
      entry.status = 'pending'
      entry.translatedText = ''
      entry.lexical = null
      entry.error = ''
      state.reported = false
      render()
      sendRequest(true)
    })
  }
  if (entry.status === 'done') {
    add('收藏', (event) => void saveVocabulary(event.currentTarget))
  }
  add('主窗口 ↗', openInMainWindow)
}

function bind() {
  $('btn-close').addEventListener('click', () => window.sttDesktop.hideCard())
  $('btn-popout').addEventListener('click', openInMainWindow)
  $('btn-pin').addEventListener('click', () => setPinned(!state.pinned))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.sttDesktop.hideCard()
  })
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TRANSLATION_EVENT') handleTranslationEvent(message.payload || {})
    else if (message?.type === 'SPEECH_EVENT') handleSpeechEvent(message.payload || {})
  })
  window.sttDesktop.onSelection(startSelection)
  window.addEventListener('pagehide', () => {
    cancelActiveRequest()
    stopSpeech()
  })
}

void initPrefs()
bind()
scheduleResize()
