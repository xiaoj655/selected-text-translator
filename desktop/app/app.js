const $ = (id) => document.getElementById(id)

const state = {
  mode: 'translate',
  entries: [],
  counter: 0,
  configured: false,
  speechId: null,
  hotkey: '',
  capture: null,
  prefs: { pasteAutoSubmit: true, enterToSend: false },
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

function setStatus(text) {
  $('statusbar').textContent = text
}

function updateComposer() {
  const input = $('input')
  input.style.height = 'auto'
  input.style.height = `${Math.min(160, Math.max(38, input.scrollHeight))}px`
  $('char-count').textContent = `${input.value.trim().length} 字`
  $('composer-hint').textContent = state.prefs.enterToSend
    ? 'Enter 发送 · Shift+Enter 换行' : 'Ctrl+Enter 发送 · Enter 换行'
}

async function savePrefs() {
  try {
    await chrome.storage.sync.set({ desktop_prefs: state.prefs })
  } catch {
    // preferences are best effort
  }
}

function applyPrefs() {
  $('opt-paste').checked = state.prefs.pasteAutoSubmit !== false
  $('opt-enter').checked = state.prefs.enterToSend === true
  updateComposer()
}

function showNotice(text, kind = 'info', action) {
  const node = $('notice')
  node.replaceChildren(el('span', '', text))
  if (action) {
    const button = el('button', '', action.label)
    button.type = 'button'
    button.addEventListener('click', action.run)
    node.append(button)
  }
  node.dataset.kind = kind
  node.hidden = false
}

function hideNotice() {
  $('notice').hidden = true
}

async function checkConfig() {
  try {
    const values = await chrome.storage.sync.get(['base_url', 'api_key', 'model', 'learning_model'])
    state.configured = Boolean(values?.base_url && values?.api_key && values?.model)
  } catch {
    state.configured = false
  }
  if (!state.configured) {
    showNotice('还没有连接模型。填写 API 地址、Key 和模型后才能翻译。', 'info', {
      label: '去设置',
      run: () => window.sttDesktop.openSettings(),
    })
  } else if ($('notice').dataset.kind !== 'error') {
    hideNotice()
  }
}

function renderModes() {
  for (const button of document.querySelectorAll('.mode')) {
    button.classList.toggle('is-active', button.dataset.mode === state.mode)
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode))
  }
}

async function setMode(mode) {
  if (!['translate', 'guide'].includes(mode) || mode === state.mode) return
  state.mode = mode
  renderModes()
  try {
    await chrome.storage.sync.set({ reading_mode: mode })
  } catch {
    // mode still applies for this session
  }
  $('input').focus()
}

function sendRequest(entry, forceRefresh = false) {
  setStatus(`${forceRefresh ? '重新生成' : '请求中'} · ${entry.mode === 'guide' ? '引导理解' : '翻译'} · ${entry.text.length} 字`)
  try {
    chrome.runtime.sendMessage({
      type: 'START_TRANSLATION',
      payload: {
        selectionId: entry.id,
        requestId: entry.requestId,
        kind: entry.mode,
        forceRefresh,
        text: entry.text,
        context: '',
        contextStart: null,
        contextEnd: null,
      },
    }, (response) => {
      if (!response?.accepted) failEntry(entry, '后台没有接受请求,请重试。')
    })
  } catch {
    failEntry(entry, '无法连接后台,请重启应用。')
  }
}

function failEntry(entry, message) {
  entry.status = 'error'
  entry.error = message
  setStatus(message)
  renderEntry(entry)
}

function submit() {
  const text = $('input').value.trim()
  if (!text) {
    $('input').focus()
    setStatus('请输入或粘贴要翻译的内容')
    return
  }
  if (!state.configured) {
    void checkConfig()
    setStatus('请先完成模型设置')
    return
  }
  const entry = {
    id: makeId('s'),
    requestId: makeId('r'),
    text,
    mode: state.mode,
    status: 'pending',
    translatedText: '',
    lexical: null,
    guide: null,
    error: '',
    createdAt: Date.now(),
    hintCount: 1,
    answerRevealed: false,
  }
  state.entries.push(entry)
  $('input').value = ''
  updateComposer()
  hideNotice()
  render()
  sendRequest(entry)
  $('input').focus()
}

