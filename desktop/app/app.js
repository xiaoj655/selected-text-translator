import { localizeErrorMessage } from './messages.js'
import { resultText, resultPlainText } from './result-text.js'
import { ACTION_LABELS, showCopyDone } from './ui-text.js'
import { createTutorWorkspace } from './tutor.js'
import { bindUpdateMenu } from './update-menu.js'
import { buildReviewReminder, formatStudyProgress, getDayKey, getStudyProgress, shouldShowReviewReminder } from '../vendor/src/vocabulary-progress.js'
import { makeMemoryKey, readMemoryEntry, writeMemoryEntry } from '../vendor/src/translation-memory.js'
import { detectSourceLanguage, planLanguageSwap, sourceLanguageLabel } from '../vendor/src/source-language.js'
import { sanitizeGlossary } from '../vendor/src/glossary.js'
import {
  buildLearningArchive,
  parseLearningArchive,
  planArchiveImport,
  serializeLearningArchive,
} from '../vendor/src/learning-archive.js'

const $ = (id) => document.getElementById(id)

const ACCENTS = ['indigo', 'ocean', 'emerald', 'rose', 'amber']
const SPEECH_PREVIEW_ID = 'speech-preview'
const SPEECH_PREVIEW_TEXT = 'Could you record the meeting? I need a record of what we decided.'

const state = {
  mode: 'translate',
  workspace: 'translate',
  targetLanguage: 'auto',
  sourceLanguage: 'auto',
  liveTranslate: false,
  liveTimer: 0,
  liveText: '',
  isComposing: false,
  model: '',
  glossary: [],
  translationMemory: {},
  entries: [],
  activeEntryId: null,
  counter: 0,
  configured: false,
  speechId: null,
  speechEntryId: null,
  lastLookup: null,
  lastSubmittedText: '',
  draft: null,
  draftTimer: 0,
  snackbarTimer: null,
  announceTimer: 0,
  lastElapsed: 0,
  prefs: { pasteAutoSubmit: true, enterToSend: false, theme: 'system', font: 'normal', accent: 'indigo', reducedMotion: false },
  collapsed: new Set(),
  selection: null,
  reviewReminderShown: false,
}

const tutor = createTutorWorkspace({
  rootEl: $('tutor-workspace'),
  api: window.sttDesktop.tutor,
  onOpenSettings: openSettings,
})

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
  renderDiagnostics()
}

function renderGlossaryList() {
  const list = $('glossary-list')
  if (!list) return
  list.replaceChildren()
  if (!state.glossary.length) {
    list.append(el('p', 'glossary-empty', '还没有术语。添加后,翻译会固定使用这里的译法。'))
    return
  }
  state.glossary.forEach((pair, index) => {
    const row = el('div', 'glossary-item')
    row.append(el('span', 'glossary-term', pair.source))
    row.append(el('span', 'glossary-arrow', '→'))
    row.append(el('span', 'glossary-term', pair.target))
    const remove = el('button', 'glossary-remove', '×')
    remove.type = 'button'
    remove.title = '删除术语'
    remove.setAttribute('aria-label', `删除术语 ${pair.source}`)
    remove.dataset.index = String(index)
    remove.addEventListener('click', () => {
      state.glossary.splice(index, 1)
      persistGlossary()
      renderGlossaryList()
      setStatus('已删除术语')
    })
    row.append(remove)
    list.append(row)
  })
}

function persistGlossary() {
  state.glossary = sanitizeGlossary(state.glossary)
  const status = $('glossary-status')
  if (status) status.textContent = `已保存 ${state.glossary.length} 条术语`
  try {
    void chrome.storage.sync.set({ desktop_glossary: state.glossary })
  } catch { }
}

function announceResult(text) {
  const value = String(text || '').trim()
  if (!value) return
  clearTimeout(state.announceTimer)
  state.announceTimer = setTimeout(() => {
    const node = $('result-announcer')
    if (node) node.textContent = value
  }, 250)
}

function setTargetLanguage(value, retranslate) {
  state.targetLanguage = value
  void chrome.storage.sync.set({ desktop_target_language: value })
  for (const id of ['lang-target', 'opt-target-language']) {
    const select = $(id)
    if (select) select.value = value
  }
  const label = value === 'auto' ? '自动(按原文语言判断)' : value
  if (retranslate) retranslateCurrent(`目标语言已设为 ${label} · 已重新翻译`)
  else setStatus(`目标语言已设为 ${label}`)
}

function retranslateCurrent(message) {
  const text = $('input').value.trim()
  if (state.workspace === 'translate' && state.configured && text
    && (state.liveTranslate || state.lastSubmittedText === text)) {
    const lookup = state.lastSubmittedText === text ? state.lastLookup : undefined
    submit({ keepInput: true, lookup })
    setStatus(message)
    return
  }
  setStatus(message.replace(' · 已重新翻译', ''))
}

function setSourceLanguage(value, retranslate) {
  state.sourceLanguage = value
  void chrome.storage.sync.set({ desktop_source_language: value })
  $('lang-source').value = value
  const label = value === 'auto' ? '自动检测原文' : value
  if (retranslate) retranslateCurrent(`原文语言已设为 ${label} · 已重新翻译`)
  else setStatus(`原文语言已设为 ${label}`)
}

function swapLanguages() {
  const detected = detectSourceLanguage($('input').value)
  const plan = planLanguageSwap({ source: state.sourceLanguage, target: state.targetLanguage, detected })
  if (!plan) {
    setStatus('请先输入内容并设置原文或译文语言,再互换方向')
    return
  }
  state.sourceLanguage = plan.source
  state.targetLanguage = plan.target
  void chrome.storage.sync.set({ desktop_source_language: plan.source, desktop_target_language: plan.target })
  $('lang-source').value = plan.source
  for (const id of ['lang-target', 'opt-target-language']) {
    const select = $(id)
    if (select) select.value = plan.target
  }
  updateComposer()
  retranslateCurrent(`已互换语言方向 · 已重新翻译`)
}

function renderDiagnostics() {
  const lines = [
    `配置:${state.configured ? '已连接' : '未连接'}`,
    `模式:${state.mode === 'guide' ? '引导理解' : '翻译'}`,
  ]
  if (state.lastElapsed) lines.push(`上次耗时:${state.lastElapsed} ms`)
  const node = $('diagnostics')
  if (node) node.textContent = lines.join(' · ')
  $('statusbar').title = lines.join('\n')
}

function updateComposer() {
  const input = $('input')
  input.style.height = 'auto'
  input.style.height = `${Math.min(160, Math.max(38, input.scrollHeight))}px`
  const count = input.value.trim().length
  const countEl = $('char-count')
  countEl.textContent = `${count} 字`
  countEl.classList.toggle('is-warn', count > 6000)
  countEl.title = count > 6000 ? '内容较长,可能造成响应变慢或超出模型上下文' : ''
  const detected = sourceLanguageLabel(detectSourceLanguage(input.value))
  const sourceSelect = $('lang-source')
  const autoOption = sourceSelect?.querySelector('option[value="auto"]')
  if (autoOption) autoOption.textContent = detected ? `自动检测 · 检测为${detected}` : '自动检测原文'
  $('composer-hint').textContent = state.prefs.pasteAutoSubmit ? '粘贴即翻译' : '粘贴后点击翻译'
}

function isTyping(node) {
  if (!node) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

function showHelp() {
  closeTransientPanels()
  $('help-overlay').hidden = false
  $('btn-close-help').focus()
}

function hideHelp() {
  const wasOpen = !$('help-overlay').hidden
  $('help-overlay').hidden = true
  if (wasOpen) $('btn-more').focus()
}

function toggleHelp() {
  if ($('help-overlay').hidden) showHelp()
  else hideHelp()
}

function focusables(container) {
  const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  return [...container.querySelectorAll(selector)]
    .filter((node) => !node.hidden && !node.disabled && node.getClientRects().length)
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return
  const items = focusables(container)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault()
      last.focus()
    }
  } else if (active === last || !container.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

function closeTransientPanels() {
  closeActionMenus()
  hideHelp()
  closeExportMenu()
  closeMoreMenu()
  closeSidebar()
  closeSettings()
}

function updateScrollFab() {
  const stream = $('stream')
  const far = stream.scrollHeight - stream.scrollTop - stream.clientHeight > 120
  $('btn-scroll-bottom').hidden = state.workspace !== 'translate' || !far
}

function isNearBottom() {
  const stream = $('stream')
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140
}

function followStreamBottom() {
  if (!isNearBottom()) return
  const stream = $('stream')
  stream.scrollTop = stream.scrollHeight
  updateScrollFab()
}

function isSidebarOpen() {
  return !$('sidebar').hidden
}

function openSidebar() {
  closeTransientPanels()
  $('sidebar').hidden = false
  $('sidebar-backdrop').hidden = false
  $('btn-history').classList.add('is-active')
  renderHistory()
  $('history-search').focus()
}

function closeSidebar() {
  const wasOpen = isSidebarOpen()
  $('sidebar').hidden = true
  $('sidebar-backdrop').hidden = true
  $('btn-history').classList.remove('is-active')
  if (wasOpen) $('btn-history').focus()
}

function toggleSidebar() {
  if (isSidebarOpen()) closeSidebar()
  else openSidebar()
}

function historySnippet(entry) {
  if (entry.status === 'done') return resultText(entry) || (entry.mode === 'guide' ? '引导理解' : '（无结果）')
  if (entry.error) return entry.error
  return '处理中…'
}

function renderHistory() {
  const sidebar = $('sidebar')
  if (!sidebar || sidebar.hidden) return
  const query = $('history-search').value.trim().toLowerCase()
  const list = $('history-list')
  list.replaceChildren()
  const items = [...state.entries].reverse()
  const matched = items.filter((entry) => {
    if (!query) return true
    const haystack = `${entry.text} ${historySnippet(entry)} ${entry.mode === 'guide' ? '引导理解' : '翻译'}`.toLowerCase()
    return haystack.includes(query)
  })
  $('history-count').textContent = query
    ? `共 ${items.length} 条 · 匹配 ${matched.length} 条`
    : `共 ${items.length} 条`
  if (!matched.length) {
    const empty = el('div', 'history-empty')
    const icon = el('div')
    icon.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
    empty.append(icon)
    empty.append(el('div', '', query ? '没有匹配的记录' : '还没有翻译记录'))
    empty.append(el('div', '', query ? '换个关键词试试' : '开始翻译后会自动记录在这里'))
    list.append(empty)
    return
  }
  for (const entry of matched) {
    const item = el('button', 'history-item')
    item.type = 'button'
    item.dataset.entryId = entry.id
    item.title = entry.text
    const top = el('div', 'hi-top')
    top.append(el('span', 'hi-tag', entry.mode === 'guide' ? '引导理解' : '翻译'))
    top.append(el('span', 'hi-time', new Date(entry.createdAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })))
    item.append(top)
    item.append(el('div', 'hi-text', entry.text))
    item.append(el('div', 'hi-result', historySnippet(entry)))
    list.append(item)
  }
}

