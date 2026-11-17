import { localizeErrorMessage } from './messages.js'
import { resultPlainText } from './result-text.js'
import { ACTION_LABELS, showCopyDone } from './ui-text.js'

const $ = (id) => document.getElementById(id)

const state = {
  entry: null,
  counter: 0,
  speechId: null,
  reported: false,
  pinned: false,
  selection: null,
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
  if (button && button.classList.contains('is-done')) return
  void window.sttDesktop.copyText(text)
  showCopyDone(button)
}

function hideSelectionToolbar() {
  $('selection-toolbar').hidden = true
  state.selection = null
}

function showSelectionToolbar(text, rect) {
  state.selection = { text }
  const bar = $('selection-toolbar')
  bar.hidden = false
  const barRect = bar.getBoundingClientRect()
  const left = Math.max(8, Math.min(window.innerWidth - barRect.width - 8, rect.left + rect.width / 2 - barRect.width / 2))
  const above = rect.top - barRect.height - 8
  bar.style.left = `${Math.round(left)}px`
  bar.style.top = `${Math.round(above >= 8 ? above : rect.bottom + 8)}px`
}

function selectionInResult() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const anchor = selection.anchorNode
  const anchorEl = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement
  if (!anchorEl) return null
  const host = $('result').contains(anchorEl) ? $('result') : $('src').contains(anchorEl) ? $('src') : null
  if (!host) return null
  const text = String(selection.toString() || '').trim()
  if (!text) return null
  return { text, rect: selection.getRangeAt(0).getBoundingClientRect() }
}

async function saveSelection(text, button) {
  const entry = state.entry
  if (!entry) return
  button.setAttribute('aria-busy', 'true')
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'VOCABULARY_SAVE',
      payload: {
        text,
        meaning: entry.translatedText || resultPlainText(entry),
        context: entry.text,
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

function toggleSpeech(text = state.entry?.text) {
  if (state.speechId) {
    stopSpeech()
    renderActions()
    return
  }
  if (!text) return
  const speechId = makeId('speech')
  state.speechId = speechId
  try {
    chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId, text } }, (response) => {
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
    const cardRect = $('card').getBoundingClientRect()
    let height = cardRect.height
    const menu = document.querySelector('.action-menu:not([hidden])')
    if (menu) height += Math.max(0, menu.getBoundingClientRect().bottom - cardRect.bottom) + 8
    height = Math.ceil(height)
    if (Math.abs(height - lastRequestedHeight) < 4) return
    lastRequestedHeight = height
    window.sttDesktop.resizeCard(height)
  })
}

