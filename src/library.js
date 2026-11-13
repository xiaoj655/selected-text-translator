import { getDueEntries, MAX_BACKUP_FILE_BYTES, scheduleReview, serializeVocabularyBackup } from './vocabulary-store.js'
import { createLibraryAudio, getEntrySpeechTargets } from './library-audio.js'

const allTabEl = document.getElementById('all-tab')
const reviewTabEl = document.getElementById('review-tab')
const allViewEl = document.getElementById('all-view')
const reviewViewEl = document.getElementById('review-view')
const listEl = document.getElementById('entry-list')
const reviewCardEl = document.getElementById('review-card')
const searchEl = document.getElementById('vocabulary-search')
const loadMoreEl = document.getElementById('load-more')
const exportEl = document.getElementById('export-vocabulary')
const importEl = document.getElementById('import-vocabulary')
const importFileEl = document.getElementById('import-vocabulary-file')
const statusEl = document.getElementById('library-status')
const stopSpeechEl = document.getElementById('stop-library-speech')
const undoNoticeEl = document.getElementById('undo-notice')
const undoMessageEl = document.getElementById('undo-message')
const undoEl = document.getElementById('undo-removal')
const state = { entries: [], mode: 'all', visibleCount: 30, reviewQueue: [], reviewIndex: 0,
  isRevealed: false, isBusy: false, refreshPending: false, shouldRefresh: false, dueTimerId: null,
  reviewEntryId: '', lastRemovedEntry: null, isUndoBusy: false }
const libraryAudio = createLibraryAudio({ send, onChange: updateSpeechControls, onStatus: setStatus })

void init()

function createEl(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function createButton(text, handler, className = '') {
  const buttonEl = createEl('button', className, text)
  buttonEl.type = 'button'
  buttonEl.addEventListener('click', handler)
  return buttonEl
}

function setStatus(message = '', isError = false) {
  statusEl.textContent = message
  statusEl.dataset.tone = isError ? 'error' : 'success'
}

async function send(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, payload })
    return response || { ok: false, message: 'Unable to reach your vocabulary book. Reload the extension.' }
  } catch {
    return { ok: false, message: 'Unable to reach your vocabulary book. Reload the extension.' }
  }
}

async function init() {
  try {
    allTabEl.addEventListener('click', () => selectView('all'))
    reviewTabEl.addEventListener('click', () => selectView('review'))
    searchEl.addEventListener('input', () => { state.visibleCount = 30; renderList() })
    loadMoreEl.addEventListener('click', () => { state.visibleCount += 30; renderList() })
    exportEl.addEventListener('click', () => void downloadBackup())
    importEl.addEventListener('click', () => importFileEl.click())
    importFileEl.addEventListener('change', () => void restoreBackup())
    undoEl.addEventListener('click', () => void undoRemoval())
    stopSpeechEl.addEventListener('click', () => void libraryAudio.stop())
    document.addEventListener('keydown', handleReviewKeydown)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void libraryAudio.stop()
    })
    window.addEventListener('pagehide', () => void libraryAudio.stop())
    window.addEventListener('focus', () => void refresh())
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'SPEECH_EVENT') libraryAudio.handleEvent(message.payload)
    })
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.vocabulary_entries || state.refreshPending) return
      state.refreshPending = true
      queueMicrotask(() => { state.refreshPending = false; void refresh() })
    })
    await refresh()
  } catch {
    setStatus('无法载入表达本，请重新打开页面。', true)
  }
}

async function refresh() {
  if (state.isBusy) { state.shouldRefresh = true; return }
  try {
    const response = await send('VOCABULARY_LIST')
    if (!response.ok) { setStatus(response.message || '无法读取收藏，请重试。', true); return }
    if (state.isBusy) { state.shouldRefresh = true; return }
    state.shouldRefresh = false
    state.entries = Array.isArray(response.entries) ? response.entries : []
    if (!state.entries.some((entry) => libraryAudio.getActiveKey().startsWith(`${entry.id}:`))) {
      void libraryAudio.stop()
    }
    updateCounts()
    if (state.mode === 'review') renderReview()
    else renderList()
  } catch {
    setStatus('无法读取收藏，请重试。', true)
  }
}

