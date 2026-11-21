import { uiText, isDesktopUI } from './ui-language.js'
import { getDueEntries, MAX_BACKUP_FILE_BYTES, scheduleReview, serializeVocabularyBackup } from './vocabulary-store.js'
import { getStudyProgress } from './vocabulary-progress.js'
import { buildAnkiTsv, countAnkiRows } from './anki-export.js'
import { createLibraryAudio, getEntrySpeechTargets } from './library-audio.js'
import { getContextView } from './context-view.js'
import { createVocabularyDraft, getVocabularyDraftUpdate, serializeVocabularyDraft,
  setVocabularyDraftField, syncVocabularyDraft, VOCABULARY_EDIT_FIELDS } from './vocabulary-editor.js'

const allTabEl = document.getElementById('all-tab')
const reviewTabEl = document.getElementById('review-tab')
const allViewEl = document.getElementById('all-view')
const reviewViewEl = document.getElementById('review-view')
const listEl = document.getElementById('entry-list')
const reviewCardEl = document.getElementById('review-card')
const searchEl = document.getElementById('vocabulary-search')
const loadMoreEl = document.getElementById('load-more')
const exportEl = document.getElementById('export-vocabulary')
const exportAnkiEl = document.getElementById('export-anki')
const importEl = document.getElementById('import-vocabulary')
const importFileEl = document.getElementById('import-vocabulary-file')
const statusEl = document.getElementById('library-status')
const stopSpeechEl = document.getElementById('stop-library-speech')
const undoNoticeEl = document.getElementById('undo-notice')
const undoMessageEl = document.getElementById('undo-message')
const undoEl = document.getElementById('undo-removal')
const state = { entries: [], mode: 'all', visibleCount: 30, reviewQueue: [], reviewIndex: 0,
  isRevealed: false, isBusy: false, refreshPending: false, shouldRefresh: false, dueTimerId: null,
  reviewEntryId: '', lastRemovedEntry: null, isUndoBusy: false, draft: null, editorEl: null, draftNoticeEl: null }
const libraryAudio = createLibraryAudio({ send, onChange: updateSpeechControls, onStatus: setStatus })

if (window.sttDesktop) {
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = new URL('../../app/library.css', import.meta.url).href
  document.head.append(style)
  document.querySelector('.intro-row h1').textContent = 'Vocabulary'
  const applyAppearance = (prefs = {}) => {
    document.documentElement.dataset.theme = prefs?.theme || 'system'
    document.documentElement.dataset.font = prefs?.font || 'normal'
    document.documentElement.dataset.accent = prefs?.accent || 'neutral'
    document.documentElement.dataset.motion = prefs?.reducedMotion ? 'reduced' : 'full'
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.desktop_prefs) applyAppearance(changes.desktop_prefs.newValue)
  })
  void chrome.storage.sync.get('desktop_prefs')
    .then(({ desktop_prefs }) => applyAppearance(desktop_prefs))
    .catch(() => {})
}

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
    state.draftNoticeEl = createEl('section', 'draft-notice hidden')
    state.draftNoticeEl.setAttribute('aria-label', uiText('未保存的修订', 'Unsaved edits'))
    undoNoticeEl.after(state.draftNoticeEl)
    allTabEl.addEventListener('click', () => selectView('all'))
    reviewTabEl.addEventListener('click', () => selectView('review'))
    document.getElementById('start-review').addEventListener('click', () => selectView('review'))
    searchEl.addEventListener('input', () => { state.visibleCount = 30; renderList() })
    loadMoreEl.addEventListener('click', () => { state.visibleCount += 30; renderList() })
    exportEl.addEventListener('click', () => void downloadBackup())
    exportAnkiEl.addEventListener('click', () => void downloadAnki())
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
    setStatus(uiText('无法载入表达本，请重新打开页面。', 'Could not load your vocabulary. Reopen the page and try again.'), true)
  }
}