function handleTranslationEvent(payload) {
  const entry = state.entries.find((item) => item.requestId === payload.requestId)
  if (!entry) return
  switch (payload.status) {
    case 'started':
      entry.status = 'loading'
      break
    case 'stream':
      entry.status = 'streaming'
      entry.translatedText = String(payload.translatedText || '').trim()
      break
    case 'success':
      entry.status = 'done'
      if (entry.mode === 'guide') entry.guide = payload.result || null
      else {
        entry.translatedText = String(payload.translatedText || entry.translatedText || '').trim()
        entry.lexical = payload.lexicalDetails || null
      }
      setStatus(`完成 · ${Date.now() - entry.createdAt} ms`)
      break
    case 'missing-configuration':
    case 'error':
      entry.status = 'error'
      entry.error = payload.message || '请求失败,请重试。'
      setStatus(entry.error)
      if (payload.status === 'missing-configuration') void checkConfig()
      break
    default:
      return
  }
  renderEntry(entry)
}

function handleSpeechEvent(payload) {
  if (payload.speechId !== state.speechId) return
  if (!['end', 'error', 'interrupted', 'cancelled'].includes(payload.status)) return
  state.speechId = null
  if (payload.message) setStatus(payload.message)
  render()
}

function resultText(entry) {
  if (entry.mode === 'guide') return entry.guide?.answer?.meaning || ''
  return entry.translatedText
}