function jumpToEntry(id) {
  const entry = state.entries.find((item) => item.id === id)
  if (!entry) return
  switchWorkspace('translate')
  state.collapsed.delete(id)
  state.activeEntryId = id
  render()
  closeSidebar()
  const node = $('stream').querySelector(`[data-entry-id="${id}"]`)
  if (!node) return
  node.classList.add('is-highlight')
  setTimeout(() => node.classList.remove('is-highlight'), 1600)
}

function formatStamp() {
  return new Date().toISOString().slice(0, 10)
}

function entryHeading(entry, index) {
  const kind = entry.mode === 'guide' ? '引导理解' : '翻译'
  const time = new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })
  return `${index + 1}. ${kind} · ${time}`
}

function entryToMarkdown(entry, index) {
  const lines = []
  lines.push(`## ${entryHeading(entry, index)}`, '')
  lines.push('**原文**', '', `> ${String(entry.text || '').replace(/\n/g, '\n> ')}`, '')
    if (entry.status === 'error') {
      lines.push('**状态**:失败', '', `> ${entry.error || '未知错误'}`, '')
      return
    }
    if (entry.mode === 'guide') {
      const guide = entry.guide
      if (guide?.phonetic) lines.push(`**音标**:${guide.phonetic}`, '')
      if (Array.isArray(guide?.hints) && guide.hints.length) {
        lines.push('**逐步提示**', '')
        guide.hints.forEach((hint, i) => lines.push(`${i + 1}. ${hint}`))
        lines.push('')
      }
      const answer = guide?.answer
      if (answer) {
        lines.push('**揭晓答案**', '')
        if (answer.meaning) lines.push(`- **含义**:${answer.meaning}`)
        if (answer.explanation) lines.push(`- **解释**:${answer.explanation}`)
        if (answer.example) lines.push(`- **例句**:${answer.example}`)
        if (answer.usage) lines.push(`- **用法**:${answer.usage}`)
        lines.push('')
      }
      return
    }
    lines.push('**译文**', '', resultText(entry) || '（无结果）', '')
    const lexical = entry.lexical
    if (lexical) {
      lines.push('**词典解析**', '')
      if (lexical.phonetic) lines.push(`- **音标**:${lexical.phonetic}`)
      if (Array.isArray(lexical.definitions)) {
        lexical.definitions.forEach((item) => {
          const example = item.example?.source
            ? ` → *${item.example.source}${item.example.target ? ' / ' + item.example.target : ''}*`
            : ''
          lines.push(`- **${item.pos || '释义'}**:${item.meaning || ''}${example}`)
        })
      }
      if (lexical.contextual_analysis) lines.push(`- **语境分析**:${lexical.contextual_analysis}`)
      lines.push('')
    }
  return lines.join('\n')
}

function buildMarkdown() {
  const lines = ['# 划词翻译记录', '']
  lines.push(`> 导出时间:${new Date().toLocaleString('zh-CN', { hour12: false })} · 共 ${state.entries.length} 条记录`, '')
  state.entries.forEach((entry, index) => {
    lines.push('---', '', entryToMarkdown(entry, index))
  })
  return lines.join('\n')
}

function buildJson() {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    app: 'Selected Text Translator',
    count: state.entries.length,
    entries: state.entries.map((entry) => ({
      id: entry.id,
      mode: entry.mode,
      status: entry.status,
      text: entry.text,
      translatedText: entry.translatedText || '',
      lexical: entry.lexical || null,
      guide: entry.guide || null,
      error: entry.error || '',
      createdAt: entry.createdAt,
    })),
  }, null, 2)
}

function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

async function updateStudyProgress() {
  const node = $('study-progress-text')
  if (!node) return
  try {
    const saved = await chrome.storage.local.get('vocabulary_entries')
    const progress = getStudyProgress(saved?.vocabulary_entries)
    node.textContent = formatStudyProgress(progress)
    node.parentElement.classList.toggle('has-due', progress.due > 0)
  } catch {
    node.textContent = '学习进度暂不可用'
  }
}

async function maybeShowReviewReminder() {
  if (state.reviewReminderShown) return
  const notice = $('notice')
  if (!notice || !notice.hidden) return
  try {
    const saved = await chrome.storage.local.get(['vocabulary_entries', 'lastReviewReminderDate'])
    const reminder = buildReviewReminder(getStudyProgress(saved?.vocabulary_entries))
    if (!reminder) return
    if (!shouldShowReviewReminder(saved?.lastReviewReminderDate)) return
    state.reviewReminderShown = true
    try {
      await chrome.storage.local.set({ lastReviewReminderDate: getDayKey() })
    } catch { }
    showNotice(reminder.text, 'review', {
      label: '去复习',
      run: () => window.sttDesktop.openLibrary(),
    }, true)
  } catch { }
}

function isExportOpen() {
  return !$('export-menu').hidden
}

function openExportMenu() {
  const menu = $('export-menu')
  const rect = $('btn-export').getBoundingClientRect()
  const appWidth = menu.offsetParent?.clientWidth || window.innerWidth
  menu.style.right = `${Math.max(16, Math.round(appWidth - rect.right))}px`
  menu.hidden = false
  $('btn-export').setAttribute('aria-expanded', 'true')
  $('export-note').textContent = state.entries.length
    ? `共 ${state.entries.length} 条记录 · 将导出全部学习记录`
    : '还没有可导出的记录'
}

function closeExportMenu() {
  $('export-menu').hidden = true
  $('btn-export').setAttribute('aria-expanded', 'false')
}

function toggleExportMenu() {
  if (isExportOpen()) {
    closeExportMenu()
    return
  }
  closeTransientPanels()
  openExportMenu()
}

function closeMoreMenu() {
  const menuEl = $('more-menu')
  const triggerEl = $('btn-more')
  const hasFocus = menuEl.contains(document.activeElement)
  menuEl.hidden = true
  triggerEl.setAttribute('aria-expanded', 'false')
  if (hasFocus) triggerEl.focus()
}

function toggleMoreMenu() {
  const menu = $('more-menu')
  const wasOpen = !menu.hidden
  closeTransientPanels()
  if (wasOpen) return
  menu.hidden = false
  $('btn-more').setAttribute('aria-expanded', 'true')
}

function switchWorkspace(workspace) {
  const isTutor = workspace === 'tutor'
  if (workspace === state.workspace) {
    if (!isTutor && $('settings-panel').hidden) $('input').focus()
    return
  }
  closeTransientPanels()
  hideSelectionToolbar()
  hideNotice()
  clearTimeout(state.liveTimer)
  state.workspace = workspace
  $('btn-translate-workspace').setAttribute('aria-pressed', String(!isTutor))
  $('btn-tutor-workspace').setAttribute('aria-pressed', String(isTutor))
  $('translation-workspace').hidden = isTutor
  $('tutor-workspace').hidden = !isTutor
  document.title = isTutor ? 'AI 老师 · Selected Text Translator' : 'Selected Text Translator'
  updateScrollFab()
  if (isTutor) void tutor.open()
  else {
    updateComposer()
    $('input').focus()
  }
}

function runExport(kind) {
  if (!state.entries.length) {
    setStatus('还没有可导出的记录')
    return
  }
  if (kind === 'md') {
    downloadText(`划词翻译-${formatStamp()}.md`, buildMarkdown(), 'text/markdown')
    setStatus(`已导出 ${state.entries.length} 条记录为 Markdown`)
  } else if (kind === 'json') {
    downloadText(`划词翻译-${formatStamp()}.json`, buildJson(), 'application/json')
    setStatus(`已导出 ${state.entries.length} 条记录为 JSON`)
  } else if (kind === 'anki') {
    const cell = (value) => String(value || '').replace(/\s+/gu, ' ').trim()
    const rows = state.entries
      .filter((entry) => entry.status === 'done' && entry.text && resultPlainText(entry))
      .map((entry) => `${cell(entry.text)}\t${cell(resultPlainText(entry))}`)
    if (!rows.length) {
      setStatus('没有可导入 Anki 的双语记录')
      closeExportMenu()
      return
    }
    downloadText(`划词翻译-Anki-${formatStamp()}.txt`, rows.join('\n'), 'text/plain')
    setStatus(`已导出 ${rows.length} 条记录为 Anki 词卡`)
  } else if (kind === 'copy') {
    window.sttDesktop.copyText(buildMarkdown())
    setStatus('已复制全部记录为 Markdown')
  }
  closeExportMenu()
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
  $('opt-live-translate').checked = state.liveTranslate
  $('opt-theme').value = ['system', 'light', 'dark'].includes(state.prefs.theme) ? state.prefs.theme : 'system'
  $('opt-font').value = ['small', 'normal', 'large'].includes(state.prefs.font) ? state.prefs.font : 'normal'
  $('opt-reduced-motion').checked = state.prefs.reducedMotion === true
  const activeAccent = ACCENTS.includes(state.prefs.accent) ? state.prefs.accent : 'indigo'
  $('opt-accent').querySelectorAll('.accent-swatch').forEach((swatch) => {
    swatch.classList.toggle('is-active', swatch.dataset.accent === activeAccent)
  })
  updateComposer()
  applyAppearance()
}