async function refresh() {
  if (state.isBusy) { state.shouldRefresh = true; return }
  try {
    const response = await send('VOCABULARY_LIST')
    if (!response.ok) { setStatus(response.message || uiText('无法读取收藏，请重试。', 'Could not load saved vocabulary. Try again.'), true); return }
    if (state.isBusy) { state.shouldRefresh = true; return }
    state.shouldRefresh = false
    state.entries = Array.isArray(response.entries) ? response.entries : []
    state.draft = syncVocabularyDraft(state.draft, state.entries.find((entry) => entry.id === state.draft?.id))
    updateEditorControls()
    if (!state.entries.some((entry) => libraryAudio.getActiveKey().startsWith(`${entry.id}:`))) {
      void libraryAudio.stop()
    }
    updateCounts()
    if (state.mode === 'review') renderReview()
    else renderList()
  } catch {
    setStatus(uiText('无法读取收藏，请重试。', 'Could not load saved vocabulary. Try again.'), true)
  }
}

function updateCounts() {
  const due = getDueEntries(state.entries, Date.now()).length
  document.getElementById('all-count').textContent = state.entries.length
  document.getElementById('due-count').textContent = due
  document.getElementById('library-count').textContent = uiText(`${state.entries.length} 个词与表达 · ${due} 个待复习`, `${state.entries.length} saved · ${due} due`)
  const progress = getStudyProgress(state.entries)
  document.getElementById('progress-due').textContent = progress.due
  document.getElementById('progress-learning').textContent = progress.learning
  document.getElementById('progress-mastered').textContent = progress.mastered
  document.getElementById('today-review-count').textContent = progress.due
  document.getElementById('today-review-reminder').hidden = progress.due === 0
  exportEl.disabled = state.entries.length === 0
  exportAnkiEl.disabled = state.entries.length === 0
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
  const editorFocus = getEditorFocus()
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
    listEl.appendChild(createEmptyState(query ? uiText('还没有找到这个词。', 'No matches') : uiText('从一次阅读里的心动开始。', 'No saved vocabulary yet'),
      query ? uiText('换一个单词、表达或原句试试。', 'Search for a different word, phrase, or sentence.') : uiText('在阅读卡片中保存词与表达，它们会带着语境留在这里。', 'Save words and phrases to review them here.')))
  }
  for (const entry of visibleEntries) {
    const cardEl = createEntryCard(entry)
    cardEl.open = openIds.has(entry.id) || entry.id === state.draft?.id
    listEl.appendChild(cardEl)
  }
  loadMoreEl.classList.toggle('hidden', entries.length <= state.visibleCount)
  renderDraftNotice()
  restoreEditorFocus(editorFocus)
  updateSpeechControls()
}

function createContext(entry, previousState = null) {
  const view = getContextView(entry)
  if (!view.text) {
    return createEl('p', 'entry-context', 'No surrounding sentence was saved with this selection.')
  }
  const contextEl = createEl('div', 'context-block')
  contextEl.appendChild(createContextText(view.segments))
  if (!view.hasLocation) {
    contextEl.appendChild(createEl('p', 'context-location-note', uiText('未记录具体位置', 'Position in the source text is unavailable.')))
  }
  if (view.isFocused) {
    const fullEl = createEl('details', 'context-full')
    const fullContextEl = createContextText(view.fullSegments)
    let restoredScrollTop = previousState?.isFullOpen ? previousState.fullScrollTop : null
    fullEl.open = Boolean(previousState?.isFullOpen)
    fullEl.append(createEl('summary', '', uiText('完整语境', 'Full context')), fullContextEl)
    fullEl.addEventListener('toggle', () => {
      if (!fullEl.open) return
      if (restoredScrollTop !== null) {
        fullContextEl.scrollTop = restoredScrollTop
        restoredScrollTop = null
      } else scrollContextTarget(fullContextEl)
    })
    contextEl.appendChild(fullEl)
  }
  return contextEl
}

function createContextText(segments) {
  const contextEl = createEl('p', 'entry-context')
  for (const segment of segments) {
    contextEl.appendChild(segment.isTarget
      ? createEl('mark', 'context-target', segment.text)
      : document.createTextNode(segment.text))
  }
  return contextEl
}