function renderEmpty() {
  const box = el('div', 'empty')
  box.append(el('h2', '', '随时查词、翻译,或理解一句话'))
  const line1 = el('p', '', '在输入框粘贴或输入文字即可开始;图片、PDF、视频里不能选中的文字也适用。')
  box.append(line1)
  const line2 = el('p')
  line2.append('选中文字后按全局热键(')
  line2.append(el('kbd', '', state.hotkey || 'Alt+Shift+E'))
  line2.append(')可自动带入并翻译;取不到词时窗口仍会打开,等你粘贴。')
  box.append(line2)
  return box
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

function renderGuide(entry) {
  const guide = entry.guide
  if (!guide) return null
  const box = document.createDocumentFragment()
  if (guide.phonetic) box.append(lexicalRow('音标', guide.phonetic))
  if (Array.isArray(guide.hints) && guide.hints.length) {
    const hints = el('div', 'hints')
    guide.hints.forEach((hint, index) => {
      hints.append(el('div', index < entry.hintCount ? 'hint' : 'hint is-hidden',
        index < entry.hintCount ? `${index + 1}. ${hint}` : '再提示一点,查看下一条线索'))
    })
    box.append(hints)
    if (entry.hintCount < guide.hints.length) {
      const more = el('button', '', '再提示一点')
      more.type = 'button'
      more.addEventListener('click', () => {
        entry.hintCount += 1
        renderEntry(entry)
      })
      box.append(more)
    }
  }
  const answer = guide.answer
  if (answer) {
    const reveal = el('button', '', entry.answerRevealed ? '收起答案' : '揭晓答案')
    reveal.type = 'button'
    reveal.addEventListener('click', () => {
      entry.answerRevealed = !entry.answerRevealed
      renderEntry(entry)
    })
    box.append(reveal)
    if (entry.answerRevealed) {
      const panel = el('div', 'answer')
      if (answer.meaning) {
        const p = el('p')
        p.append(el('strong', '', '含义:'), ` ${answer.meaning}`)
        panel.append(p)
      }
      if (answer.explanation) {
        const p = el('p')
        p.append(el('strong', '', '解释:'), ` ${answer.explanation}`)
        panel.append(p)
      }
      if (answer.example) {
        const p = el('p')
        p.append(el('strong', '', '例句:'), ` ${answer.example}`)
        panel.append(p)
      }
      if (answer.usage) {
        const p = el('p')
        p.append(el('strong', '', '用法:'), ` ${answer.usage}`)
        panel.append(p)
      }
      box.append(panel)
    }
  }
  return box
}

function renderResult(entry) {
  const result = el('div', 'result')
  if (entry.status === 'error') {
    result.classList.add('is-error')
    result.textContent = entry.error
    return result
  }
  if (entry.status === 'pending' || entry.status === 'loading') {
    result.classList.add('is-loading')
    result.textContent = '正在请求模型…'
    return result
  }
  if (entry.mode === 'guide') {
    if (entry.guide) {
      const guide = renderGuide(entry)
      if (guide) result.append(guide)
      else result.textContent = '没有生成引导内容,可以重新生成。'
    } else {
      result.textContent = '没有生成引导内容,可以重新生成。'
    }
    return result
  }
  if (!entry.translatedText) {
    result.classList.add('is-loading')
    result.textContent = '等待译文…'
    return result
  }
  result.textContent = entry.translatedText
  if (entry.status === 'streaming') result.append(el('span', 'caret'))
  const lexical = renderLexical(entry)
  if (lexical) result.append(lexical)
  return result
}

function renderActions(entry) {
  const bar = el('div', 'actions')
  const add = (label, handler, options = {}) => {
    const button = el('button', '', label)
    button.type = 'button'
    if (options.danger) button.classList.add('is-danger')
    button.addEventListener('click', handler)
    bar.append(button)
    return button
  }

  const text = resultText(entry)
  if (text && entry.status === 'done') {
    add('复制结果', () => {
      window.sttDesktop.copyText(text)
      setStatus('结果已复制到剪贴板')
    })
  }
  add(state.speechId ? '■ 停止朗读' : '▷ 朗读原文', () => toggleSpeech(entry))
  add('重新生成', () => regenerate(entry))
  add('收藏', (event) => void saveVocabulary(entry, event.currentTarget))
  add('删除', () => {
    state.entries = state.entries.filter((item) => item.id !== entry.id)
    render()
  }, { danger: true })
  return bar
}

function renderEntryEl(entry) {
  const wrapper = el('div', 'entry')
  wrapper.dataset.entryId = entry.id

  const source = el('div', 'entry-source')
  source.append(el('div', 'bubble', entry.text))
  wrapper.append(source)

  const card = el('div', 'entry-card')
  const head = el('div', 'entry-head')
  head.append(el('span', 'tag', entry.mode === 'guide' ? '引导理解' : '翻译'))
  head.append(el('span', '', new Date(entry.createdAt).toLocaleTimeString()))
  head.append(el('span', 'spacer'))
  head.append(el('span', '', `${entry.text.length} 字`))
  card.append(head)
  card.append(renderResult(entry))
  card.append(renderActions(entry))
  wrapper.append(card)
  return wrapper
}

function render() {
  const stream = $('stream')
  stream.replaceChildren()
  if (!state.entries.length) stream.append(renderEmpty())
  else for (const entry of state.entries) stream.append(renderEntryEl(entry))
  stream.scrollTop = stream.scrollHeight
}

function renderEntry(entry) {
  const stream = $('stream')
  const node = stream.querySelector(`[data-entry-id="${entry.id}"]`)
  if (!node) {
    render()
    return
  }
  node.replaceWith(renderEntryEl(entry))
  if (['pending', 'loading', 'streaming'].includes(entry.status)) stream.scrollTop = stream.scrollHeight
}

function regenerate(entry) {
  entry.requestId = makeId('r')
  entry.status = 'pending'
  entry.translatedText = ''
  entry.lexical = null
  entry.guide = null
  entry.error = ''
  entry.createdAt = Date.now()
  entry.hintCount = 1
  entry.answerRevealed = false
  renderEntry(entry)
  sendRequest(entry, true)
}

function toggleSpeech(entry) {
  if (state.speechId) {
    const speechId = state.speechId
    state.speechId = null
    try {
      chrome.runtime.sendMessage({ type: 'STOP_SPEECH', payload: { speechId } }, () => {})
    } catch {
      // ignore
    }
    render()
    return
  }
  const speechId = makeId('speech')
  state.speechId = speechId
  setStatus('正在朗读…')
  try {
    chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId, text: entry.text } }, (response) => {
      if (!response?.ok && state.speechId === speechId) {
        state.speechId = null
        setStatus(response?.message || '朗读不可用')
        render()
      }
    })
  } catch {
    state.speechId = null
    setStatus('朗读不可用')
  }
  render()
}