function render() {
  hideSelectionToolbar()
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

function closeActionMenu() {
  const menu = document.querySelector('.action-menu:not([hidden])')
  if (!menu) return
  menu.hidden = true
  const more = menu.previousElementSibling
  if (more) more.setAttribute('aria-expanded', 'false')
  scheduleResize()
}

function regenerate() {
  const entry = state.entry
  if (!entry) return
  entry.requestId = makeId('r')
  entry.status = 'pending'
  entry.translatedText = ''
  entry.lexical = null
  entry.error = ''
  state.reported = false
  render()
  sendRequest(true)
}

function cancelRequest() {
  const entry = state.entry
  if (!entry) return
  cancelActiveRequest()
  entry.status = 'error'
  entry.error = '已取消请求,可以重新生成。'
  render()
  reportEntry()
}

function renderActions() {
  const entry = state.entry
  const bar = $('actions')
  bar.replaceChildren()
  if (!entry) return
  const add = (label, handler, variant = '') => {
    const button = el('button', variant, label)
    button.type = 'button'
    button.addEventListener('click', handler)
    bar.append(button)
    return button
  }

  if (entry.status === 'done' && entry.translatedText) {
    add(ACTION_LABELS.copyResult, (event) => copyText(resultPlainText(entry), event.currentTarget), 'is-primary')
  }
  add(state.speechId ? ACTION_LABELS.stopSpeak : ACTION_LABELS.speak, () => toggleSpeech())
  const isBusy = ['pending', 'loading', 'streaming'].includes(entry.status)
  if (isBusy) add(ACTION_LABELS.cancel, cancelRequest, 'is-danger')

  const more = add('⋯', (event) => {
    event.stopPropagation()
    const wasOpen = !menu.hidden
    closeActionMenu()
    if (!wasOpen) {
      menu.hidden = false
      more.setAttribute('aria-expanded', 'true')
      scheduleResize()
    }
  }, 'action-more')
  more.setAttribute('aria-label', '更多操作')
  more.setAttribute('aria-expanded', 'false')

  const menu = el('div', 'action-menu')
  menu.hidden = true
  const menuAdd = (label, handler, variant = '') => {
    const button = el('button', variant, label)
    button.type = 'button'
    button.addEventListener('click', () => {
      closeActionMenu()
      handler(button)
    })
    menu.append(button)
  }
  menuAdd(ACTION_LABELS.copySource, () => copyText(entry.text))
  if (entry.status === 'done' && resultPlainText(entry)) {
    menuAdd('朗读译文', () => toggleSpeech(resultPlainText(entry)))
  }
  if (entry.status === 'done') {
    menuAdd('收藏', (button) => void saveVocabulary(button))
  }
  if (!isBusy) menuAdd(ACTION_LABELS.regenerate, regenerate)
  menuAdd('在主窗口打开', openInMainWindow)
  bar.append(menu)
}

function bind() {
  $('btn-close').addEventListener('click', () => window.sttDesktop.hideCard())
  $('btn-popout').addEventListener('click', openInMainWindow)
  $('btn-pin').addEventListener('click', () => setPinned(!state.pinned))
  document.addEventListener('click', (event) => {
    const menu = document.querySelector('.action-menu:not([hidden])')
    if (menu && !menu.contains(event.target) && !menu.previousElementSibling?.contains(event.target)) closeActionMenu()
    const toolbar = $('selection-toolbar')
    if (!toolbar.hidden && !toolbar.contains(event.target)) hideSelectionToolbar()
  })
  $('result').addEventListener('mouseup', () => {
    setTimeout(() => {
      const found = selectionInResult()
      if (found) showSelectionToolbar(found.text, found.rect)
      else hideSelectionToolbar()
    }, 0)
  })
  $('result').addEventListener('scroll', hideSelectionToolbar, { passive: true })
  let isPointerDown = false
  let selectionFeedback = false
  let selectionTimer = 0
  document.addEventListener('mousedown', () => { isPointerDown = true })
  document.addEventListener('mouseup', () => { isPointerDown = false })
  document.addEventListener('selectionchange', () => {
    if (isPointerDown || selectionFeedback) return
    clearTimeout(selectionTimer)
    selectionTimer = setTimeout(() => {
      const found = selectionInResult()
      if (found) showSelectionToolbar(found.text, found.rect)
      else hideSelectionToolbar()
    }, 0)
  })
  $('selection-toolbar').addEventListener('mousedown', (event) => event.preventDefault())
  $('selection-toolbar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sel-action]')
    if (!button || !state.selection) return
    const { text } = state.selection
    const action = button.dataset.selAction
    if (action === 'copy') {
      copyText(text, button)
      selectionFeedback = true
      setTimeout(() => {
        selectionFeedback = false
        hideSelectionToolbar()
        window.getSelection()?.removeAllRanges()
      }, 1400)
      return
    }
    if (action === 'speak') {
      toggleSpeech(text)
    } else if (action === 'translate') {
      startSelection({ text })
    } else if (action === 'save') {
      void saveSelection(text, button)
      selectionFeedback = true
      setTimeout(() => {
        selectionFeedback = false
        hideSelectionToolbar()
        window.getSelection()?.removeAllRanges()
      }, 1400)
      return
    }
    hideSelectionToolbar()
    window.getSelection()?.removeAllRanges()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!$('selection-toolbar').hidden) {
      hideSelectionToolbar()
      return
    }
    if (document.querySelector('.action-menu:not([hidden])')) {
      closeActionMenu()
      return
    }
    window.sttDesktop.hideCard()
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