function updateCounts() {
  const due = getDueEntries(state.entries, Date.now()).length
  document.getElementById('all-count').textContent = state.entries.length
  document.getElementById('due-count').textContent = due
  document.getElementById('library-count').textContent = `${state.entries.length} 个词与表达 · ${due} 个待复习`
  exportEl.disabled = state.entries.length === 0
  scheduleDueRefresh()
}

function scheduleDueRefresh() {
  if (state.dueTimerId) clearTimeout(state.dueTimerId)
  const now = Date.now()
  const nextDue = state.entries.reduce((next, entry) => entry.dueAt > now ? Math.min(next, entry.dueAt) : next, Infinity)
  if (!Number.isFinite(nextDue)) return
  state.dueTimerId = setTimeout(() => void refresh(), Math.min(nextDue - now + 50, 3600000))
}

function selectView(mode) {
  if (state.mode === mode || state.isBusy) return
  void libraryAudio.stop()
  state.lastRemovedEntry = null
  renderUndoNotice()
  state.mode = mode
  allTabEl.setAttribute('aria-pressed', String(mode === 'all'))
  reviewTabEl.setAttribute('aria-pressed', String(mode === 'review'))
  allViewEl.classList.toggle('hidden', mode !== 'all')
  reviewViewEl.classList.toggle('hidden', mode !== 'review')
  setStatus()
  if (mode === 'review') {
    startReviewSession()
    reviewCardEl.querySelector('.review-reveal')?.focus({ preventScroll: true })
  } else renderList()
}

function startReviewSession() {
  state.reviewQueue = getDueEntries(state.entries, Date.now()).map((entry) => entry.id)
  state.reviewIndex = 0
  state.isRevealed = false
  renderReview()
}

function createEmptyState(title, text, symbol = 'Aa') {
  const emptyEl = createEl('div', 'empty-state')
  emptyEl.append(createEl('div', 'empty-symbol', symbol), createEl('h2', '', title), createEl('p', '', text))
  return emptyEl
}

function renderList() {
  const query = searchEl.value.trim().toLocaleLowerCase('en-US')
  const entries = state.entries.filter((entry) => `${entry.text} ${entry.context} ${entry.meaning}`
    .toLocaleLowerCase('en-US').includes(query))
  const visibleEntries = entries.slice(0, state.visibleCount)
  const openIds = new Set(Array.from(listEl.querySelectorAll('.entry-card[open]'), (el) => el.dataset.entryId))
  if (!visibleEntries.some((entry) => libraryAudio.getActiveKey().startsWith(`${entry.id}:`))) {
    void libraryAudio.stop()
  }
  listEl.replaceChildren()
  if (!entries.length) {
    listEl.appendChild(createEmptyState(query ? '还没有找到这个词。' : '从一次阅读里的心动开始。',
      query ? '换一个单词、表达或原句试试。' : '在阅读卡片中保存词与表达，它们会带着语境留在这里。'))
  }
  for (const entry of visibleEntries) {
    const cardEl = createEntryCard(entry)
    cardEl.open = openIds.has(entry.id)
    listEl.appendChild(cardEl)
  }
  loadMoreEl.classList.toggle('hidden', entries.length <= state.visibleCount)
  updateSpeechControls()
}

function createContext(entry) {
  return createEl('p', 'entry-context', entry.context || 'No surrounding sentence was saved with this selection.')
}

function appendAnswer(containerEl, entry) {
  containerEl.append(createEl('span', 'answer-label', 'WHAT IT MEANS HERE'),
    createEl('p', 'entry-meaning', entry.meaning))
  if (entry.explanation) containerEl.appendChild(createEl('p', 'entry-explanation', entry.explanation))
  if (entry.usage) {
    containerEl.append(createEl('span', 'answer-label', 'A WAY TO USE IT'), createEl('p', 'entry-usage', entry.usage))
  }
  if (entry.example) {
    containerEl.append(createEl('span', 'answer-label', 'MAKE IT YOURS'), createEl('p', 'entry-example', entry.example))
    const text = getEntrySpeechTargets(entry).example
    if (text) containerEl.appendChild(createSpeechButton(entry, 'example', text, '读例句'))
  }
}