function applyAppearance() {
  const root = document.documentElement
  root.dataset.theme = state.prefs.theme || 'system'
  root.dataset.font = state.prefs.font || 'normal'
  root.dataset.motion = state.prefs.reducedMotion ? 'reduced' : 'full'
  root.dataset.accent = ACCENTS.includes(state.prefs.accent) ? state.prefs.accent : 'indigo'
  void window.sttDesktop.setTheme(root.dataset.theme)
}

let persistTimer
function persistHistory() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void window.sttDesktop.saveHistory(state.entries)
  }, 300)
}

async function saveBeforeUpdate() {
  clearTimeout(persistTimer)
  clearTimeout(state.draftTimer)
  const [isHistorySaved] = await Promise.all([
    window.sttDesktop.saveHistory(state.entries),
    chrome.storage.local.set({ desktop_input_draft: $('input').value }),
  ])
  if (!isHistorySaved) throw new Error('保存翻译历史失败。')
}

let pendingArchiveImport = null

function archiveStamp() {
  const date = new Date()
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-')
}

async function readArchiveSources() {
  const saved = await chrome.storage.local.get(['vocabulary_entries', 'translation_memory'])
  const history = await window.sttDesktop.loadHistory()
  return {
    vocabularyEntries: Array.isArray(saved?.vocabulary_entries) ? saved.vocabulary_entries : [],
    translationMemory: saved?.translation_memory && typeof saved.translation_memory === 'object'
      ? saved.translation_memory : {},
    history: Array.isArray(history) ? history : [],
  }
}

async function exportLearningArchive() {
  const statusEl = $('archive-status')
  try {
    const sources = await readArchiveSources()
    const archive = buildLearningArchive(sources)
    const text = serializeLearningArchive(archive)
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const linkEl = document.createElement('a')
    linkEl.href = url
    linkEl.download = `selected-learning-archive-${archiveStamp()}.json`
    document.body.appendChild(linkEl)
    linkEl.click()
    linkEl.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    const counts = `收藏 ${sources.vocabularyEntries.length} · 记忆 ${Object.keys(sources.translationMemory).length} · 记录 ${sources.history.length}`
    statusEl.textContent = `已导出完整学习档案(${counts}),不含密钥。`
    setStatus('已导出完整学习档案')
  } catch {
    statusEl.textContent = '导出档案失败,请重试。'
  }
}

function showArchiveConflicts(counts) {
  const box = $('archive-conflict')
  $('archive-conflict-text').textContent = `待导入档案与现有数据有 ${counts.totalConflicts} 处冲突`
    + `(收藏 ${counts.vocabularyConflicts} · 记忆 ${counts.memoryConflicts})。`
    + `将保留现有数据,仅导入 ${counts.vocabularyAdded + counts.memoryAdded} 条新增内容。`
  box.hidden = false
}

async function applyArchiveImport(plan) {
  const statusEl = $('archive-status')
  const memory = plan.translationMemory
  await chrome.storage.local.set({ vocabulary_entries: plan.vocabularyEntries, translation_memory: memory })
  window.sttDesktop.saveHistory(plan.history)
  state.translationMemory = memory
  state.entries = plan.history.map((entry) => ({
    ...entry,
    status: entry.status === 'done' ? 'done' : 'error',
    error: entry.status === 'done' ? '' : (entry.error || '上次未完成,可重新生成'),
  }))
  render()
  void updateStudyProgress()
  const { counts } = plan
  statusEl.textContent = `已导入档案:新增收藏 ${counts.vocabularyAdded} 条,新增记忆 ${counts.memoryAdded} 条,`
    + `记录 ${plan.history.length} 条,保留现有冲突 ${counts.totalConflicts} 处。`
  setStatus('已导入完整学习档案')
  pendingArchiveImport = null
  $('archive-conflict').hidden = true
}

async function importLearningArchive(file) {
  const statusEl = $('archive-status')
  if (!file) return
  try {
    pendingArchiveImport = null
    $('archive-conflict').hidden = true
    const parsed = parseLearningArchive(await file.text())
    const sources = await readArchiveSources()
    const plan = planArchiveImport(sources, parsed)
    if (plan.counts.totalConflicts > 0) {
      pendingArchiveImport = plan
      showArchiveConflicts(plan.counts)
      statusEl.textContent = `检测到 ${plan.counts.totalConflicts} 处冲突,现有数据未被改动,请选择处理方式。`
      return
    }
    await applyArchiveImport(plan)
  } catch (error) {
    statusEl.textContent = `导入失败:${String(error?.message || error)}`
  }
}

function showNotice(text, kind = 'info', action, dismissible = false) {
  const node = $('notice')
  node.replaceChildren(el('span', '', text))
  if (action) {
    const button = el('button', '', action.label)
    button.type = 'button'
    button.addEventListener('click', action.run)
    node.append(button)
  }
  if (dismissible) {
    const close = el('button', 'notice-close', '×')
    close.type = 'button'
    close.title = '关闭提醒'
    close.setAttribute('aria-label', '关闭提醒')
    close.addEventListener('click', hideNotice)
    node.append(close)
  }
  node.dataset.kind = kind
  node.hidden = false
}

function hideNotice() {
  $('notice').hidden = true
}

function hideSelectionToolbar() {
  $('selection-toolbar').hidden = true
  state.selection = null
}

function showSelectionToolbar(entry, text, rect) {
  state.selection = { entryId: entry.id, text }
  const bar = $('selection-toolbar')
  bar.hidden = false
  const width = bar.offsetWidth
  const height = bar.offsetHeight
  let left = rect.left + rect.width / 2 - width / 2
  left = Math.max(8, Math.min(window.innerWidth - width - 8, left))
  const above = rect.top - height - 8
  const maxTop = Math.max(8, window.innerHeight - height - 8)
  const top = Math.max(8, Math.min(maxTop, above >= 8 ? above : rect.bottom + 8))
  bar.style.left = `${Math.round(left)}px`
  bar.style.top = `${Math.round(top)}px`
}

function selectionInResult() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const text = String(selection.toString() || '').trim()
  if (!text) return null
  const node = selection.anchorNode
  const anchorEl = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  const hostEl = anchorEl?.closest?.('.result, .entry-source .bubble')
  if (!hostEl || !$('stream').contains(hostEl)) return null
  const entryId = hostEl.closest('.entry')?.dataset.entryId
  const entry = state.entries.find((item) => item.id === entryId)
  if (!entry) return null
  return { entry, text, rect: selection.getRangeAt(0).getBoundingClientRect() }
}

async function saveSelection(entry, text, button) {
  button.setAttribute('aria-busy', 'true')
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'VOCABULARY_SAVE',
      payload: {
        text,
        meaning: resultText(entry),
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
    const ok = Boolean(response?.ok)
    button.textContent = ok ? '✓ 已收藏' : '收藏失败'
    setStatus(ok ? '已加入表达本' : '收藏失败')
  } catch {
    button.textContent = '收藏失败'
  } finally {
    button.removeAttribute('aria-busy')
  }
}

function showSnackbar(text, actionLabel, onAction) {
  const node = $('snackbar')
  $('snackbar-label').textContent = text
  const action = $('snackbar-action')
  action.textContent = actionLabel
  action.onclick = () => {
    hideSnackbar()
    onAction()
  }
  node.hidden = false
  clearTimeout(state.snackbarTimer)
  state.snackbarTimer = setTimeout(hideSnackbar, 6000)
}

function hideSnackbar() {
  $('snackbar').hidden = true
  clearTimeout(state.snackbarTimer)
  state.snackbarTimer = null
}

function stashDraft(incoming) {
  const current = $('input').value
  if (!current.trim() || current.trim() === incoming || current.trim() === state.lastSubmittedText) return
  state.draft = current
}
function restoreDraft() {
  if (!state.draft) return
  $('input').value = state.draft
  state.draft = null
  updateComposer()
  scheduleDraftSave()
  hideNotice()
  setStatus('已恢复草稿')
  $('input').focus()
}
function showDraftNotice() {
  if (!state.draft) return
  showNotice(`已暂存未发送的内容（${state.draft.length} 字）,可随时恢复。`, 'draft', {
    label: '恢复草稿',
    run: restoreDraft,
  })
}

function scheduleDraftSave() {
  clearTimeout(state.draftTimer)
  state.draftTimer = setTimeout(() => {
    const value = $('input').value
    void chrome.storage.local.set({ desktop_input_draft: value })
  }, 600)
}

function clearSavedDraft() {
  clearTimeout(state.draftTimer)
  state.draftTimer = 0
  void chrome.storage.local.remove('desktop_input_draft')
}

function openSettings() {
  closeTransientPanels()
  $('settings-backdrop').hidden = false
  $('settings-panel').hidden = false
  void loadSettings()
  void loadFlags()
  renderDiagnostics()
  $('cfg-base-url').focus()
}

function closeSettings() {
  const wasOpen = !$('settings-panel').hidden
  if (state.speechEntryId === SPEECH_PREVIEW_ID) {
    setSpeechStatus('已停止朗读。')
    stopActiveSpeech()
    patchSpeechButtons()
  }
  $('settings-backdrop').hidden = true
  $('settings-panel').hidden = true
  if (wasOpen) $('btn-settings').focus()
}

async function loadFlags() {
  try {
    const flags = await window.sttDesktop.getFlags()
    $('opt-always-on-top').checked = Boolean(flags?.alwaysOnTop)
    $('opt-login-item').checked = Boolean(flags?.loginItem)
  } catch {
    // flags are optional
  }
}

async function loadSettings() {
  try {
    const values = await chrome.storage.sync.get([
      'base_url', 'api_key', 'model', 'learning_model', 'speech_rate',
      'desktop_tts_cloud', 'desktop_tts_api_key',
    ])
    const rate = Number(values?.speech_rate)
    const safeRate = Number.isFinite(rate) && rate >= 0.5 && rate <= 1.5 ? rate : 0.9
    $('cfg-speech-rate').value = String(safeRate)
    $('speech-rate-value').textContent = `${safeRate.toFixed(1)}×`
    $('opt-cloud-speech').checked = values?.desktop_tts_cloud === true
    $('cfg-cloud-speech-key').value = String(values?.desktop_tts_api_key || '')
    $('cfg-base-url').value = String(values?.base_url || '')
    $('cfg-api-key').value = String(values?.api_key || '')
    $('cfg-model').value = String(values?.model || '')
    $('cfg-learning').value = String(values?.learning_model || '')
    $('cfg-api-key').type = 'password'
    $('btn-toggle-key').setAttribute('aria-pressed', 'false')
    $('btn-toggle-key').classList.remove('is-on')
    updateSettingsValidity()
  } catch {
    setStatus('读取设置失败')
  }
}