function scrollContextTarget(contextEl) {
  requestAnimationFrame(() => {
    const targetEl = contextEl?.querySelector('.context-target')
    if (!targetEl || !contextEl.isConnected || contextEl.scrollHeight <= contextEl.clientHeight) return
    const contextRect = contextEl.getBoundingClientRect()
    const targetRect = targetEl.getBoundingClientRect()
    if (targetRect.top >= contextRect.top && targetRect.bottom <= contextRect.bottom) return
    const offset = targetRect.height < contextEl.clientHeight
      ? (contextEl.clientHeight - targetRect.height) / 2 : 0
    contextEl.scrollTop += targetRect.top - contextRect.top - offset
  })
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
    if (text) containerEl.appendChild(createSpeechButton(entry, 'example', text, uiText('读例句', 'Listen to example')))
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
  else buttonEl.title = uiText('这段内容超过 1200 字，暂时无法朗读。', 'Audio is limited to 1,200 characters.')
  updateSpeechButton(buttonEl)
  return buttonEl
}

function createSpeechControls(entry) {
  const controlsEl = createEl('div', 'library-speech-controls')
  const targets = getEntrySpeechTargets(entry)
  const wordLabel = /^\p{L}+(?:['’-]\p{L}+)*$/u.test(String(entry.text || '').trim()) ? uiText('读词', 'Listen to word') : uiText('朗读选区', 'Listen to selection')
  controlsEl.appendChild(createSpeechButton(entry, 'word', targets.word, wordLabel))
  if (targets.context) {
    controlsEl.appendChild(createSpeechButton(entry, 'context', targets.context, targets.contextLabel))
  }
  return controlsEl
}

function updateSpeechButton(buttonEl) {
  const isActive = libraryAudio.getActiveKey() === buttonEl.dataset.speechKey
  buttonEl.textContent = isActive ? uiText('■ 停止', '■ Stop') : buttonEl.dataset.idleLabel
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

function getEditorFocus() {
  const activeEl = document.activeElement
  if (!state.editorEl?.contains(activeEl) || !activeEl.dataset.editField) return null
  return { field: activeEl.dataset.editField, start: activeEl.selectionStart, end: activeEl.selectionEnd }
}

function restoreEditorFocus(focus) {
  if (!focus || !state.editorEl?.isConnected) return
  const fieldEl = state.editorEl.querySelector(`[data-edit-field="${focus.field}"]`)
  if (!fieldEl || fieldEl.disabled) return
  fieldEl.focus({ preventScroll: true })
  if (focus.start !== null) fieldEl.setSelectionRange(focus.start, focus.end)
}

function createEditorField(field) {
  const labelEl = createEl('label', 'editor-field')
  const headingEl = createEl('span', 'editor-field-heading')
  const limitEl = createEl('span', 'editor-limit')
  limitEl.dataset.limitField = field.key
  limitEl.id = `editor-limit-${field.key}`
  headingEl.append(createEl('span', '', `${field.label}${field.isRequired ? ' *' : ''}`), limitEl)
  const inputEl = createEl(field.rows === 1 ? 'input' : 'textarea')
  inputEl.dataset.editField = field.key
  inputEl.name = field.key
  inputEl.maxLength = field.maxLength
  inputEl.required = !!field.isRequired
  inputEl.value = state.draft.values[field.key]
  inputEl.setAttribute('aria-label', field.label)
  inputEl.setAttribute('aria-describedby', limitEl.id)
  if (field.rows > 1) inputEl.rows = field.rows
  inputEl.addEventListener('input', () => {
    state.draft = setVocabularyDraftField(state.draft, field.key, inputEl.value)
    if (!['entry-changed', 'entry-missing'].includes(state.draft.code)) {
      state.draft.code = ''
      state.draft.message = ''
    }
    updateEditorControls()
  })
  labelEl.append(headingEl, inputEl)
  return labelEl
}

function createEntryEditor() {
  const formEl = createEl('form', 'entry-editor')
  formEl.setAttribute('aria-label', uiText('修订学习内容', 'Edit vocabulary entry'))
  formEl.append(createEl('h3', '', uiText('让这份理解更贴近你。', 'Edit entry')),
    createEl('p', 'editor-help', uiText('只修改学习内容，原文、来源和复习进度会保留。', 'Edits keep your source text and review progress.')),
    createEl('p', 'editor-help editor-draft-help', uiText('草稿仅保留在当前页面，刷新或关闭前请保存或复制。', 'Save or copy your draft before refreshing or closing this page.')))
  const advancedEl = createEl('details', 'editor-advanced')
  advancedEl.appendChild(createEl('summary', '', uiText('更多内容：补充解释与音标', 'Explanation and pronunciation')))
  advancedEl.addEventListener('toggle', () => {
    if (state.draft) state.draft.isAdvancedOpen = advancedEl.open
  })
  for (const field of VOCABULARY_EDIT_FIELDS) {
    if (field.isAdvanced) advancedEl.appendChild(createEditorField(field))
    else formEl.appendChild(createEditorField(field))
  }
  formEl.appendChild(advancedEl)
  const messageEl = createEl('p', 'editor-message')
  messageEl.setAttribute('role', 'status')
  messageEl.setAttribute('aria-live', 'polite')
  const reloadEl = createButton(uiText('载入最新内容', 'Load latest version'), reloadDraft, 'secondary editor-reload hidden')
  const actionsEl = createEl('div', 'editor-actions')
  const saveEl = createEl('button', 'editor-save', uiText('保存修订', 'Save changes'))
  saveEl.type = 'submit'
  const cancelEl = createButton(uiText('取消', 'Cancel'), cancelDraft, 'secondary editor-cancel')
  const copyEl = createButton(uiText('复制草稿', 'Copy draft'), () => void copyDraft(), 'text-button editor-copy')
  actionsEl.append(saveEl, cancelEl, copyEl)
  formEl.append(messageEl, reloadEl, actionsEl)
  formEl.addEventListener('submit', (event) => { event.preventDefault(); void saveDraft() })
  return formEl
}

function updateEditorControls() {
  const draft = state.draft
  const formEl = state.editorEl
  if (!draft || !formEl) return
  const update = getVocabularyDraftUpdate(draft)
  const isConflict = draft.code === 'entry-changed'
  const messageEl = formEl.querySelector('.editor-message')
  let message = draft.message
  if (draft.isMissing) message = uiText('这条表达已在其他页面移除。草稿仍保留，可先复制；当前无法保存。', 'This entry was removed elsewhere. You can still copy your draft.')
  else if (isConflict) message = uiText('这条表达的学习内容已在其他页面修改。你的草稿已保留；可先复制，再载入最新内容。', 'This entry changed elsewhere. Copy your draft before loading the latest version.')
  else if (!update.ok) message = update.message
  else if (!message && draft.hasExternalChanges) message = uiText('内容已在其他页面更新。草稿已保留，保存时只提交你改动的字段。', 'This entry was updated elsewhere. Saving will apply only your changes.')
  messageEl.textContent = message
  messageEl.dataset.tone = draft.isMissing || draft.code || !update.ok ? 'error' : 'info'
  for (const field of VOCABULARY_EDIT_FIELDS) {
    const inputEl = formEl.querySelector(`[data-edit-field="${field.key}"]`)
    inputEl.disabled = draft.isSaving
    inputEl.setAttribute('aria-invalid', String(!update.ok && update.field === field.key))
    formEl.querySelector(`[data-limit-field="${field.key}"]`).textContent =
      `${draft.values[field.key].length} / ${field.maxLength}`
  }
  const saveEl = formEl.querySelector('.editor-save')
  saveEl.disabled = draft.isSaving || draft.isMissing || isConflict || !update.ok || !update.hasChanges
  saveEl.textContent = draft.isSaving ? uiText('正在保存…', 'Saving…') : uiText('保存修订', 'Save changes')
  formEl.querySelector('.editor-cancel').disabled = draft.isSaving
  const reloadEl = formEl.querySelector('.editor-reload')
  reloadEl.classList.toggle('hidden', draft.isMissing || (!draft.hasExternalChanges && !isConflict))
  reloadEl.disabled = draft.isSaving
}

function renderDraftNotice() {
  const noticeEl = state.draftNoticeEl
  if (!noticeEl) return
  noticeEl.replaceChildren()
  const draft = state.draft
  const isInline = state.mode === 'all' && listEl.contains(state.editorEl)
  noticeEl.classList.toggle('hidden', !draft || isInline)
  if (!draft || isInline) return
  if (state.mode === 'review') {
    state.editorEl.remove()
    noticeEl.append(createEl('p', '', uiText('有一份未保存的修订，草稿已为你保留。', 'You have unsaved changes.')),
      createButton(uiText('返回继续修订', 'Continue editing'), showDraft, 'secondary'))
    return
  }
  noticeEl.append(createEl('p', 'draft-notice-label', draft.isMissing ? uiText('保留的修订草稿', 'Unsaved draft') : uiText('搜索之外，还有一份修订草稿', 'An entry outside these results has an unsaved draft.')),
    createEl('h2', 'draft-notice-title', draft.text), state.editorEl)
}

function showDraft() {
  if (!state.draft) return
  if (state.mode !== 'all') selectView('all')
  searchEl.value = ''
  const index = state.entries.findIndex((entry) => entry.id === state.draft.id)
  state.visibleCount = Math.max(state.visibleCount, index + 1)
  renderList()
  state.editorEl.scrollIntoView({ block: 'center' })
  state.editorEl.querySelector('[data-edit-field="meaning"]')?.focus({ preventScroll: true })
}

function beginEdit(entry) {
  if (state.draft) {
    if (state.draft.id !== entry.id) setStatus(uiText('请先保存或取消当前修订，再编辑另一条表达。', 'Save or cancel your current edits before editing another entry.'), true)
    showDraft()
    return
  }
  if (libraryAudio.getActiveKey().startsWith(`${entry.id}:`)) void libraryAudio.stop()
  state.draft = createVocabularyDraft(entry)
  state.editorEl = createEntryEditor()
  updateEditorControls()
  setStatus()
  renderList()
  state.editorEl.querySelector('[data-edit-field="meaning"]')?.focus({ preventScroll: true })
}

function cancelDraft() {
  if (state.draft?.isSaving) return
  state.draft = null
  state.editorEl?.remove()
  state.editorEl = null
  setStatus()
  if (state.mode === 'review') renderReview()
  else renderList()
}

function reloadDraft() {
  const latestEntry = state.draft?.latestEntry
  if (!latestEntry || state.draft.isSaving) return
  const isAdvancedOpen = state.draft.isAdvancedOpen
  state.draft = { ...createVocabularyDraft(latestEntry), isAdvancedOpen }
  for (const field of VOCABULARY_EDIT_FIELDS) {
    state.editorEl.querySelector(`[data-edit-field="${field.key}"]`).value = state.draft.values[field.key]
  }
  state.editorEl.querySelector('.editor-copy-text')?.remove()
  updateEditorControls()
  state.editorEl.querySelector('[data-edit-field="meaning"]')?.focus({ preventScroll: true })
}

async function copyDraft() {
  if (!state.draft) return
  const text = serializeVocabularyDraft(state.draft)
  try {
    await navigator.clipboard.writeText(text)
    setStatus(uiText('已复制修订草稿。', 'Draft copied.'))
  } catch {
    let copyEl = state.editorEl.querySelector('.editor-copy-text')
    if (!copyEl) {
      copyEl = createEl('textarea', 'editor-copy-text')
      copyEl.readOnly = true
      copyEl.rows = 6
      copyEl.setAttribute('aria-label', uiText('选中并复制修订草稿', 'Select and copy draft'))
      state.editorEl.appendChild(copyEl)
    }
    copyEl.value = text
    copyEl.focus()
    copyEl.select()
    setStatus(uiText('草稿已选中，可以复制后妥善保留。', 'Draft selected. Copy it to keep your changes.'))
  }
}

async function saveDraft() {
  const draft = state.draft
  if (!draft || draft.isSaving || draft.isMissing || draft.code === 'entry-changed') return
  const update = getVocabularyDraftUpdate(draft)
  if (!update.ok || !update.hasChanges) { updateEditorControls(); return }
  state.draft = { ...draft, isSaving: true, message: '', code: '' }
  updateEditorControls()
  try {
    const response = await send('VOCABULARY_UPDATE', update.payload)
    if (!response.ok) {
      state.draft = { ...state.draft, isSaving: false, code: response.code || 'save-failed',
        message: response.message || uiText('保存修订失败，草稿已保留，请重试。', 'Could not save your edits. Your draft is still here. Try again.') }
      if (response.entry) {
        state.draft = syncVocabularyDraft(state.draft, response.entry)
        state.entries = state.entries.map((entry) => entry.id === draft.id ? response.entry : entry)
      } else if (response.code === 'entry-missing') {
        state.draft = syncVocabularyDraft(state.draft, null)
        state.entries = state.entries.filter((entry) => entry.id !== draft.id)
      }
      return
    }
    state.entries = state.entries.map((entry) => entry.id === draft.id ? response.entry : entry)
    state.draft = null
    state.editorEl.remove()
    state.editorEl = null
    updateCounts()
    setStatus(uiText('已保存修订，原有复习进度已保留。', 'Changes saved. Review progress is preserved.'))
  } catch {
    if (state.draft) state.draft = { ...state.draft, isSaving: false,
      message: uiText('保存修订失败，草稿已保留，请重试。', 'Could not save your edits. Your draft is still here. Try again.') }
  } finally {
    updateEditorControls()
    if (state.mode === 'review') renderReview()
    else renderList()
  }
}

function createEntryCard(entry) {
  const cardEl = createEl('details', 'entry-card')
  cardEl.dataset.entryId = entry.id
  cardEl.addEventListener('toggle', (event) => {
    if (event.target !== cardEl) return
    if (cardEl.open) scrollContextTarget(cardEl.querySelector('.context-block > .entry-context'))
    if (!cardEl.open && libraryAudio.getActiveKey().startsWith(`${entry.id}:`)) void libraryAudio.stop()
  })
  const summaryEl = createEl('summary')
  summaryEl.append(createEl('span', 'entry-title', entry.text),
    createEl('span', 'entry-meta', new Date(entry.createdAt).toLocaleDateString(isDesktopUI() ? 'en' : undefined)))
  const bodyEl = createEl('div', 'entry-body')
  if (entry.phonetic) bodyEl.appendChild(createEl('p', 'entry-phonetic', entry.phonetic))
  bodyEl.appendChild(createSpeechControls(entry))
  bodyEl.append(createEl('span', 'context-label', 'WHERE YOU MET IT'), createContext(entry))
  const isEditing = state.draft?.id === entry.id
  if (isEditing) bodyEl.appendChild(state.editorEl)
  else appendAnswer(bodyEl, entry)
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
  const removeEl = createButton(uiText('移除', 'Remove'), () => void removeEntry(entry.id, removeEl), 'secondary')
  removeEl.setAttribute('aria-label', uiText(`移除 ${entry.text}`, `Remove ${entry.text}`))
  removeEl.disabled = isEditing
  if (isEditing) removeEl.title = uiText('请先保存或取消这条表达的修订。', 'Save or cancel your edits first.')
  const buttonsEl = createEl('div', 'entry-action-buttons')
  if (!isEditing) buttonsEl.appendChild(createButton(uiText('修订内容', 'Edit entry'), () => beginEdit(entry), 'secondary'))
  buttonsEl.appendChild(removeEl)
  actionsEl.append(sourceEl, buttonsEl)
  bodyEl.appendChild(actionsEl)
  cardEl.append(summaryEl, bodyEl)
  return cardEl
}

async function removeEntry(id, buttonEl) {
  if (state.draft?.id === id) {
    setStatus(uiText('请先保存或取消这条表达的修订，再移除它。', 'Save or cancel your edits before removing the entry.'), true)
    return
  }
  const originalEntry = state.entries.find((entry) => entry.id === id)
  if (libraryAudio.getActiveKey().startsWith(`${id}:`)) void libraryAudio.stop()
  buttonEl.disabled = true
  try {
    const response = await send('VOCABULARY_REMOVE', { id })
    if (!response.ok) { setStatus(response.message || uiText('移除失败，请重试。', 'Could not remove the entry. Try again.'), true); return }
    state.lastRemovedEntry = response.entry || originalEntry || null
    renderUndoNotice()
    state.entries = state.entries.filter((entry) => entry.id !== id)
    updateCounts()
    renderList()
    setStatus()
  } catch {
    setStatus(uiText('移除失败，请重试。', 'Could not remove the entry. Try again.'), true)
  } finally {
    buttonEl.disabled = false
  }
}

function renderUndoNotice() {
  const entry = state.lastRemovedEntry
  undoNoticeEl.classList.toggle('hidden', !entry)
  undoMessageEl.textContent = entry ? uiText(`已移除“${entry.text}”。`, `Removed “${entry.text}”.`) : ''
  undoEl.disabled = state.isUndoBusy
  undoEl.textContent = state.isUndoBusy ? uiText('正在恢复…', 'Restoring…') : uiText('撤销', 'Undo')
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
    if (!response.ok) { setStatus(response.message || uiText('恢复失败，请再次点击撤销。', 'Could not restore the entry. Try Undo again.'), true); return }
    if (state.lastRemovedEntry === entry) state.lastRemovedEntry = null
    await refresh()
    setStatus(uiText('已恢复表达和原有复习进度。', 'Entry and review progress restored.'))
  } catch {
    setStatus(uiText('恢复失败，请再次点击撤销。', 'Could not restore the entry. Try Undo again.'), true)
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
  renderDraftNotice()
  const entry = getCurrentReviewEntry()
  const isNewEntry = state.reviewEntryId !== (entry?.id || '')
  const previousContextEl = isNewEntry ? null : reviewCardEl.querySelector('.context-block')
  const previousState = previousContextEl ? {
    scrollTop: previousContextEl.querySelector(':scope > .entry-context')?.scrollTop || 0,
    isFullOpen: Boolean(previousContextEl.querySelector('.context-full')?.open),
    fullScrollTop: previousContextEl.querySelector('.context-full > .entry-context')?.scrollTop || 0,
  } : null
  if (state.reviewEntryId !== (entry?.id || '')) void libraryAudio.stop()
  state.reviewEntryId = entry?.id || ''
  reviewCardEl.replaceChildren()
  if (!entry) {
    const hasReviewed = state.reviewQueue.length > 0
    const emptyEl = createEmptyState(hasReviewed ? uiText('今天的这一小步，完成了。', 'Review complete') : uiText('现在没有到期的表达。', 'Nothing due for review'),
      hasReviewed ? uiText('还不熟的表达会稍后再出现，记住的会隔几天再与你见面。', 'Come back when more vocabulary is due.')
        : uiText('新收藏的词与表达从明天开始复习。现在继续读点喜欢的内容吧。', 'New vocabulary is ready to review the day after you save it.'), '✓')
    if (getDueEntries(state.entries, Date.now()).length) {
      emptyEl.appendChild(createButton(uiText('开始下一轮', 'Start next round'), startReviewSession, 'review-reveal'))
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
  cardEl.append(createEl('span', 'context-label', 'REMEMBER THE MOMENT'), createContext(entry, previousState))
  if (!state.isRevealed) {
    cardEl.appendChild(createButton(uiText('想到了，揭晓释义', 'Reveal meaning'), revealReviewAnswer, 'review-reveal'))
  } else {
    const answerEl = createEl('section', 'review-answer')
    answerEl.tabIndex = -1
    answerEl.setAttribute('aria-label', uiText('表达释义', 'Meaning'))
    appendAnswer(answerEl, entry)
    const ratingEl = createEl('div', 'review-rating')
    const goodDays = scheduleReview(entry, 'good', Date.now()).intervalDays
    for (const [rating, label, interval] of [['again', uiText('还不熟', 'Still learning'), uiText('10 分钟后再看', 'Review in 10 minutes')], ['good', uiText('记住了', 'Got it'), uiText(`${goodDays} 天后再看`, `Review in ${goodDays} ${goodDays === 1 ? "day" : "days"}`)]]) {
      const buttonEl = createButton('', () => void rateEntry(entry.id, rating), rating === 'again' ? 'secondary' : '')
      buttonEl.append(createEl('span', '', label), createEl('small', '', interval))
      buttonEl.disabled = state.isBusy
      ratingEl.appendChild(buttonEl)
    }
    cardEl.append(answerEl, ratingEl)
  }
  reviewCardEl.appendChild(cardEl)
  const contextEl = cardEl.querySelector('.context-block > .entry-context')
  if (isNewEntry) scrollContextTarget(contextEl)
  else if (contextEl) contextEl.scrollTop = previousState?.scrollTop || 0
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
      setStatus(uiText('该表达已在另一处复习，已同步进度。', 'This entry was reviewed elsewhere. Progress updated.'))
      return
    }
    if (!response.ok) { setStatus(response.message || uiText('保存复习进度失败，请重试。', 'Could not save review progress. Try again.'), true); return }
    state.entries = state.entries.map((entry) => entry.id === id ? response.entry : entry)
    state.reviewIndex++
    state.isRevealed = false
    setStatus()
    updateCounts()
  } catch {
    setStatus(uiText('保存复习进度失败，请重试。', 'Could not save review progress. Try again.'), true)
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
    if (!response.ok) { setStatus(response.message || uiText('导出失败，请重试。', 'Could not export vocabulary. Try again.'), true); return }
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
    setStatus(uiText('已导出词汇与学习进度，不包含模型配置或密钥。', 'Vocabulary and review progress exported. Model settings and API keys are excluded.'))
  } catch {
    setStatus(uiText('导出失败，请重试。', 'Could not export vocabulary. Try again.'), true)
  } finally {
    exportEl.disabled = state.entries.length === 0
  }
}

async function downloadAnki() {
  exportAnkiEl.disabled = true
  try {
    const response = await send('VOCABULARY_EXPORT')
    if (!response.ok) { setStatus(response.message || uiText('导出失败，请重试。', 'Could not export vocabulary. Try again.'), true); return }
    const tsv = buildAnkiTsv(response.data?.entries)
    const count = countAnkiRows(tsv)
    if (!count) { setStatus(uiText('表达本还没有可导出的内容。', 'No vocabulary to export.'), true); return }
    const url = URL.createObjectURL(new Blob([tsv], { type: 'text/plain;charset=utf-8' }))
    const linkEl = createEl('a')
    linkEl.href = url
    const date = new Date()
    const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')].join('-')
    linkEl.download = `selected-anki-${stamp}.txt`
    document.body.appendChild(linkEl)
    linkEl.click()
    linkEl.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus(uiText(`已导出 ${count} 条到 Anki（Front=原文, Back=释义与语境）。`, `Exported ${count} ${count === 1 ? "Anki card" : "Anki cards"}. Front: source text. Back: meaning and context.`))
  } catch {
    setStatus(uiText('导出 Anki 失败，请重试。', 'Could not export Anki cards. Try again.'), true)
  } finally {
    exportAnkiEl.disabled = state.entries.length === 0
  }
}

async function restoreBackup() {
  const file = importFileEl.files?.[0]
  if (!file || importEl.disabled) return
  importEl.disabled = true
  try {
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setStatus(uiText('请选择不超过 5 MB 的表达本 JSON 备份。', 'Choose a vocabulary JSON backup of 5 MB or less.'), true)
      return
    }
    let data
    try {
      data = JSON.parse(await file.text())
    } catch {
      setStatus(uiText('这份文件不是有效的 JSON 备份，原有收藏未改变。', 'This file is not a valid vocabulary JSON backup.'), true)
      return
    }
    const response = await send('VOCABULARY_IMPORT', { data })
    if (!response.ok) { setStatus(response.message || uiText('导入失败，原有收藏未改变。', 'Could not import the backup.'), true); return }
    await refresh()
    setStatus(uiText(`已导入 ${response.added} 条，跳过 ${response.skipped} 条已有表达。原有复习进度已保留。`, `Imported ${response.added} · Skipped ${response.skipped} duplicates. Review progress is preserved.`))
  } catch {
    setStatus(uiText('无法读取备份，请重试。', 'Could not read the backup. Try again.'), true)
  } finally {
    importEl.disabled = false
    importFileEl.value = ''
  }
}