async function saveVocabulary(entry, button) {
  const meaning = resultText(entry)
  if (!meaning || entry.status !== 'done') return
  button.setAttribute('aria-busy', 'true')
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'VOCABULARY_SAVE',
      payload: {
        text: entry.text,
        meaning,
        context: '',
        contextStart: null,
        contextEnd: null,
        usage: '',
        explanation: '',
        example: '',
        phonetic: entry.lexical?.phonetic || entry.guide?.phonetic || '',
        sourceUrl: '',
      },
    })
    button.textContent = response?.ok ? '✓ 已收藏' : '收藏失败'
    setStatus(response?.ok ? '已加入表达本' : '收藏失败')
  } catch {
    button.textContent = '收藏失败'
  }
  button.removeAttribute('aria-busy')
}

function bind() {
  $('modes').addEventListener('click', (event) => {
    const button = event.target.closest('.mode')
    if (button) void setMode(button.dataset.mode)
  })
  $('btn-send').addEventListener('click', submit)
  $('btn-settings').addEventListener('click', () => window.sttDesktop.openSettings())
  $('btn-library').addEventListener('click', () => window.sttDesktop.openLibrary())
  $('btn-clear').addEventListener('click', () => {
    state.entries = []
    render()
    setStatus('已清空对话')
    $('input').focus()
  })
  const input = $('input')
  input.addEventListener('input', updateComposer)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      window.sttDesktop.hide()
      return
    }
    if (event.key !== 'Enter') return
    const modifier = event.ctrlKey || event.metaKey
    const shouldSubmit = state.prefs.enterToSend
      ? (!modifier && !event.shiftKey)
      : modifier
    if (!shouldSubmit) return
    event.preventDefault()
    submit()
  })
  input.addEventListener('paste', () => {
    if (state.prefs.pasteAutoSubmit === false) return
    setTimeout(() => {
      if (input.value.trim()) submit()
      else updateComposer()
    }, 0)
  })
  $('btn-clear-input').addEventListener('click', () => {
    input.value = ''
    updateComposer()
    input.focus()
  })
  $('opt-paste').addEventListener('change', (event) => {
    state.prefs.pasteAutoSubmit = event.target.checked
    void savePrefs()
    setStatus(event.target.checked ? '粘贴后会自动翻译' : '粘贴后需手动点翻译')
  })
  $('opt-enter').addEventListener('change', (event) => {
    state.prefs.enterToSend = event.target.checked
    void savePrefs()
    updateComposer()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.sttDesktop.hide()
  })

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TRANSLATION_EVENT') handleTranslationEvent(message.payload || {})
    else if (message?.type === 'SPEECH_EVENT') handleSpeechEvent(message.payload || {})
  })
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    if (['base_url', 'api_key', 'model', 'learning_model'].some((key) => key in changes)) void checkConfig()
  })

  window.sttDesktop.onSelection((payload) => {
    state.capture = payload
    const text = String(payload?.text || '').trim()
    void checkConfig()
    if (text) {
      $('input').value = text
      updateComposer()
      setStatus(`已取到 ${text.length} 字 · 来源:${payload.source || '剪贴板'}`)
      submit()
    } else {
      setStatus('没有取到选中文字,可以直接粘贴到这里翻译')
      showNotice('没能自动取词。把文字粘贴到下面的输入框即可,或先复制再按热键。', 'info')
      $('input').focus()
    }
  })
  window.sttDesktop.onStatus((info) => {
    if (info?.hotkey) state.hotkey = info.hotkey
    if (info?.message) setStatus(info.message)
    if (!state.entries.length) render()
  })
}

async function init() {
  bind()
  try {
    const saved = await chrome.storage.sync.get(['reading_mode'])
    state.mode = saved?.reading_mode === 'guide' ? 'guide' : 'translate'
  } catch {
    // default mode
  }
  renderModes()
  try {
    const savedPrefs = await chrome.storage.sync.get(['desktop_prefs'])
    if (savedPrefs?.desktop_prefs && typeof savedPrefs.desktop_prefs === 'object') {
      state.prefs = { ...state.prefs, ...savedPrefs.desktop_prefs }
    }
  } catch {
    // default preferences
  }
  applyPrefs()
  await checkConfig()
  try {
    state.hotkey = await window.sttDesktop.getHotkey()
  } catch {
    state.hotkey = ''
  }
  render()
  $('input').focus()
}

void init()