async function saveSpeechSettings(event) {
  event.preventDefault()
  const button = $('btn-save-speech')
  const statusEl = $('speech-settings-status')
  button.disabled = true
  try {
    await chrome.storage.sync.set({
      desktop_tts_cloud: $('opt-cloud-speech').checked,
      desktop_tts_api_key: $('cfg-cloud-speech-key').value.trim(),
    })
    statusEl.textContent = '已保存朗读设置。'
  } catch {
    statusEl.textContent = '保存朗读设置失败，请重试。'
  } finally {
    button.disabled = false
  }
}

function settingsFieldValues() {
  return {
    base_url: $('cfg-base-url').value.trim(),
    api_key: $('cfg-api-key').value.trim(),
    model: $('cfg-model').value.trim(),
  }
}
function isValidBaseUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
function setFieldError(fieldId, message) {
  const input = $(fieldId)
  const error = $(fieldId + '-error')
  const invalid = Boolean(message)
  if (error) {
    error.textContent = message || ''
    error.hidden = !invalid
  }
  input.setAttribute('aria-invalid', invalid ? 'true' : 'false')
}
function updateSettingsValidity() {
  const values = settingsFieldValues()
  const urlMissing = !values.base_url
  const urlBad = Boolean(values.base_url) && !isValidBaseUrl(values.base_url)
  setFieldError('cfg-base-url', urlMissing ? '请填写 API 地址' : urlBad ? '请输入以 http(s):// 开头的有效地址' : '')
  setFieldError('cfg-api-key', values.api_key ? '' : '请填写 API Key')
  setFieldError('cfg-model', values.model ? '' : '请填写翻译模型')
  const canConnect = isValidBaseUrl(values.base_url) && Boolean(values.api_key)
  const canSave = canConnect && Boolean(values.model)
  $('btn-discover').disabled = !canConnect
  $('btn-save-settings').disabled = !canSave
  return canSave
}
function toggleKeyVisibility() {
  const input = $('cfg-api-key')
  const button = $('btn-toggle-key')
  const visible = input.type === 'text'
  input.type = visible ? 'password' : 'text'
  button.setAttribute('aria-pressed', String(!visible))
  const label = visible ? '显示密钥' : '隐藏密钥'
  button.setAttribute('aria-label', label)
  button.title = label
  button.classList.toggle('is-on', !visible)
}

async function saveSettings() {
  if (!updateSettingsValidity()) return
  const button = $('btn-save-settings')
  button.disabled = true
  $('settings-status').dataset.kind = ''
  $('settings-status').textContent = '正在保存…'
  const values = {
    base_url: $('cfg-base-url').value.trim(),
    api_key: $('cfg-api-key').value.trim(),
    model: $('cfg-model').value.trim(),
    learning_model: $('cfg-learning').value.trim(),
  }
  try {
    await chrome.storage.sync.set(values)
    $('settings-status').textContent = '已保存。'
    $('settings-status').dataset.kind = 'success'
    await checkConfig()
    if (state.configured) {
      closeSettings()
      setStatus('模型已连接,可以开始翻译')
    }
  } catch {
    $('settings-status').textContent = '保存失败,请重试。'
    $('settings-status').dataset.kind = 'error'
  }
  updateSettingsValidity()
}

async function discoverModels() {
  const values = settingsFieldValues()
  if (!isValidBaseUrl(values.base_url) || !values.api_key) { updateSettingsValidity(); return }
  const button = $('btn-discover')
  button.disabled = true
  $('settings-status').textContent = '正在连接并读取模型…'
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DISCOVER_PROVIDER_MODELS',
      payload: { baseUrl: $('cfg-base-url').value.trim(), apiKey: $('cfg-api-key').value.trim() },
    })
    if (!response?.ok) {
      $('settings-status').textContent = response?.message || '连接失败,请重试。'
      $('settings-status').dataset.kind = 'error'
      updateSettingsValidity()
      return
    }
    const models = (response.models || []).filter((model) => !/image|audio|realtime|embedding|rerank|\basr\b|\btts\b/iu.test(model))
    const list = $('model-list')
    list.replaceChildren()
    for (const model of models) {
      const option = document.createElement('option')
      option.value = model
      list.append(option)
    }
    $('settings-status').textContent = `连接成功,找到 ${models.length} 个文本模型。`
  } catch {
    $('settings-status').textContent = '连接失败,请检查网络。'
  }
  updateSettingsValidity()
}

async function checkConfig() {
  try {
    const values = await chrome.storage.sync.get(['base_url', 'api_key', 'model', 'learning_model'])
    state.model = String(values?.model || '')
    state.configured = Boolean(values?.base_url && values?.api_key && values?.model)
  } catch {
    state.configured = false
  }
  if (!state.configured) {
    showNotice('还没有连接模型。填写 API 地址、Key 和模型后才能翻译。', 'info', {
      label: '去设置',
      run: openSettings,
    })
  } else if (!['error', 'draft'].includes($('notice').dataset.kind)) {
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
  for (const card of document.querySelectorAll('.empty-mode')) {
    card.classList.toggle('is-active', card.dataset.emptyMode === mode)
  }
  try {
    await chrome.storage.sync.set({ reading_mode: mode })
  } catch {
    // mode still applies for this session
  }
  const label = mode === 'guide' ? '引导理解' : '翻译'
  retranslateCurrent(`已切换到${label} · 已重新翻译`)
  if (state.workspace === 'translate') $('input').focus()
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
        targetLanguage: state.targetLanguage,
        sourceLanguage: state.sourceLanguage,
        glossary: state.glossary,
      },
    }, (response) => {
      if (!response?.accepted) failEntry(entry, '后台没有接受请求,请重试。')
    })
  } catch {
    failEntry(entry, '无法连接后台,请重启应用。')
  }
}

function restoreFailedText(entry) {
  const input = $('input')
  if (!entry?.text || input.value.trim()) return
  input.value = entry.text
  updateComposer()
  input.focus()
}

function failEntry(entry, message) {
  entry.status = 'error'
  entry.error = message
  setStatus(message)
  restoreFailedText(entry)
  renderEntry(entry)
}

async function pasteAndTranslate() {
  try {
    const text = String(await window.sttDesktop.readClipboard() || '').trim()
    if (!text) {
      setStatus('剪贴板里没有文字,请先复制要翻译的内容')
      $('input').focus()
      return
    }
    if (state.workspace === 'translate') translatePastedText(text)
  } catch {
    setStatus('读取剪贴板失败')
  }
}

function translatePastedText(text) {
  stashDraft(text)
  $('input').value = text
  updateComposer()
  scheduleDraftSave()
  submit()
  showDraftNotice()
}

async function recordTutorLookup(entry) {
  if (!entry.lookup || entry.status !== 'done' || (entry.mode === 'guide' && !entry.guide)) return
  try {
    await window.sttDesktop.tutor.recordLookup({
      ...entry.lookup,
      sourceLanguage: entry.sourceLanguage,
      guideType: entry.guide?.guideType,
    })
    if (state.workspace === 'tutor') void tutor.refresh()
  } catch { }
}

function scheduleLiveTranslate() {
  clearTimeout(state.liveTimer)
  if (!state.liveTranslate || state.isComposing) return
  const text = $('input').value.trim()
  if (text.length < 2 || text === state.liveText) return
  state.liveTimer = setTimeout(() => {
    const current = $('input').value.trim()
    if (state.isComposing || !current || current !== text || current === state.liveText) return
    state.liveText = current
    submit({ keepInput: true })
    setStatus('已自动翻译')
  }, 850)
}

function submit(options = {}) {
  if (state.isComposing || state.workspace !== 'translate') return
  clearTimeout(state.liveTimer)
  state.liveTimer = 0
  if (!options.keepInput) state.liveText = ''
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
  const memoryKey = makeMemoryKey({ text, mode: state.mode, targetLanguage: state.targetLanguage,
    sourceLanguage: state.sourceLanguage, model: state.model, glossary: state.glossary })
  const recent = state.entries[state.entries.length - 1]
  if (recent && recent.memoryKey === memoryKey && ['pending', 'loading', 'streaming'].includes(recent.status)
    && Date.now() - recent.createdAt < 2000) {
    setStatus('相同内容正在处理中,请稍候')
    return
  }
  const id = makeId('s')
  const createdAt = Date.now()
  const sourceLanguage = state.sourceLanguage
  const lookup = options.lookup === undefined
    ? { id, text, sourceLanguage, createdAt }
    : options.lookup
  const entry = {
    id,
    requestId: makeId('r'),
    text,
    mode: state.mode,
    status: 'pending',
    translatedText: '',
    lexical: null,
    guide: null,
    error: '',
    createdAt,
    hintCount: 1,
    answerRevealed: false,
    fromMemory: false,
    sourceLanguage,
    lookupExcluded: lookup === null,
    lookup,
    memoryKey,
  }
  state.lastLookup = lookup
  state.lastSubmittedText = text
  const cached = readMemoryEntry(state.translationMemory, memoryKey)
  if (cached) {
    entry.status = 'done'
    entry.translatedText = cached.translatedText || ''
    entry.lexical = cached.lexical || null
    entry.guide = cached.guide || null
    entry.fromMemory = true
    state.lastElapsed = 0
  }
  stopActiveSpeech()
  state.entries.push(entry)
  state.activeEntryId = entry.id
  hideNotice()
  render()
  cancelStaleRequests(entry.id)
  if (cached) {
    setStatus('来自翻译记忆 · 即时')
    announceResult(entry.mode === 'guide'
      ? (entry.guide?.answer?.meaning || entry.guide?.hints?.[0] || '')
      : entry.translatedText)
    persistHistory()
    void recordTutorLookup(entry)
  } else {
    sendRequest(entry)
  }
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
        if (!entry.translatedText) {
          entry.status = 'error'
          entry.error = '模型没有返回译文,请重试或换个模型。'
          setStatus(entry.error)
          restoreFailedText(entry)
          announceResult(entry.error)
          break
        }
      }
      state.lastElapsed = Date.now() - entry.createdAt
      setStatus(`完成 · ${state.lastElapsed} ms`)
      announceResult(entry.mode === 'guide'
        ? (entry.guide?.answer?.meaning || entry.guide?.hints?.[0] || '')
        : entry.translatedText)
      if (entry.memoryKey && (entry.mode === 'guide' ? entry.guide : entry.translatedText)) {
        state.translationMemory = writeMemoryEntry(state.translationMemory, entry.memoryKey, {
          translatedText: entry.translatedText,
          lexical: entry.lexical,
          guide: entry.guide,
        })
        try {
          Promise.resolve(chrome.storage.local.set({ translation_memory: state.translationMemory })).catch(() => {})
        } catch { }
      }
      void recordTutorLookup(entry)
      break
    case 'missing-configuration':
    case 'error':
      entry.status = 'error'
      entry.error = localizeErrorMessage(payload)
      setStatus(entry.error)
      restoreFailedText(entry)
      if (payload.status === 'missing-configuration') void checkConfig()
      break
    default:
      return
  }
  if (['done', 'error'].includes(entry.status)) persistHistory()
  if (payload.status === 'stream') {
    patchStreamResult(entry)
    return
  }
  renderEntry(entry)
}