function createSpeechButton(entry, target, text, label) {
  const key = `${entry.id}:${target}`
  const buttonEl = createButton('', () => void libraryAudio.toggle(key, text), 'secondary library-speech-button')
  buttonEl.dataset.speechKey = key
  buttonEl.dataset.speechTarget = target
  buttonEl.dataset.idleLabel = `▷ ${label}`
  buttonEl.disabled = !text
  if (text) buttonEl.title = text
  else buttonEl.title = '这段内容超过 1200 字，暂时无法朗读。'
  updateSpeechButton(buttonEl)
  return buttonEl
}

function createSpeechControls(entry) {
  const controlsEl = createEl('div', 'library-speech-controls')
  const targets = getEntrySpeechTargets(entry)
  const wordLabel = /^\p{L}+(?:['’-]\p{L}+)*$/u.test(String(entry.text || '').trim()) ? '读词' : '朗读选区'
  controlsEl.appendChild(createSpeechButton(entry, 'word', targets.word, wordLabel))
  if (targets.context) {
    controlsEl.appendChild(createSpeechButton(entry, 'context', targets.context, targets.contextLabel))
  }
  return controlsEl
}

function updateSpeechButton(buttonEl) {
  const isActive = libraryAudio.getActiveKey() === buttonEl.dataset.speechKey
  buttonEl.textContent = isActive ? '■ 停止' : buttonEl.dataset.idleLabel
  buttonEl.setAttribute('aria-pressed', String(isActive))
}

function updateSpeechControls() {
  for (const buttonEl of document.querySelectorAll('.library-speech-button')) updateSpeechButton(buttonEl)
  const key = libraryAudio.getActiveKey()
  const viewEl = state.mode === 'review' ? reviewCardEl : listEl
  const hasVisibleControl = Array.from(viewEl.querySelectorAll('.library-speech-button')).some((buttonEl) => {
    const cardEl = buttonEl.closest('.entry-card')
    return buttonEl.dataset.speechKey === key && (!cardEl || cardEl.open)
  })
  stopSpeechEl.classList.toggle('hidden', !key || hasVisibleControl)
}

function createEntryCard(entry) {
  const cardEl = createEl('details', 'entry-card')
  cardEl.dataset.entryId = entry.id
  cardEl.addEventListener('toggle', () => {
    if (!cardEl.open && libraryAudio.getActiveKey().startsWith(`${entry.id}:`)) void libraryAudio.stop()
  })
  const summaryEl = createEl('summary')
  summaryEl.append(createEl('span', 'entry-title', entry.text),
    createEl('span', 'entry-meta', new Date(entry.createdAt).toLocaleDateString()))
  const bodyEl = createEl('div', 'entry-body')
  if (entry.phonetic) bodyEl.appendChild(createEl('p', 'entry-phonetic', entry.phonetic))
  bodyEl.appendChild(createSpeechControls(entry))
  bodyEl.append(createEl('span', 'context-label', 'WHERE YOU MET IT'), createContext(entry))
  appendAnswer(bodyEl, entry)
  const actionsEl = createEl('div', 'entry-actions')
  const sourceEl = createEl('span')
  try {
    const url = new URL(entry.sourceUrl)
    if (['http:', 'https:'].includes(url.protocol)) {
      const linkEl = createEl('a', '', `${url.hostname} ↗`)
      linkEl.href = url.href
      linkEl.target = '_blank'
      linkEl.rel = 'noopener noreferrer'
      sourceEl.appendChild(linkEl)
    }
  } catch { }
  const removeEl = createButton('移除', () => void removeEntry(entry.id, removeEl), 'secondary')
  removeEl.setAttribute('aria-label', `移除 ${entry.text}`)
  actionsEl.append(sourceEl, removeEl)
  bodyEl.appendChild(actionsEl)
  cardEl.append(summaryEl, bodyEl)
  return cardEl
}

async function removeEntry(id, buttonEl) {
  const originalEntry = state.entries.find((entry) => entry.id === id)
  if (libraryAudio.getActiveKey().startsWith(`${id}:`)) void libraryAudio.stop()
  buttonEl.disabled = true
  try {
    const response = await send('VOCABULARY_REMOVE', { id })
    if (!response.ok) { setStatus(response.message || '移除失败，请重试。', true); return }
    state.lastRemovedEntry = response.entry || originalEntry || null
    renderUndoNotice()
    state.entries = state.entries.filter((entry) => entry.id !== id)
    updateCounts()
    renderList()
    setStatus()
  } catch {
    setStatus('移除失败，请重试。', true)
  } finally {
    buttonEl.disabled = false
  }
}

function renderUndoNotice() {
  const entry = state.lastRemovedEntry
  undoNoticeEl.classList.toggle('hidden', !entry)
  undoMessageEl.textContent = entry ? `已移除“${entry.text}”。` : ''
  undoEl.disabled = state.isUndoBusy
  undoEl.textContent = state.isUndoBusy ? '正在恢复…' : '撤销'
}

async function undoRemoval() {
  const entry = state.lastRemovedEntry
  if (!entry || state.isUndoBusy) return
  state.isUndoBusy = true
  renderUndoNotice()
  try {
    const response = await send('VOCABULARY_IMPORT', {
      data: { version: 2, exportedAt: Date.now(), entries: [entry] },
    })
    if (!response.ok) { setStatus(response.message || '恢复失败，请再次点击撤销。', true); return }
    if (state.lastRemovedEntry === entry) state.lastRemovedEntry = null
    await refresh()
    setStatus('已恢复表达和原有复习进度。')
  } catch {
    setStatus('恢复失败，请再次点击撤销。', true)
  } finally {
    state.isUndoBusy = false
    renderUndoNotice()
  }
}

function getCurrentReviewEntry() {
  while (state.reviewIndex < state.reviewQueue.length) {
    const entry = state.entries.find((item) => item.id === state.reviewQueue[state.reviewIndex])
    if (entry && entry.dueAt <= Date.now()) return entry
    state.reviewIndex++
    state.isRevealed = false
  }
  return null
}

function renderReview() {
  const entry = getCurrentReviewEntry()
  if (state.reviewEntryId !== (entry?.id || '')) void libraryAudio.stop()
  state.reviewEntryId = entry?.id || ''
  reviewCardEl.replaceChildren()
  if (!entry) {
    const hasReviewed = state.reviewQueue.length > 0
    const emptyEl = createEmptyState(hasReviewed ? '今天的这一小步，完成了。' : '现在没有到期的表达。',
      hasReviewed ? '还不熟的表达会稍后再出现，记住的会隔几天再与你见面。'
        : '新收藏的词与表达从明天开始复习。现在继续读点喜欢的内容吧。', '✓')
    if (getDueEntries(state.entries, Date.now()).length) {
      emptyEl.appendChild(createButton('开始下一轮', startReviewSession, 'review-reveal'))
    }
    reviewCardEl.appendChild(emptyEl)
    updateSpeechControls()
    return
  }
  const cardEl = createEl('article', 'review-panel')
  cardEl.dataset.entryId = entry.id
  cardEl.appendChild(createEl('p', 'review-progress', `${state.reviewIndex + 1} / ${state.reviewQueue.length}`))
  const wordEl = createEl('h2', 'review-word', entry.text)
  if (entry.text.length > 70) wordEl.classList.add('passage')
  cardEl.appendChild(wordEl)
  if (entry.phonetic) cardEl.appendChild(createEl('p', 'entry-phonetic', entry.phonetic))
  cardEl.appendChild(createSpeechControls(entry))
  cardEl.append(createEl('span', 'context-label', 'REMEMBER THE MOMENT'), createContext(entry))
  if (!state.isRevealed) {
    cardEl.appendChild(createButton('想到了，揭晓释义', revealReviewAnswer, 'review-reveal'))
  } else {
    const answerEl = createEl('section', 'review-answer')
    answerEl.tabIndex = -1
    answerEl.setAttribute('aria-label', '表达释义')
    appendAnswer(answerEl, entry)
    const ratingEl = createEl('div', 'review-rating')
    const goodDays = scheduleReview(entry, 'good', Date.now()).intervalDays
    for (const [rating, label, interval] of [['again', '还不熟', '10 分钟后再看'], ['good', '记住了', `${goodDays} 天后再看`]]) {
      const buttonEl = createButton('', () => void rateEntry(entry.id, rating), rating === 'again' ? 'secondary' : '')
      buttonEl.append(createEl('span', '', label), createEl('small', '', interval))
      buttonEl.disabled = state.isBusy
      ratingEl.appendChild(buttonEl)
    }
    cardEl.append(answerEl, ratingEl)
  }
  reviewCardEl.appendChild(cardEl)
  updateSpeechControls()
}

function revealReviewAnswer() {
  if (state.isBusy || state.isRevealed || !getCurrentReviewEntry()) return
  state.isRevealed = true
  renderReview()
  reviewCardEl.querySelector('.review-answer')?.focus({ preventScroll: true })
}

function handleReviewKeydown(event) {
  if (state.mode !== 'review' || state.isBusy || event.repeat || event.isComposing) return
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const targetEl = event.target instanceof Element ? event.target : null
  if (targetEl?.closest('input, textarea, select, button, summary, a[href], [role="button"]')
    || targetEl?.isContentEditable) return
  const entry = getCurrentReviewEntry()
  if (!entry) return
  if ((event.code === 'Space' || event.key === ' ') && !state.isRevealed) {
    event.preventDefault()
    revealReviewAnswer()
  } else if (state.isRevealed && ['1', '2'].includes(event.key)) {
    event.preventDefault()
    void rateEntry(entry.id, event.key === '1' ? 'again' : 'good')
  }
}

async function rateEntry(id, rating) {
  if (state.isBusy || !state.isRevealed) return
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) return
  void libraryAudio.stop()
  state.isBusy = true
  renderReview()
  try {
    const response = await send('VOCABULARY_REVIEW', {
      id,
      rating,
      expectedDueAt: entry.dueAt,
      expectedReviewCount: entry.reviewCount,
    })
    if (!response.ok && response.code === 'review-changed' && response.entry) {
      state.entries = state.entries.map((item) => item.id === id ? response.entry : item)
      state.isRevealed = false
      updateCounts()
      setStatus('该表达已在另一处复习，已同步进度。')
      return
    }
    if (!response.ok) { setStatus(response.message || '保存复习进度失败，请重试。', true); return }
    state.entries = state.entries.map((entry) => entry.id === id ? response.entry : entry)
    state.reviewIndex++
    state.isRevealed = false
    setStatus()
    updateCounts()
  } catch {
    setStatus('保存复习进度失败，请重试。', true)
  } finally {
    state.isBusy = false
    renderReview()
    reviewCardEl.querySelector('.review-reveal')?.focus({ preventScroll: true })
    if (state.shouldRefresh) void refresh()
  }
}

async function downloadBackup() {
  exportEl.disabled = true
  try {
    const response = await send('VOCABULARY_EXPORT')
    if (!response.ok) { setStatus(response.message || '导出失败，请重试。', true); return }
    const url = URL.createObjectURL(new Blob([serializeVocabularyBackup(response.data)], { type: 'application/json' }))
    const linkEl = createEl('a')
    linkEl.href = url
    const date = new Date()
    const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')].join('-')
    linkEl.download = `selected-vocabulary-${stamp}.json`
    document.body.appendChild(linkEl)
    linkEl.click()
    linkEl.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus('已导出词汇与学习进度，不包含模型配置或密钥。')
  } catch {
    setStatus('导出失败，请重试。', true)
  } finally {
    exportEl.disabled = state.entries.length === 0
  }
}

async function restoreBackup() {
  const file = importFileEl.files?.[0]
  if (!file || importEl.disabled) return
  importEl.disabled = true
  try {
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setStatus('请选择不超过 5 MB 的表达本 JSON 备份。', true)
      return
    }
    let data
    try {
      data = JSON.parse(await file.text())
    } catch {
      setStatus('这份文件不是有效的 JSON 备份，原有收藏未改变。', true)
      return
    }
    const response = await send('VOCABULARY_IMPORT', { data })
    if (!response.ok) { setStatus(response.message || '导入失败，原有收藏未改变。', true); return }
    await refresh()
    setStatus(`已导入 ${response.added} 条，跳过 ${response.skipped} 条已有表达。原有复习进度已保留。`)
  } catch {
    setStatus('无法读取备份，请重试。', true)
  } finally {
    importEl.disabled = false
    importFileEl.value = ''
  }
}