function setSpeechStatus(message) {
  if (state.speechEntryId === SPEECH_PREVIEW_ID) $('speech-settings-status').textContent = message
  else setStatus(message)
}

function handleSpeechEvent(payload) {
  if (payload.speechId !== state.speechId) return
  if (payload.status === 'fallback') {
    setSpeechStatus(payload.message)
    return
  }
  if (!['end', 'error', 'interrupted', 'cancelled'].includes(payload.status)) return
  if (payload.status === 'error') setSpeechStatus('朗读不可用，请检查朗读设置与系统语音。')
  if (payload.status === 'end') setSpeechStatus('朗读结束。')
  if (payload.status === 'interrupted' || payload.status === 'cancelled') setSpeechStatus('已停止朗读。')
  state.speechId = null
  state.speechEntryId = null
  patchSpeechButtons()
}

function patchSpeechButtons() {
  const stream = $('stream')
  for (const button of stream.querySelectorAll('[data-speech-button]')) {
    const id = button.closest('.entry')?.dataset.entryId
    const speaking = Boolean(state.speechId) && state.speechEntryId === id
    button.textContent = speaking ? ACTION_LABELS.stopSpeak : ACTION_LABELS.speak
    button.setAttribute('aria-pressed', speaking ? 'true' : 'false')
  }
  const previewButton = $('btn-preview-speech')
  const isPreviewPlaying = Boolean(state.speechId) && state.speechEntryId === SPEECH_PREVIEW_ID
  previewButton.textContent = isPreviewPlaying ? '停止试听' : '试听英文'
  previewButton.setAttribute('aria-pressed', String(isPreviewPlaying))
}

function stopActiveSpeech() {
  const speechId = state.speechId
  state.speechId = null
  state.speechEntryId = null
  if (!speechId) return
  try {
    chrome.runtime.sendMessage({ type: 'STOP_SPEECH', payload: { speechId } }, () => {})
  } catch {
    // ignore
  }
}

function renderEmpty() {
  const box = el('div', 'empty')
  const hero = el('div', 'empty-hero')
  hero.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>'
  box.append(hero)
  box.append(el('h2', '', '粘贴一段文字开始'))

  const modes = el('div', 'empty-modes')
  for (const [mode, icon, title, desc] of [
    ['translate', '译', '直接翻译', '立刻得到译文、音标与用法,适合快速读懂一句话。'],
    ['guide', '思', '引导理解', '先给线索、再揭晓答案,把查词变成一次主动思考。'],
  ]) {
    const card = el('button', 'empty-mode')
    card.type = 'button'
    card.dataset.emptyMode = mode
    if (state.mode === mode) card.classList.add('is-active')
    card.append(el('span', 'empty-mode-icon', icon))
    const text = el('span', 'empty-mode-text')
    text.append(el('strong', '', title))
    text.append(el('small', '', desc))
    card.append(text)
    card.addEventListener('click', () => {
      void setMode(mode)
      $('input').focus()
    })
    modes.append(card)
  }
  box.append(modes)

  const examples = el('div', 'empty-examples')
  for (const [label, text] of [
    ['试一个单词', 'record'],
    ['试一个句子', 'The report, which was filed late, still changed the decision.'],
    ['试一段中文', '这份报告虽然提交晚了,但仍然改变了最终决定。'],
  ]) {
    const button = el('button', '', label)
    button.type = 'button'
    button.addEventListener('click', () => {
      $('input').value = text
      updateComposer()
      $('input').focus()
      if (state.configured) submit({ lookup: null })
      else setStatus('已填入示例，配置模型后点「翻译」')
    })
    examples.append(button)
  }
  box.append(examples)
  return box
}

function renderLexical(entry) {
  const lexical = entry.lexical
  if (!lexical) return null
  const box = el('div', 'lexical')
  if (lexical.phonetic) {
    const row = el('div', 'lexical-row')
    row.append(el('span', 'lexical-label', '音标'))
    row.append(el('span', 'phonetic-badge', lexical.phonetic))
    box.append(row)
  }
  if (Array.isArray(lexical.definitions) && lexical.definitions.length) {
    const section = el('div', 'lexical-section')
    section.append(el('div', 'lexical-section-title', '释义'))
    const list = el('ul', 'definitions')
    for (const definition of lexical.definitions) {
      const item = el('li', 'sense')
      if (definition.pos) item.append(el('span', 'pos-chip', definition.pos))
      item.append(el('span', 'sense-meaning', definition.meaning || ''))
      if (definition.example) {
        const example = el('div', 'sense-example')
        example.append(el('span', 'example-source', definition.example.source))
        example.append(el('span', 'example-arrow', '→'))
        example.append(el('span', 'example-target', definition.example.target))
        item.append(example)
      }
      list.append(item)
    }
    section.append(list)
    box.append(section)
  }
  if (lexical.contextual_analysis) {
    const note = el('div', 'lexical-context')
    note.append(el('span', 'lexical-label', '语境'))
    note.append(el('span', '', lexical.contextual_analysis))
    box.append(note)
  }
  return box.childElementCount ? box : null
}

function lexicalRow(label, value) {
  const row = el('div', 'lexical-row')
  row.append(el('span', 'lexical-label', label), el('span', '', value))
  return row
}

function revealedHints(entry, hints) {
  const n = Number(entry.hintCount)
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 1, hints.length))
}

function hintNode(hint, index, isNew) {
  const node = el('div', isNew ? 'hint is-new' : 'hint')
  node.append(el('span', 'hint-step', String(index + 1)))
  node.append(el('span', 'hint-text', hint))
  return node
}

function revealNextHint(entry) {
  const guide = entry.guide
  if (!guide || !Array.isArray(guide.hints)) return
  const count = revealedHints(entry, guide.hints)
  if (count >= guide.hints.length) return
  const node = document.querySelector(`[data-entry-id="${entry.id}"]`)
  const hints = node?.querySelector('[data-hints]')
  const more = node?.querySelector('[data-hint-more]')
  if (!hints || !more) {
    entry.hintCount = count + 1
    renderEntry(entry)
    return
  }
  entry.hintCount = count + 1
  hints.append(hintNode(guide.hints[count], count, true))
  const remaining = guide.hints.length - entry.hintCount
  if (remaining > 0) more.textContent = `再提示一点 · 还有 ${remaining} 条`
  else more.remove()
  persistHistory()
  updateScrollFab()
}

function renderGuide(entry) {
  const guide = entry.guide
  if (!guide) return null
  const box = document.createDocumentFragment()
  const tools = el('div', 'guide-tools')
  if (guide.phonetic) box.append(lexicalRow('音标', guide.phonetic))
  if (Array.isArray(guide.hints) && guide.hints.length) {
    const hints = el('div', 'hints')
    hints.dataset.hints = 'true'
    const revealed = revealedHints(entry, guide.hints)
    guide.hints.slice(0, revealed).forEach((hint, index) => hints.append(hintNode(hint, index)))
    box.append(hints)
    if (revealed < guide.hints.length) {
      const more = el('button', '', `再提示一点 · 还有 ${guide.hints.length - revealed} 条`)
      more.type = 'button'
      more.dataset.hintMore = 'true'
      more.addEventListener('click', () => revealNextHint(entry))
      tools.append(more)
    }
  }
  const answer = guide.answer
  if (answer) {
    const reveal = el('button', '', entry.answerRevealed ? '收起答案' : '揭晓答案')
    reveal.type = 'button'
    reveal.addEventListener('click', () => {
      entry.answerRevealed = !entry.answerRevealed
      persistHistory()
      renderEntry(entry)
    })
    tools.append(reveal)
  }
  if (tools.childElementCount) box.append(tools)
  if (answer && entry.answerRevealed) {
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
  return box
}

function renderResult(entry) {
  const result = el('div', 'result')
  if (entry.status === 'error') {
    result.classList.add('is-error')
    result.setAttribute('role', 'alert')
    const message = el('div', 'error-message')
    message.append(el('strong', 'error-title', '处理失败'), el('span', '', entry.error || '请重试'))
    const tools = el('div', 'error-tools')
    const retry = el('button', '', '重试')
    retry.type = 'button'
    retry.addEventListener('click', () => regenerate(entry))
    const fix = el('button', '', '去设置')
    fix.type = 'button'
    fix.addEventListener('click', openSettings)
    const remove = el('button', 'is-danger', '删除')
    remove.type = 'button'
    remove.addEventListener('click', () => deleteEntry(entry))
    tools.append(retry, fix, remove)
    result.append(message, tools)
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
  const answer = el('div', 'translation-answer')
  answer.append(el('span', 'translation-text', entry.translatedText))
  if (entry.status === 'streaming') answer.append(el('span', 'caret'))
  result.append(answer)
  const lexical = renderLexical(entry)
  if (lexical) {
    const details = el('details', 'lexical-details')
    details.append(el('summary', '', '词典详情 · 音标 / 释义 / 例句 / 语境'), lexical)
    result.append(details)
  }
  return result
}

function startCompanionEntry(entry, mode) {
  if (!entry?.text || !['translate', 'guide'].includes(mode)) return
  const companion = {
    id: makeId('s'),
    requestId: makeId('r'),
    text: entry.text,
    mode,
    status: 'pending',
    translatedText: '',
    lexical: null,
    guide: null,
    error: '',
    createdAt: Date.now(),
    hintCount: 1,
    answerRevealed: false,
    fromMemory: false,
    sourceLanguage: state.sourceLanguage,
    lookupExcluded: entry.lookupExcluded,
    lookup: entry.lookup,
    memoryKey: makeMemoryKey({ text: entry.text, mode, targetLanguage: state.targetLanguage,
      sourceLanguage: state.sourceLanguage, model: state.model, glossary: state.glossary }),
  }
  const cached = readMemoryEntry(state.translationMemory, companion.memoryKey)
  if (cached) {
    companion.status = 'done'
    companion.translatedText = cached.translatedText || ''
    companion.lexical = cached.lexical || null
    companion.guide = cached.guide || null
    companion.fromMemory = true
  }
  stopActiveSpeech()
  cancelStaleRequests(companion.id)
  state.entries.push(companion)
  state.activeEntryId = companion.id
  render()
  if (cached) {
    setStatus('来自翻译记忆 · 即时')
    persistHistory()
    void recordTutorLookup(companion)
  } else {
    sendRequest(companion)
  }
}

function deleteEntry(entry) {
  const index = state.entries.findIndex((item) => item.id === entry.id)
  if (index < 0) return
  const removed = state.entries.splice(index, 1)[0]
  render()
  showSnackbar('已删除 1 条记录', '撤销', () => {
    state.entries.splice(Math.min(index, state.entries.length), 0, removed)
    render()
    setStatus('已撤销删除')
  })
}

function closeActionMenu(menuEl) {
  if (menuEl.matches(':popover-open')) menuEl.hidePopover()
}

function closeActionMenus() {
  document.querySelectorAll('.action-menu:popover-open').forEach(closeActionMenu)
}

function positionActionMenu(menuEl, triggerEl) {
  if (CSS.supports('position-area: block-end span-inline-start')) return
  const trigger = triggerEl.getBoundingClientRect()
  const menu = menuEl.getBoundingClientRect()
  const left = Math.max(8, Math.min(window.innerWidth - menu.width - 8, trigger.right - menu.width))
  const below = trigger.bottom + 4
  const top = below + menu.height <= window.innerHeight - 8 ? below : trigger.top - menu.height - 4
  menuEl.style.left = `${left}px`
  menuEl.style.top = `${Math.max(8, Math.min(window.innerHeight - menu.height - 8, top))}px`
}

function renderActions(entry) {
  const bar = el('div', 'actions')
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', '结果操作')

  const text = resultPlainText(entry)
  if (text && entry.status === 'done') {
    const copy = el('button', 'is-primary', ACTION_LABELS.copyResult)
    copy.type = 'button'
    copy.addEventListener('click', (event) => {
      window.sttDesktop.copyText(text)
      setStatus('结果已复制到剪贴板')
      showCopyDone(event.currentTarget)
    })
    bar.append(copy)
  }

  const speaking = Boolean(state.speechId) && state.speechEntryId === entry.id
  const speechButton = el('button', '', speaking ? ACTION_LABELS.stopSpeak : ACTION_LABELS.speak)
  speechButton.type = 'button'
  speechButton.dataset.speechButton = 'true'
  speechButton.setAttribute('aria-pressed', speaking ? 'true' : 'false')
  speechButton.addEventListener('click', () => toggleSpeech(entry))
  bar.append(speechButton)

  if (['pending', 'loading', 'streaming'].includes(entry.status)) {
    const cancel = el('button', 'is-danger', ACTION_LABELS.cancel)
    cancel.type = 'button'
    cancel.addEventListener('click', () => cancelRequest(entry))
    bar.append(cancel)
  }

  if (entry.status === 'done' && entry.text) {
    const save = el('button', 'action-save', '收藏')
    save.type = 'button'
    save.dataset.saveButton = 'true'
    save.addEventListener('click', (event) => void saveVocabulary(entry, event.currentTarget))
    bar.append(save)
  }

  const more = el('button', 'action-more', '⋯')
  more.type = 'button'
  more.title = '更多操作'
  more.setAttribute('aria-label', '更多操作')
  more.setAttribute('aria-expanded', 'false')
  const menu = el('div', 'action-menu')
  menu.id = makeId('actions')
  menu.setAttribute('popover', 'auto')
  menu.setAttribute('role', 'group')
  menu.setAttribute('aria-label', '结果操作')
  menu.hidden = true
  more.setAttribute('popovertarget', menu.id)
  menu.addEventListener('beforetoggle', (event) => {
    const isOpen = event.newState === 'open'
    menu.hidden = !isOpen
    more.setAttribute('aria-expanded', String(isOpen))
  })
  menu.addEventListener('toggle', (event) => {
    if (event.newState === 'open') positionActionMenu(menu, more)
  })
  const menuAdd = (label, handler, danger = false, className = '') => {
    const button = el('button', [danger ? 'is-danger' : '', className].filter(Boolean).join(' '), label)
    button.type = 'button'
    button.addEventListener('click', (event) => {
      closeActionMenu(menu)
      handler(event)
    })
    menu.append(button)
    return button
  }
  if (!['pending', 'loading', 'streaming'].includes(entry.status)) {
    menuAdd(ACTION_LABELS.regenerate, () => regenerate(entry))
    if (entry.text) {
      const companionMode = entry.mode === 'guide' ? 'translate' : 'guide'
      const companion = menuAdd(companionMode === 'guide' ? '深入引导理解' : '快速翻译',
        () => startCompanionEntry(entry, companionMode), false, 'action-companion')
      companion.dataset.companionMode = companionMode
    }
  }
  menuAdd(ACTION_LABELS.copySource, (event) => {
    window.sttDesktop.copyText(entry.text)
    setStatus('原文已复制到剪贴板')
    showCopyDone(event.currentTarget)
  })
  menuAdd('复制双语对照', (event) => {
    const bilingual = `原文\n${String(entry.text || '').trim()}\n\n译文\n${text || '（无结果）'}`
    window.sttDesktop.copyText(bilingual)
    setStatus('双语对照已复制到剪贴板')
    showCopyDone(event.currentTarget)
  })
  if (entry.status === 'done' && text) {
    menuAdd('朗读译文', () => toggleSpeech(entry, resultPlainText(entry)))
  }
  menuAdd('回填输入框', () => {
    $('input').value = entry.text
    updateComposer()
    $('input').focus()
    setStatus('已回填到输入框')
  })
  menuAdd('导出此条为 Markdown', () => {
    const index = state.entries.indexOf(entry)
    const filename = `译文-${entry.id || index + 1}.md`
    downloadText(filename, entryToMarkdown(entry, index), 'text/markdown')
    setStatus('已导出此条为 Markdown')
  })
  menuAdd('删除', () => deleteEntry(entry), true)
  more.addEventListener('click', (event) => {
    event.stopPropagation()
  })
  bar.append(more, menu)
  return bar
}

function renderEntryEl(entry) {
  const wrapper = el('article', 'entry')
  wrapper.dataset.entryId = entry.id
  const collapsed = state.collapsed.has(entry.id)
  if (collapsed) wrapper.classList.add('is-collapsed')

  const source = el('div', 'entry-source')
  source.append(el('span', 'source-label', '原文'))
  const bubble = el('div', 'bubble', entry.text)
  bubble.title = '点击回填到输入框'
  bubble.addEventListener('click', () => {
    if (String(window.getSelection()?.toString() || '').trim()) return
    $('input').value = entry.text
    updateComposer()
    $('input').focus()
  })
  source.append(bubble)
  wrapper.append(source)

  const card = el('div', 'entry-card')
  if (entry.mode === 'guide') card.classList.add('entry-card--guide')
  const head = el('div', 'entry-head')
  head.title = '点击折叠 / 展开'
  head.append(el('span', 'tag', entry.mode === 'guide' ? '引导理解' : '翻译'))
  if (entry.fromMemory) head.append(el('span', 'memory-tag', '翻译记忆'))
  head.append(el('span', 'meta', new Date(entry.createdAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })))
  head.append(el('span', 'spacer'))
  head.append(el('span', 'meta', `${entry.text.length} 字`))
  const chevron = el('span', 'chevron')
  chevron.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
  head.append(chevron)
  head.addEventListener('click', () => {
    if (state.collapsed.has(entry.id)) state.collapsed.delete(entry.id)
    else state.collapsed.add(entry.id)
    renderEntry(entry)
  })
  card.append(head)

  const body = el('div', 'entry-body')
  const label = entry.status === 'error' ? '出错了'
    : ['pending', 'loading', 'streaming'].includes(entry.status) ? '正在处理'
      : entry.mode === 'guide' ? '引导解析' : '译文'
  body.append(el('div', 'result-label', label))
  body.append(renderResult(entry))
  if (entry.status !== 'error') body.append(renderActions(entry))
  if (collapsed) body.hidden = true
  card.append(body)
  wrapper.append(card)
  return wrapper
}

function render(forceBottom = true) {
  hideSelectionToolbar()
  persistHistory()
  const stream = $('stream')
  const active = state.entries.find((item) => item.id === state.activeEntryId)
    || state.entries[state.entries.length - 1]
  if (active) state.activeEntryId = active.id
  const stick = forceBottom || isNearBottom()
  stream.replaceChildren()
  if (!active) stream.append(renderEmpty())
  else stream.append(renderEntryEl(active))
  if (stick) stream.scrollTop = stream.scrollHeight
  updateScrollFab()
  renderHistory()
}

function patchStreamResult(entry) {
  const stream = $('stream')
  const node = stream.querySelector(`[data-entry-id="${entry.id}"]`)
  const result = node?.querySelector('.entry-body > .result')
  if (!result) {
    renderEntry(entry)
    return
  }
  const label = node.querySelector('.entry-body > .result-label')
  if (label) label.textContent = '正在处理'
  result.classList.remove('is-error', 'is-loading')
  const answer = el('div', 'translation-answer')
  const text = el('span', 'translation-text')
  text.append(document.createTextNode(entry.translatedText || ''))
  answer.append(text, el('span', 'caret'))
  result.replaceChildren(answer)
  const lexical = renderLexical(entry)
  if (lexical) result.append(lexical)
  followStreamBottom()
}

function renderEntry(entry) {
  const stream = $('stream')
  const node = stream.querySelector(`[data-entry-id="${entry.id}"]`)
  if (!node) {
    render()
    return
  }
  node.replaceWith(renderEntryEl(entry))
  if (['pending', 'loading', 'streaming'].includes(entry.status)) followStreamBottom()
  updateScrollFab()
  renderHistory()
}

function cancelStaleRequests(exceptId) {
  for (const stale of state.entries) {
    if (stale.id === exceptId) continue
    if (!['pending', 'loading', 'streaming'].includes(stale.status)) continue
    try {
      chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', payload: { requestId: stale.requestId } }, () => {})
    } catch { }
    stale.requestId = makeId('r')
    stale.status = 'error'
    stale.error = '已被新的翻译取代。'
  }
}

function cancelRequest(entry) {
  try {
    chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', payload: { requestId: entry.requestId } }, () => {})
  } catch {
    // the request may already have finished
  }
  entry.requestId = makeId('r')
  entry.status = 'error'
  entry.error = '已取消请求,可以重新生成。'
  restoreFailedText(entry)
  renderEntry(entry)
  setStatus('已取消请求')
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
  cancelStaleRequests(entry.id)
  renderEntry(entry)
  sendRequest(entry, true)
}

function toggleSpeech(entry, text = entry.text) {
  if (state.speechId) {
    const isSameEntry = state.speechEntryId === entry.id
    setSpeechStatus('已停止朗读。')
    stopActiveSpeech()
    patchSpeechButtons()
    if (isSameEntry) return
  }
  const speechId = makeId('speech')
  state.speechId = speechId
  state.speechEntryId = entry.id
  setSpeechStatus('正在朗读…')
  patchSpeechButtons()
  try {
    chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId, text } }, (response) => {
      if (!response?.ok && state.speechId === speechId) {
        setSpeechStatus(response?.message || '朗读不可用')
        state.speechId = null
        state.speechEntryId = null
        patchSpeechButtons()
      }
    })
  } catch {
    setSpeechStatus('朗读不可用')
    state.speechId = null
    state.speechEntryId = null
    patchSpeechButtons()
  }
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
    if (response?.ok) void updateStudyProgress()
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
  const form = $('translation-form')
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })
  $('btn-translate-workspace').addEventListener('click', () => switchWorkspace('translate'))
  $('btn-tutor-workspace').addEventListener('click', () => switchWorkspace('tutor'))
  $('btn-releases').addEventListener('click', async () => {
    try {
      await window.sttDesktop.openReleases()
    } catch {
      showNotice('无法打开发布页面', 'error', null, true)
    }
  })
  $('btn-settings').addEventListener('click', openSettings)
  $('btn-close-settings').addEventListener('click', closeSettings)
  $('btn-save-settings').addEventListener('click', () => void saveSettings())
  $('btn-discover').addEventListener('click', () => void discoverModels())
  for (const id of ['cfg-base-url', 'cfg-api-key', 'cfg-model', 'cfg-learning']) {
    $(id).addEventListener('input', updateSettingsValidity)
  }
  $('btn-toggle-key').addEventListener('click', (event) => { event.preventDefault(); toggleKeyVisibility() })
  $('settings-panel').addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeSettings()
      return
    }
    trapFocus(event, $('settings-panel'))
  })
  $('settings-backdrop').addEventListener('click', closeSettings)
  $('btn-archive-export').addEventListener('click', () => void exportLearningArchive())
  $('btn-archive-import').addEventListener('click', () => $('archive-file').click())
  $('archive-file').addEventListener('change', (event) => {
    const file = event.target.files?.[0]
    if (file) void importLearningArchive(file)
    event.target.value = ''
  })
  $('archive-conflict-keep').addEventListener('click', () => {
    if (pendingArchiveImport) void applyArchiveImport(pendingArchiveImport)
  })
  $('archive-conflict-cancel').addEventListener('click', () => {
    pendingArchiveImport = null
    $('archive-conflict').hidden = true
    $('archive-status').textContent = '已取消导入,现有数据未改动。'
  })
  $('btn-library').addEventListener('click', () => window.sttDesktop.openLibrary())
  $('btn-study-progress').addEventListener('click', () => window.sttDesktop.openLibrary())
  $('btn-log').addEventListener('click', () => window.sttDesktop.openLog())
  $('opt-always-on-top').addEventListener('change', (event) => {
    void window.sttDesktop.setAlwaysOnTop(event.target.checked)
    setStatus(event.target.checked ? '窗口已置顶' : '已取消置顶')
  })
  $('opt-login-item').addEventListener('change', (event) => {
    void window.sttDesktop.setLoginItem(event.target.checked)
    setStatus(event.target.checked ? '已开启开机自启' : '已关闭开机自启')
  })
  $('opt-live-translate').addEventListener('change', (event) => {
    state.liveTranslate = event.target.checked
    clearTimeout(state.liveTimer)
    state.liveTimer = 0
    void chrome.storage.sync.set({ desktop_live_translate: state.liveTranslate })
    setStatus(state.liveTranslate ? '已开启输入后自动翻译' : '已关闭输入后自动翻译')
  })
  $('opt-target-language').addEventListener('change', (event) => setTargetLanguage(event.target.value, false))
  $('glossary-add').addEventListener('click', () => {
    const source = $('glossary-source').value.trim()
    const target = $('glossary-target').value.trim()
    if (!source || !target) {
      setStatus('请填写术语原文和固定译法')
      return
    }
    state.glossary = sanitizeGlossary([...state.glossary, { source, target }])
    $('glossary-source').value = ''
    $('glossary-target').value = ''
    persistGlossary()
    renderGlossaryList()
    setStatus('已添加术语')
  })
  $('lang-target').addEventListener('change', (event) => setTargetLanguage(event.target.value, true))
  $('lang-source').addEventListener('change', (event) => setSourceLanguage(event.target.value, true))
  $('btn-swap-lang').addEventListener('click', swapLanguages)
  $('btn-clear').addEventListener('click', () => {
    if (!state.entries.length) {
      setStatus('没有可清空的翻译历史')
      return
    }
    const count = state.entries.length
    showSnackbar('确定清空全部 ' + count + ' 条翻译历史？', '清空', () => {
      const removed = state.entries.slice()
      state.entries = []
      void window.sttDesktop.clearHistory()
      render()
      showSnackbar('已清空 ' + count + ' 条翻译历史', '撤销', () => {
        state.entries = removed
        render()
        setStatus('已撤销清空')
      })
    })
  })
  $('snackbar-close').addEventListener('click', hideSnackbar)
  const input = $('input')
  input.addEventListener('compositionstart', () => {
    state.isComposing = true
    clearTimeout(state.liveTimer)
  })
  input.addEventListener('compositionend', () => {
    state.isComposing = false
    updateComposer()
    scheduleLiveTranslate()
    scheduleDraftSave()
  })
  input.addEventListener('input', (event) => {
    updateComposer()
    if (event.isComposing) clearTimeout(state.liveTimer)
    else scheduleLiveTranslate()
    scheduleDraftSave()
  })
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || state.isComposing) return
    if (event.key !== 'Enter') return
    const modifier = event.ctrlKey || event.metaKey
    const shouldSubmit = state.prefs.enterToSend
      ? (!modifier && !event.shiftKey)
      : modifier
    if (!shouldSubmit) return
    event.preventDefault()
    form.requestSubmit()
  })
  input.addEventListener('paste', (event) => {
    if (state.prefs.pasteAutoSubmit === false || state.isComposing) return
    const text = event.clipboardData?.getData('text/plain').trim()
    if (!text) return
    event.preventDefault()
    translatePastedText(text)
  })
  $('btn-clear-input').addEventListener('click', () => {
    input.value = ''
    updateComposer()
    clearSavedDraft()
    input.focus()
  })
  $('btn-paste-translate').addEventListener('click', () => void pasteAndTranslate())
  $('opt-paste').addEventListener('change', (event) => {
    state.prefs.pasteAutoSubmit = event.target.checked
    updateComposer()
    void savePrefs()
    setStatus(event.target.checked ? '粘贴后会自动翻译' : '粘贴后需手动点翻译')
  })
  $('opt-enter').addEventListener('change', (event) => {
    state.prefs.enterToSend = event.target.checked
    void savePrefs()
    updateComposer()
  })
  $('cfg-speech-rate').addEventListener('input', (event) => {
    const rate = Number(event.target.value)
    $('speech-rate-value').textContent = `${rate.toFixed(1)}×`
    void chrome.storage.sync.set({ speech_rate: rate })
  })
  $('speech-settings-form').addEventListener('submit', (event) => void saveSpeechSettings(event))
  $('btn-preview-speech').addEventListener('click', () => {
    toggleSpeech({ id: SPEECH_PREVIEW_ID, text: SPEECH_PREVIEW_TEXT })
  })
  $('opt-theme').addEventListener('change', (event) => {
    state.prefs.theme = event.target.value
    void savePrefs()
    applyAppearance()
  })
  $('opt-font').addEventListener('change', (event) => {
    state.prefs.font = event.target.value
    void savePrefs()
    applyAppearance()
  })
  $('opt-reduced-motion').addEventListener('change', (event) => {
    state.prefs.reducedMotion = event.target.checked
    void savePrefs()
    applyAppearance()
  })
  $('opt-accent').addEventListener('click', (event) => {
    const swatch = event.target.closest('.accent-swatch')
    if (!swatch || !ACCENTS.includes(swatch.dataset.accent)) return
    state.prefs.accent = swatch.dataset.accent
    void savePrefs()
    applyPrefs()
    setStatus(`已切换强调色:${swatch.title}`)
  })
  $('btn-export').addEventListener('click', (event) => {
    event.stopPropagation()
    toggleExportMenu()
  })
  $('export-menu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-export]')
    if (button) runExport(button.dataset.export)
  })
  document.addEventListener('click', (event) => {
    if (!isExportOpen()) return
    if ($('export-menu').contains(event.target) || $('btn-export').contains(event.target)) return
    closeExportMenu()
  })

  $('btn-more').addEventListener('click', (event) => {
    event.stopPropagation()
    toggleMoreMenu()
  })
  $('more-menu').addEventListener('click', (event) => {
    if (event.target.closest('button:not(#btn-update)')) closeMoreMenu()
  })
  document.addEventListener('click', (event) => {
    if ($('more-menu').hidden) return
    if ($('more-menu').contains(event.target) || $('btn-more').contains(event.target)) return
    closeMoreMenu()
  })
  document.addEventListener('click', (event) => {
    document.querySelectorAll('.action-menu').forEach((menu) => {
      if (menu.hidden || menu.contains(event.target)) return
      const more = menu.previousElementSibling
      if (more && more.contains(event.target)) return
      closeActionMenu(menu)
    })
  })

  $('btn-help').addEventListener('click', toggleHelp)
  $('btn-close-help').addEventListener('click', hideHelp)
  $('help-overlay').addEventListener('click', (event) => {
    if (event.target === $('help-overlay')) hideHelp()
  })
  $('help-overlay').addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      hideHelp()
      return
    }
    trapFocus(event, $('help-overlay'))
  })
  $('btn-scroll-bottom').addEventListener('click', () => {
    const stream = $('stream')
    stream.scrollTo({ top: stream.scrollHeight, behavior: state.prefs.reducedMotion ? 'auto' : 'smooth' })
  })
  $('stream').addEventListener('scroll', () => {
    updateScrollFab()
    hideSelectionToolbar()
  }, { passive: true })
  $('stream').addEventListener('mouseup', () => {
    setTimeout(() => {
      const found = selectionInResult()
      if (found) showSelectionToolbar(found.entry, found.text, found.rect)
      else hideSelectionToolbar()
    }, 0)
  })
  document.addEventListener('mousedown', (event) => {
    if ($('selection-toolbar').hidden) return
    if ($('selection-toolbar').contains(event.target)) return
    hideSelectionToolbar()
  })
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
      if (found) showSelectionToolbar(found.entry, found.text, found.rect)
      else hideSelectionToolbar()
    }, 0)
  })
  $('selection-toolbar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sel-action]')
    if (!button || !state.selection) return
    const { entryId, text } = state.selection
    const entry = state.entries.find((item) => item.id === entryId)
    const action = button.dataset.selAction
    if (action === 'copy') {
      void window.sttDesktop.copyText(text)
      showCopyDone(button)
      setStatus('已复制选中文字')
      selectionFeedback = true
      setTimeout(() => {
        selectionFeedback = false
        hideSelectionToolbar()
        window.getSelection()?.removeAllRanges()
      }, 1400)
      return
    }
    if (entry && action === 'speak') {
      toggleSpeech(entry, text)
    } else if (action === 'translate') {
      $('input').value = text
      updateComposer()
      submit()
    } else if (entry && action === 'save') {
      void saveSelection(entry, text, button)
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

  $('btn-history').addEventListener('click', toggleSidebar)
  $('btn-close-sidebar').addEventListener('click', closeSidebar)
  $('sidebar-backdrop').addEventListener('click', closeSidebar)
  $('sidebar').addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeSidebar()
      return
    }
    trapFocus(event, $('sidebar'))
  })
  $('history-search').addEventListener('input', renderHistory)
  $('history-list').addEventListener('click', (event) => {
    const item = event.target.closest('.history-item')
    if (item) jumpToEntry(item.dataset.entryId)
  })

  document.addEventListener('keydown', (event) => {
    if (event.isComposing || state.isComposing) return
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 'k' && $('help-overlay').hidden) {
      event.preventDefault()
      switchWorkspace('translate')
      closeActionMenus()
      $('input').focus()
      $('input').select()
      return
    }
    if (mod && event.key.toLowerCase() === 'h') {
      event.preventDefault()
      toggleSidebar()
      return
    }
    if (mod && event.key.toLowerCase() === 'e') {
      event.preventDefault()
      toggleExportMenu()
      return
    }
    if ((mod && event.key === '/') || (event.key === '?' && !isTyping(event.target))) {
      event.preventDefault()
      toggleHelp()
      return
    }
    if (event.key === 'Escape') {
      if (!$('selection-toolbar').hidden) {
        hideSelectionToolbar()
        window.getSelection()?.removeAllRanges()
        return
      }
      const openActionMenu = document.querySelector('.action-menu:not([hidden])')
      if (openActionMenu) {
        closeActionMenu(openActionMenu)
        return
      }
      if (!$('more-menu').hidden) {
        closeMoreMenu()
        return
      }
      if (!$('settings-panel').hidden) {
        closeSettings()
        return
      }
      if (!$('help-overlay').hidden) {
        hideHelp()
        return
      }
      if (isExportOpen()) {
        closeExportMenu()
        return
      }
      if (isSidebarOpen()) {
        closeSidebar()
        return
      }
      window.sttDesktop.hide()
    }
  })

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TRANSLATION_EVENT') handleTranslationEvent(message.payload || {})
    else if (message?.type === 'SPEECH_EVENT') handleSpeechEvent(message.payload || {})
  })
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.vocabulary_entries) {
      void updateStudyProgress()
      return
    }
    if (areaName !== 'sync') return
    if (['base_url', 'api_key', 'model', 'learning_model'].some((key) => key in changes)) {
      void checkConfig()
      if (state.workspace === 'tutor') void tutor.refresh()
    }
  })

  window.sttDesktop.onSelection((payload) => {
    const text = String(payload?.text || '').trim()
    if (text) {
      switchWorkspace('translate')
      translatePastedText(text)
      return
    }
    if (state.workspace === 'translate' && $('settings-panel').hidden
      && $('help-overlay').hidden && !isSidebarOpen()) $('input').focus()
  })
  window.sttDesktop.onCardEntry((entry) => {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return
    if (state.entries.some((item) => item.requestId === entry.requestId)) return
    const activeId = String(entry.id || makeId('s'))
    state.entries.push({
      id: activeId,
      requestId: String(entry.requestId || makeId('r')),
      text: entry.text.slice(0, 12000),
      mode: 'translate',
      status: entry.status === 'done' ? 'done' : 'error',
      translatedText: String(entry.translatedText || ''),
      lexical: entry.lexical && typeof entry.lexical === 'object' ? entry.lexical : null,
      guide: null,
      error: String(entry.error || ''),
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      hintCount: 1,
      answerRevealed: false,
    })
    state.activeEntryId = activeId
    persistHistory()
    render()
    setStatus('悬浮卡片的翻译已同步到学习记录')
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
    const savedTarget = await chrome.storage.sync.get(['desktop_target_language'])
    state.targetLanguage = savedTarget?.desktop_target_language || 'auto'
    for (const id of ['lang-target', 'opt-target-language']) {
      const targetSelect = $(id)
      if (targetSelect) targetSelect.value = state.targetLanguage
    }
  } catch {
    // default target language
  }
  try {
    const savedSource = await chrome.storage.sync.get(['desktop_source_language'])
    state.sourceLanguage = savedSource?.desktop_source_language || 'auto'
    const sourceSelect = $('lang-source')
    if (sourceSelect) sourceSelect.value = state.sourceLanguage
  } catch {
    // default source language
  }
  try {
    const savedGlossary = await chrome.storage.sync.get('desktop_glossary')
    state.glossary = sanitizeGlossary(savedGlossary?.desktop_glossary)
    renderGlossaryList()
  } catch {
    // default glossary
  }
  try {
    const savedMemory = await chrome.storage.local.get('translation_memory')
    if (savedMemory?.translation_memory && typeof savedMemory.translation_memory === 'object') {
      state.translationMemory = savedMemory.translation_memory
    }
  } catch {
    // translation memory is optional
  }
  try {
    const savedPrefs = await chrome.storage.sync.get(['desktop_prefs', 'desktop_live_translate'])
    state.liveTranslate = savedPrefs?.desktop_live_translate === true
    if (savedPrefs?.desktop_prefs && typeof savedPrefs.desktop_prefs === 'object') {
      state.prefs = { ...state.prefs, ...savedPrefs.desktop_prefs }
    }
  } catch {
    // default preferences
  }
  applyPrefs()
  try {
    const restored = await window.sttDesktop.loadHistory()
    if (Array.isArray(restored) && restored.length) {
      state.entries = restored.map((entry) => ({
        ...entry,
        status: entry.status === 'done' ? 'done' : 'error',
        error: entry.status === 'done' ? '' : (entry.error || '上次未完成,可重新生成'),
      }))
    }
  } catch {
    // history is optional
  }
  await checkConfig()
  void updateStudyProgress()
  void maybeShowReviewReminder()
  try {
    const version = await window.sttDesktop.getAppVersion()
    $('installed-version').textContent = version ? `v${version}` : '未知'
  } catch {
    $('installed-version').textContent = '未知'
  }
  try {
    const savedDraft = await chrome.storage.local.get('desktop_input_draft')
    if (typeof savedDraft?.desktop_input_draft === 'string' && savedDraft.desktop_input_draft.trim()
      && !$('input').value.trim()) {
      $('input').value = savedDraft.desktop_input_draft
      const previous = state.entries.at(-1)
      if (previous?.text === $('input').value.trim()) {
        state.lastSubmittedText = previous.text
        state.lastLookup = previous.lookupExcluded ? null : {
          id: previous.id, text: previous.text, sourceLanguage: previous.sourceLanguage, createdAt: previous.createdAt,
        }
      }
      updateComposer()
      setStatus(state.lastSubmittedText ? '已恢复上次原文' : '已恢复上次未发送的内容')
    }
  } catch {
    // saved draft is optional
  }
  render()
  $('input').focus()
  if (!state.configured && !state.entries.length) openSettings()
  bindUpdateMenu({
    api: window.sttDesktop,
    announce: announceResult,
    beforeInstall: saveBeforeUpdate,
    onSaveError: (message) => showNotice(message, 'error', null, true),
  })
}

void init()
