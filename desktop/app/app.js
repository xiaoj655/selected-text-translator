import { localizeErrorMessage } from './messages.js'
import { resultText, resultPlainText } from './result-text.js'
import {
  renderLexical, renderGuide, renderGuidePreview, renderTranslation, revealedHints, hintNode,
  sentenceStructure, markSentence, renderSentenceLegend,
} from './translation-result.js'
import { ACTION_LABELS, showCopyDone } from './ui-text.js'
import { createTutorWorkspace } from './reading.js'
import { bindUpdateMenu } from './update-menu.js'
import { bindRequestDebug } from './request-debug.js'
import { buildReviewReminder, formatStudyProgress, getDayKey, getStudyProgress, shouldShowReviewReminder } from '../vendor/src/vocabulary-progress.js'
import { makeMemoryKey, readMemoryEntry, writeMemoryEntry } from '../vendor/src/translation-memory.js'
import { detectSourceLanguage, planLanguageSwap } from '../vendor/src/source-language.js'
import { supportsSentenceStructure, supportsTranslationStructure } from '../vendor/src/reading-support.js'
import { sanitizeGlossary } from '../vendor/src/glossary.js'
import {
  buildLearningArchive,
  parseLearningArchive,
  planArchiveImport,
  serializeLearningArchive,
} from '../vendor/src/learning-archive.js'

const $ = (id) => document.getElementById(id)

const ACCENTS = ['neutral', 'indigo', 'ocean', 'emerald', 'rose', 'amber']
const DETECTED_LANGUAGE_TAGS = {
  chinese: 'zh', english: 'en', japanese: 'ja', korean: 'ko', french: 'fr', german: 'de', spanish: 'es',
}
const MODE_LABELS = { translate: 'Translate', guide: 'Guided Reading' }
const SPEECH_PREVIEW_ID = 'speech-preview'
const SPEECH_PREVIEW_TEXT = 'Could you record the meeting? I need a record of what we decided.'
const DEFAULT_ARTICLE_APPEARANCE = { font: 20, width: 840, fit: false }
const ARTICLE_FONT_SIZES = [18, 20, 22, 24]

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
  prefs: { pasteAutoSubmit: true, enterToSend: false, theme: 'system', font: 'normal', accent: 'neutral', reducedMotion: false,
    articleAppearance: DEFAULT_ARTICLE_APPEARANCE },
  collapsed: new Set(),
  selection: null,
  reviewReminderShown: false,
}

const tutor = createTutorWorkspace({
  rootEl: $('tutor-workspace'),
  api: window.sttDesktop.tutor,
  readingApi: window.sttDesktop.reading,
  onOpenSettings: openSettings,
})

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function languageText(tag, className, text, language) {
  const node = el(tag, className, text)
  const requested = typeof language === 'string' ? language.toLowerCase() : ''
  const detected = Object.hasOwn(DETECTED_LANGUAGE_TAGS, requested) ? requested : detectSourceLanguage(text)
  if (detected) node.lang = DETECTED_LANGUAGE_TAGS[detected]
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
    list.append(el('p', 'glossary-empty', 'No terms yet. Add a term to translate it the same way every time.'))
    return
  }
  state.glossary.forEach((pair, index) => {
    const row = el('div', 'glossary-item')
    row.append(el('span', 'glossary-term', pair.source))
    row.append(el('span', 'glossary-arrow', '→'))
    row.append(el('span', 'glossary-term', pair.target))
    const remove = el('button', 'glossary-remove', '×')
    remove.type = 'button'
    remove.title = 'Remove term'
    remove.setAttribute('aria-label', `Remove term ${pair.source}`)
    remove.dataset.index = String(index)
    remove.addEventListener('click', () => {
      state.glossary.splice(index, 1)
      persistGlossary()
      renderGlossaryList()
      setStatus('Term removed')
    })
    row.append(remove)
    list.append(row)
  })
}

function persistGlossary() {
  state.glossary = sanitizeGlossary(state.glossary)
  const status = $('glossary-status')
  if (status) status.textContent = `${state.glossary.length} terms saved`
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
  const label = $('lang-target').selectedOptions[0]?.textContent || value
  if (retranslate) retranslateCurrent(`Target language set to ${label}`)
  else setStatus(`Target language set to ${label}`)
}

function retranslateCurrent(message) {
  const text = $('input').value.trim()
  if (state.workspace === 'translate' && state.configured && text
    && (state.liveTranslate || state.lastSubmittedText === text)) {
    const lookup = state.lastSubmittedText === text ? state.lastLookup : undefined
    submit({ keepInput: true, lookup })
    setStatus(`${message} · Translating again…`)
    return
  }
  setStatus(message)
}

function setSourceLanguage(value, retranslate) {
  state.sourceLanguage = value
  void chrome.storage.sync.set({ desktop_source_language: value })
  $('lang-source').value = value
  const label = value === 'auto' ? 'automatic detection' : ($('lang-source').selectedOptions[0]?.textContent || value)
  if (retranslate) retranslateCurrent(`Source language set to ${label}`)
  else setStatus(`Source language set to ${label}`)
}

function swapLanguages() {
  const detected = detectSourceLanguage($('input').value)
  const plan = planLanguageSwap({ source: state.sourceLanguage, target: state.targetLanguage, detected })
  if (!plan) {
    setStatus('Enter text and choose a source or target language before swapping.')
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
  retranslateCurrent('Languages swapped')
}

function renderDiagnostics() {
  const lines = [
    `Model: ${state.configured ? 'Configured' : 'Not configured'}`,
    `Mode: ${MODE_LABELS[state.mode]}`,
  ]
  if (state.lastElapsed) lines.push(`Last response: ${state.lastElapsed} ms`)
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
  countEl.textContent = `${count} ${count === 1 ? 'character' : 'characters'}`
  countEl.classList.toggle('is-warn', count > 6000)
  countEl.title = count > 6000 ? 'Long text can take more time or exceed the model’s context limit.' : ''
  const sourceSelect = $('lang-source')
  const detected = detectSourceLanguage(input.value)
  const detectedLabel = detected && sourceSelect?.querySelector(`option[value="${detected[0].toUpperCase()}${detected.slice(1)}"]`)?.textContent
  const autoOption = sourceSelect?.querySelector('option[value="auto"]')
  if (autoOption) autoOption.textContent = detectedLabel ? `Detected: ${detectedLabel}` : 'Detect language'
  $('composer-hint').textContent = state.prefs.pasteAutoSubmit ? 'Translates on paste' : 'Paste, then submit'
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
  if (entry.status === 'done') return resultText(entry) || (entry.mode === 'guide' ? MODE_LABELS.guide : '(No result)')
  if (entry.error) return entry.error
  return 'Processing…'
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
    const haystack = `${entry.text} ${historySnippet(entry)} ${MODE_LABELS[entry.mode] || MODE_LABELS.translate}`.toLowerCase()
    return haystack.includes(query)
  })
  $('history-count').textContent = query
    ? `${matched.length} of ${items.length} results`
    : `${items.length} ${items.length === 1 ? "entry" : "entries"}`
  if (!matched.length) {
    const empty = el('div', 'history-empty')
    const icon = el('div')
    icon.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
    empty.append(icon)
    empty.append(el('div', '', query ? 'No matching entries' : 'No translation history yet'))
    empty.append(el('div', '', query ? 'Try a different search term.' : 'Your translations will appear here.'))
    list.append(empty)
    return
  }
  for (const entry of matched) {
    const item = el('button', 'history-item')
    item.type = 'button'
    item.dataset.entryId = entry.id
    item.title = entry.text
    const top = el('div', 'hi-top')
    top.append(el('span', 'hi-tag', MODE_LABELS[entry.mode] || MODE_LABELS.translate))
    top.append(el('span', 'hi-time', new Date(entry.createdAt).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' })))
    item.append(top)
    item.append(languageText('div', 'hi-text', entry.text, entry.sourceLanguage))
    const snippet = historySnippet(entry)
    item.append(entry.status === 'done' && resultText(entry)
      ? languageText('div', 'hi-result', snippet) : el('div', 'hi-result', snippet))
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
  const kind = entry.mode === 'guide' ? MODE_LABELS.guide : 'Translation'
  const time = new Date(entry.createdAt).toLocaleString('en', { hour12: false })
  return `${index + 1}. ${kind} · ${time}`
}

function entryToMarkdown(entry, index) {
  const lines = []
  lines.push(`## ${entryHeading(entry, index)}`, '')
  lines.push('**Source text**', '', `> ${String(entry.text || '').replace(/\n/g, '\n> ')}`, '')
    if (entry.status === 'error') {
      lines.push('**Status:** Failed', '', `> ${entry.error || 'Unknown error'}`, '')
      return
    }
    if (entry.mode === 'guide') {
      const guide = entry.guide
      if (guide?.phonetic) lines.push(`**Pronunciation:** ${guide.phonetic}`, '')
      if (Array.isArray(guide?.hints) && guide.hints.length) {
        lines.push('**Hints**', '')
        guide.hints.forEach((hint, i) => lines.push(`${i + 1}. ${hint}`))
        lines.push('')
      }
      const answer = guide?.answer
      if (answer) {
        lines.push('**Answer**', '')
        if (answer.meaning) lines.push(`- **Meaning:** ${answer.meaning}`)
        if (answer.explanation) lines.push(`- **Explanation:** ${answer.explanation}`)
        if (answer.example) lines.push(`- **Example:** ${answer.example}`)
        if (answer.usage) lines.push(`- **Usage:** ${answer.usage}`)
        lines.push('')
      }
      return
    }
    lines.push('**Translation**', '', resultText(entry) || '(No result)', '')
    const lexical = entry.lexical
    if (lexical) {
      lines.push('**Dictionary details**', '')
      if (lexical.phonetic) lines.push(`- **Pronunciation:** ${lexical.phonetic}`)
      if (Array.isArray(lexical.definitions)) {
        lexical.definitions.forEach((item) => {
          const example = item.example?.source
            ? ` → *${item.example.source}${item.example.target ? ' / ' + item.example.target : ''}*`
            : ''
          lines.push(`- **${item.pos || 'Definition'}:** ${item.meaning || ''}${example}`)
        })
      }
      if (lexical.contextual_analysis) lines.push(`- **Context:** ${lexical.contextual_analysis}`)
      lines.push('')
    }
  return lines.join('\n')
}

function buildMarkdown() {
  const lines = ['# Selected Text Translator History', '']
  lines.push(`> Exported: ${new Date().toLocaleString('en', { hour12: false })} · ${state.entries.length} ${state.entries.length === 1 ? "entry" : "entries"}`, '')
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
      structure: entry.structure || null,
      sentenceAnalysis: entry.sentenceAnalysis || null,
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
    node.textContent = 'Study progress unavailable'
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
      label: 'Review vocabulary',
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
    ? `Export all ${state.entries.length} ${state.entries.length === 1 ? "entry" : "entries"}`
    : 'No entries to export'
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
  tutor.close()
  hideSelectionToolbar()
  hideNotice()
  clearTimeout(state.liveTimer)
  state.workspace = workspace
  $('btn-translate-workspace').setAttribute('aria-pressed', String(!isTutor))
  $('btn-tutor-workspace').setAttribute('aria-pressed', String(isTutor))
  $('translation-workspace').hidden = isTutor
  $('tutor-workspace').hidden = !isTutor
  document.title = isTutor ? 'English Coach · Selected Text Translator' : 'Selected Text Translator'
  updateScrollFab()
  if (isTutor) void tutor.open()
  else {
    updateComposer()
    $('input').focus()
  }
}

function runExport(kind) {
  if (!state.entries.length) {
    setStatus('No entries to export')
    return
  }
  if (kind === 'md') {
    downloadText(`selected-translations-${formatStamp()}.md`, buildMarkdown(), 'text/markdown')
    setStatus(`Markdown export complete`)
  } else if (kind === 'json') {
    downloadText(`selected-translations-${formatStamp()}.json`, buildJson(), 'application/json')
    setStatus(`JSON export complete`)
  } else if (kind === 'anki') {
    const cell = (value) => String(value || '').replace(/\s+/gu, ' ').trim()
    const rows = state.entries
      .filter((entry) => entry.status === 'done' && entry.text && resultPlainText(entry))
      .map((entry) => `${cell(entry.text)}\t${cell(resultPlainText(entry))}`)
    if (!rows.length) {
      setStatus('No bilingual entries to export to Anki')
      closeExportMenu()
      return
    }
    downloadText(`selected-anki-${formatStamp()}.txt`, rows.join('\n'), 'text/plain')
    setStatus(`Exported ${rows.length} ${rows.length === 1 ? "card" : "cards"} for Anki`)
  } else if (kind === 'copy') {
    window.sttDesktop.copyText(buildMarkdown())
    setStatus('Copied history as Markdown')
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
  const activeAccent = ACCENTS.includes(state.prefs.accent) ? state.prefs.accent : 'neutral'
  $('opt-accent').querySelectorAll('.accent-swatch').forEach((swatch) => {
    const active = swatch.dataset.accent === activeAccent
    swatch.classList.toggle('is-active', active)
    swatch.setAttribute('aria-pressed', String(active))
  })
  updateComposer()
  applyAppearance()
}

function applyAppearance() {
  const root = document.documentElement
  root.dataset.theme = state.prefs.theme || 'system'
  root.dataset.font = state.prefs.font || 'normal'
  root.dataset.motion = state.prefs.reducedMotion ? 'reduced' : 'full'
  root.dataset.accent = ACCENTS.includes(state.prefs.accent) ? state.prefs.accent : 'neutral'
  void window.sttDesktop.setTheme(root.dataset.theme)
}

function applyArticleAppearance() {
  const saved = state.prefs.articleAppearance
  const widthInput = $('opt-article-width')
  const minWidth = Number(widthInput.min)
  const maxWidth = Number(widthInput.max)
  const widthStep = Number(widthInput.step)
  const font = ARTICLE_FONT_SIZES.includes(saved?.font) ? saved.font : DEFAULT_ARTICLE_APPEARANCE.font
  const width = Number.isFinite(saved?.width) && saved.width >= minWidth && saved.width <= maxWidth
    && (saved.width - minWidth) % widthStep === 0 ? saved.width : DEFAULT_ARTICLE_APPEARANCE.width
  const fit = saved?.fit === true
  state.prefs.articleAppearance = { font, width, fit }
  $('opt-article-font').value = String(font)
  widthInput.value = String(width)
  widthInput.disabled = fit
  $('article-width-value').value = `${width} px`
  widthInput.setAttribute('aria-valuetext', `${width} pixels`)
  $('opt-article-fit').checked = fit
  tutor.setArticleAppearance(state.prefs.articleAppearance)
}

function updateArticleAppearance(change, persist = true) {
  state.prefs.articleAppearance = { ...state.prefs.articleAppearance, ...change }
  applyArticleAppearance()
  if (persist) void savePrefs()
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
  if (!isHistorySaved) throw new Error('Could not save translation history.')
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
    const counts = `Vocabulary: ${sources.vocabularyEntries.length} · Translation memory: ${Object.keys(sources.translationMemory).length} · History: ${sources.history.length}`
    statusEl.textContent = `Learning archive exported (${counts}). API keys are excluded.`
    setStatus('Learning archive exported')
  } catch {
    statusEl.textContent = 'Could not export the archive. Try again.'
  }
}

function showArchiveConflicts(counts) {
  const box = $('archive-conflict')
  $('archive-conflict-text').textContent = `Conflicts found: ${counts.totalConflicts} `
    + `(Vocabulary: ${counts.vocabularyConflicts} · Translation memory: ${counts.memoryConflicts}). `
    + `Existing entries will be kept. New entries to import: ${counts.vocabularyAdded + counts.memoryAdded}.`
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
    error: entry.status === 'done' ? '' : (entry.error || 'The last request did not finish. Try again.'),
  }))
  render()
  void updateStudyProgress()
  const { counts } = plan
  statusEl.textContent = `Archive imported. New vocabulary: ${counts.vocabularyAdded} · New translations: ${counts.memoryAdded} · `
    + `History: ${plan.history.length} · Conflicts skipped: ${counts.totalConflicts}`
  setStatus('Learning archive imported')
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
      statusEl.textContent = `Conflicts found: ${plan.counts.totalConflicts}. Choose how to proceed.`
      return
    }
    await applyArchiveImport(plan)
  } catch (error) {
    statusEl.textContent = `Import failed: ${String(error?.message || error)}`
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
    close.title = 'Dismiss notice'
    close.setAttribute('aria-label', 'Dismiss notice')
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
    button.textContent = ok ? '✓ Saved' : 'Could not save'
    setStatus(ok ? 'Saved to vocabulary' : 'Could not save')
  } catch {
    button.textContent = 'Could not save'
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
  setStatus('Draft restored')
  $('input').focus()
}
function showDraftNotice() {
  if (!state.draft) return
  showNotice(`Unsent text saved as a draft.`, 'draft', {
    label: 'Restore draft',
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

function selectSettingsSection(headingId) {
  const heading = $(headingId)
  const page = heading.closest('.settings-page')
  for (const section of document.querySelectorAll('.settings-page')) section.hidden = section !== page
  for (const link of document.querySelectorAll('.settings-nav a')) {
    if ($(link.hash.slice(1)).closest('.settings-page') === page) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  $('settings-panel').querySelector('.drawer-body').scrollTop = 0
  heading.scrollIntoView({ block: 'start' })
  heading.focus({ preventScroll: true })
}

function openSettings(headingId = 'settings-model-heading') {
  closeTransientPanels()
  $('settings-backdrop').hidden = false
  $('settings-panel').hidden = false
  selectSettingsSection(typeof headingId === 'string' ? headingId : 'settings-model-heading')
  void loadSettings()
  void loadFlags()
  renderDiagnostics()
}

function closeSettings() {
  const wasOpen = !$('settings-panel').hidden
  if (state.speechEntryId === SPEECH_PREVIEW_ID) {
    setSpeechStatus('Playback stopped.')
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
      'desktop_tts_cloud', 'desktop_tts_api_key', 'desktop_iqs_api_key',
    ])
    const rate = Number(values?.speech_rate)
    const safeRate = Number.isFinite(rate) && rate >= 0.5 && rate <= 1.5 ? rate : 0.9
    $('cfg-speech-rate').value = String(safeRate)
    $('speech-rate-value').textContent = `${safeRate.toFixed(1)}×`
    $('opt-cloud-speech').checked = values?.desktop_tts_cloud === true
    $('cfg-cloud-speech-key').value = String(values?.desktop_tts_api_key || '')
    $('cfg-iqs-key').value = String(values?.desktop_iqs_api_key || '')
    $('cfg-base-url').value = String(values?.base_url || '')
    $('cfg-api-key').value = String(values?.api_key || '')
    $('cfg-model').value = String(values?.model || '')
    $('cfg-learning').value = String(values?.learning_model || '')
    $('cfg-api-key').type = 'password'
    $('btn-toggle-key').setAttribute('aria-pressed', 'false')
    $('btn-toggle-key').classList.remove('is-on')
    updateSettingsValidity()
  } catch {
    setStatus('Could not load settings')
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
    statusEl.textContent = 'Speech settings saved.'
  } catch {
    statusEl.textContent = 'Could not save speech settings. Try again.'
  } finally {
    button.disabled = false
  }
}

async function saveWebImportSettings(event) {
  event.preventDefault()
  const button = $('btn-save-web-import')
  const statusEl = $('web-import-settings-status')
  button.disabled = true
  try {
    await chrome.storage.sync.set({ desktop_iqs_api_key: $('cfg-iqs-key').value.trim() })
    statusEl.textContent = 'Web import settings saved.'
  } catch {
    statusEl.textContent = 'Could not save web import settings. Try again.'
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
  setFieldError('cfg-base-url', urlMissing ? 'Enter the API URL.' : urlBad ? 'Enter a valid URL starting with http:// or https://.' : '')
  setFieldError('cfg-api-key', values.api_key ? '' : 'Enter the API key.')
  setFieldError('cfg-model', values.model ? '' : 'Enter a translation model.')
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
  const label = visible ? 'Show API key' : 'Hide API key'
  button.title = label
  button.classList.toggle('is-on', !visible)
}

async function saveSettings() {
  if (!updateSettingsValidity()) return
  const button = $('btn-save-settings')
  button.disabled = true
  $('settings-status').dataset.kind = ''
  $('settings-status').textContent = 'Saving…'
  const values = {
    base_url: $('cfg-base-url').value.trim(),
    api_key: $('cfg-api-key').value.trim(),
    model: $('cfg-model').value.trim(),
    learning_model: $('cfg-learning').value.trim(),
  }
  try {
    await chrome.storage.sync.set(values)
    $('settings-status').textContent = 'Settings saved.'
    $('settings-status').dataset.kind = 'success'
    await checkConfig()
    if (state.configured) {
      closeSettings()
      setStatus('Model configured. You can start translating.')
    }
  } catch {
    $('settings-status').textContent = 'Could not save settings. Try again.'
    $('settings-status').dataset.kind = 'error'
  }
  updateSettingsValidity()
}

async function discoverModels() {
  const values = settingsFieldValues()
  if (!isValidBaseUrl(values.base_url) || !values.api_key) { updateSettingsValidity(); return }
  const button = $('btn-discover')
  button.disabled = true
  $('settings-status').textContent = 'Fetching models…'
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DISCOVER_PROVIDER_MODELS',
      payload: { baseUrl: $('cfg-base-url').value.trim(), apiKey: $('cfg-api-key').value.trim() },
    })
    if (!response?.ok) {
      $('settings-status').textContent = response?.message || 'Could not connect. Try again.'
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
    $('settings-status').textContent = `Text models found: ${models.length}`
  } catch {
    $('settings-status').textContent = 'Could not connect. Check your network connection.'
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
    showNotice('Set up your API URL, key, and model to start translating.', 'info', {
      label: 'Open settings',
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
  $('send-label').textContent = state.mode === 'guide' ? 'Start guided reading' : MODE_LABELS.translate
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
  retranslateCurrent(`Switched to ${MODE_LABELS[mode]}`)
  if (state.workspace === 'translate') $('input').focus()
}

function sendRequest(entry, forceRefresh = false) {
  setStatus(`${forceRefresh ? 'Regenerating' : 'Processing'} · ${MODE_LABELS[entry.mode]} · ${entry.text.length} characters`)
  try {
    chrome.runtime.sendMessage({
      type: 'START_TRANSLATION',
      payload: {
        selectionId: entry.id,
        requestId: entry.requestId,
        kind: entry.mode,
        includeSentenceStructure: true,
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
      if (!response?.accepted) failEntry(entry, 'Could not start the request. Try again.')
    })
  } catch {
    failEntry(entry, 'Could not reach the background service. Restart the app.')
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
      setStatus('Clipboard is empty. Copy some text to translate.')
      $('input').focus()
      return
    }
    if (state.workspace === 'translate') translatePastedText(text)
  } catch {
    setStatus('Could not read the clipboard')
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
    setStatus('Translation started automatically')
  }, 850)
}

function workbenchMemoryKey(text, mode) {
  const withStructure = mode === 'guide' ? supportsSentenceStructure(text, state.sourceLanguage)
    : supportsTranslationStructure(text, state.sourceLanguage)
  const key = makeMemoryKey({
    text: withStructure ? '' : text, mode: withStructure ? `${mode}-structure-v2` : mode,
    targetLanguage: state.targetLanguage, sourceLanguage: state.sourceLanguage, model: state.model, glossary: state.glossary,
  })
  // Highlights are offsets into the verbatim input. The ordinary memory key folds whitespace.
  return withStructure ? `${key}\u0000${text}` : key
}

function submit(options = {}) {
  if (state.isComposing || state.workspace !== 'translate') return
  clearTimeout(state.liveTimer)
  state.liveTimer = 0
  if (!options.keepInput) state.liveText = ''
  const text = $('input').value.trim()
  if (!text) {
    $('input').focus()
    setStatus('Enter or paste text to translate')
    return
  }
  if (!state.configured) {
    void checkConfig()
    setStatus('Set up a translation model first')
    return
  }
  const memoryKey = workbenchMemoryKey(text, state.mode)
  const pending = state.entries.some((entry) => entry.memoryKey === memoryKey && entry.text === text
    && ['pending', 'loading', 'streaming'].includes(entry.status))
  if (pending) {
    setStatus('Already processing this text')
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
    entry.structure = cached.structure || null
    entry.sentenceAnalysis = cached.sentenceAnalysis || null
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
    setStatus('From translation memory')
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
      if (entry.mode === 'guide') entry.previewHint = payload.previewHint
      else entry.translatedText = String(payload.translatedText || '').trim()
      break
    case 'success':
      entry.status = 'done'
      if (entry.mode === 'guide') entry.guide = payload.result || null
      else {
        entry.translatedText = String(payload.translatedText || entry.translatedText || '').trim()
        entry.lexical = payload.lexicalDetails || null
        entry.structure = payload.structure || null
        entry.sentenceAnalysis = payload.sentenceAnalysis || null
        if (!entry.translatedText) {
          entry.status = 'error'
          entry.error = 'The model returned no translation. Try again or choose another model.'
          setStatus(entry.error)
          restoreFailedText(entry)
          announceResult(entry.error)
          break
        }
      }
      state.lastElapsed = Date.now() - entry.createdAt
      setStatus(`Done · ${state.lastElapsed} ms`)
      announceResult(entry.mode === 'guide'
        ? (entry.guide?.answer?.meaning || entry.guide?.hints?.[0] || '')
        : entry.translatedText)
      if (entry.memoryKey && (entry.mode === 'guide' ? entry.guide : entry.translatedText)) {
        state.translationMemory = writeMemoryEntry(state.translationMemory, entry.memoryKey, {
          translatedText: entry.translatedText,
          lexical: entry.lexical,
          guide: entry.guide,
          structure: entry.structure,
          sentenceAnalysis: entry.sentenceAnalysis,
        })
        try {
          Promise.resolve(chrome.storage.local.set({ translation_memory: state.translationMemory })).catch(() => {})
        } catch { }
      }
      void recordTutorLookup(entry)
      break
    case 'structure':
      if (entry.mode !== 'translate' || entry.status !== 'done') return
      entry.structure = payload.structure
      entry.sentenceAnalysis = payload.sentenceAnalysis || null
      if (entry.memoryKey && (sentenceStructure(entry).length || entry.sentenceAnalysis)) {
        state.translationMemory = writeMemoryEntry(state.translationMemory, entry.memoryKey, entry)
        void chrome.storage.local.set({ translation_memory: state.translationMemory }).catch(() => {})
      }
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
  if (payload.status === 'error') setSpeechStatus('Speech unavailable. Check speech settings and system voices.')
  if (payload.status === 'end') setSpeechStatus('Playback finished.')
  if (payload.status === 'interrupted' || payload.status === 'cancelled') setSpeechStatus('Playback stopped.')
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
  previewButton.textContent = isPreviewPlaying ? 'Stop preview' : 'Preview voice'
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
  box.append(el('h2', 'empty-title', 'Try an example'))

  const examples = el('div', 'empty-examples')
  for (const [label, text] of [
    ['English word', 'record'],
    ['English sentence', 'The report, which was filed late, still changed the decision.'],
    ['Chinese sentence', '这份报告虽然提交晚了,但仍然改变了最终决定。'],
  ]) {
    const button = el('button', '', label)
    button.type = 'button'
    button.addEventListener('click', () => {
      $('input').value = text
      updateComposer()
      $('input').focus()
      if (state.configured) submit({ lookup: null })
      else setStatus('Example added. Set up your model, then click Translate.')
    })
    examples.append(button)
  }
  box.append(examples)
  return box
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
  if (remaining > 0) more.textContent = `Next hint (${remaining} left)`
  else more.remove()
  persistHistory()
  updateScrollFab()
}

function renderResult(entry) {
  const result = el('div', 'result')
  if (entry.status === 'error') {
    result.classList.add('is-error')
    result.setAttribute('role', 'alert')
    const message = el('div', 'error-message')
    message.append(el('strong', 'error-title', 'Request failed'), el('span', '', entry.error || 'Try again'))
    const tools = el('div', 'error-tools')
    const retry = el('button', '', 'Retry')
    retry.type = 'button'
    retry.addEventListener('click', () => regenerate(entry))
    const fix = el('button', '', 'Open settings')
    fix.type = 'button'
    fix.addEventListener('click', openSettings)
    const remove = el('button', 'is-danger', 'Delete')
    remove.type = 'button'
    remove.addEventListener('click', () => deleteEntry(entry))
    tools.append(retry, fix, remove)
    result.append(message, tools)
    return result
  }
  if (entry.status === 'pending' || entry.status === 'loading'
    || (entry.status === 'streaming' && entry.mode === 'guide')) {
    result.classList.add('is-loading')
    if (entry.status === 'streaming' && entry.previewHint) result.append(renderGuidePreview(entry.previewHint))
    else result.textContent = 'Waiting for the model…'
    return result
  }
  if (entry.mode === 'guide') {
    if (entry.guide) {
      const guide = renderGuide(entry, {
        onRevealHint: revealNextHint,
        onToggleAnswer: () => {
          entry.answerRevealed = !entry.answerRevealed
          persistHistory()
          renderEntry(entry)
        },
      })
      if (guide) result.append(guide)
      else result.textContent = 'No guidance was generated. Try again.'
    } else {
      result.textContent = 'No guidance was generated. Try again.'
    }
    return result
  }
  if (!entry.translatedText) {
    result.classList.add('is-loading')
    result.textContent = 'Waiting for translation…'
    return result
  }
  result.append(renderTranslation(entry, { languageText }))
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
    memoryKey: workbenchMemoryKey(entry.text, mode),
  }
  const cached = readMemoryEntry(state.translationMemory, companion.memoryKey)
  if (cached) {
    companion.status = 'done'
    companion.translatedText = cached.translatedText || ''
    companion.lexical = cached.lexical || null
    companion.guide = cached.guide || null
    companion.structure = cached.structure || null
    companion.sentenceAnalysis = cached.sentenceAnalysis || null
    companion.fromMemory = true
  }
  stopActiveSpeech()
  cancelStaleRequests(companion.id)
  state.entries.push(companion)
  state.activeEntryId = companion.id
  render()
  if (cached) {
    setStatus('From translation memory')
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
  showSnackbar('Entry deleted', 'Undo', () => {
    state.entries.splice(Math.min(index, state.entries.length), 0, removed)
    render()
    setStatus('Entry restored')
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
  bar.setAttribute('aria-label', 'Result actions')

  const text = resultPlainText(entry)
  if (text && entry.status === 'done') {
    const copy = el('button', 'is-primary', ACTION_LABELS.copyResult)
    copy.type = 'button'
    copy.addEventListener('click', (event) => {
      window.sttDesktop.copyText(text)
      setStatus('Result copied to clipboard')
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
    const save = el('button', 'action-save', 'Save')
    save.type = 'button'
    save.dataset.saveButton = 'true'
    save.addEventListener('click', (event) => void saveVocabulary(entry, event.currentTarget))
    bar.append(save)
  }

  const more = el('button', 'action-more', '⋯')
  more.type = 'button'
  more.title = 'More actions'
  more.setAttribute('aria-label', 'More actions')
  more.setAttribute('aria-expanded', 'false')
  const menu = el('div', 'action-menu')
  menu.id = makeId('actions')
  menu.setAttribute('popover', 'auto')
  menu.setAttribute('role', 'group')
  menu.setAttribute('aria-label', 'Result actions')
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
      const companion = menuAdd(companionMode === 'guide' ? 'Explore with hints' : 'Translate',
        () => startCompanionEntry(entry, companionMode), false, 'action-companion')
      companion.dataset.companionMode = companionMode
    }
  }
  menuAdd(ACTION_LABELS.copySource, (event) => {
    window.sttDesktop.copyText(entry.text)
    setStatus('Source text copied to clipboard')
    showCopyDone(event.currentTarget)
  })
  menuAdd('Copy source and translation', (event) => {
    const bilingual = `Source text\n${String(entry.text || '').trim()}\n\nTranslation\n${text || '(No result)'}`
    window.sttDesktop.copyText(bilingual)
    setStatus('Copied source and translation')
    showCopyDone(event.currentTarget)
  })
  if (entry.status === 'done' && text) {
    menuAdd('Listen to translation', () => toggleSpeech(entry, resultPlainText(entry)))
  }
  menuAdd('Send to input', () => {
    $('input').value = entry.text
    updateComposer()
    $('input').focus()
    setStatus('Text sent to input')
  })
  menuAdd('Export as Markdown', () => {
    const index = state.entries.indexOf(entry)
    const filename = `translation-${entry.id || index + 1}.md`
    downloadText(filename, entryToMarkdown(entry, index), 'text/markdown')
    setStatus('Entry exported as Markdown')
  })
  menuAdd('Delete', () => deleteEntry(entry), true)
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
  source.append(el('span', 'source-label', 'Source text'))
  const bubble = languageText('div', 'bubble', entry.text, entry.sourceLanguage)
  bubble.title = 'Click to send this text to input'
  bubble.addEventListener('click', () => {
    if (String(window.getSelection()?.toString() || '').trim()) return
    $('input').value = entry.text
    updateComposer()
    $('input').focus()
  })
  source.append(bubble)
  const structure = sentenceStructure(entry)
  if (structure.length) {
    source.classList.add('has-sentence-structure')
    markSentence(bubble, entry.text, structure)
    source.append(renderSentenceLegend(structure))
  }
  wrapper.append(source)

  const card = el('div', 'entry-card')
  if (entry.mode === 'guide') card.classList.add('entry-card--guide')
  const head = el('button', 'entry-head')
  head.type = 'button'
  head.setAttribute('aria-expanded', String(!collapsed))
  head.setAttribute('aria-controls', `entry-result-${entry.id}`)
  head.append(el('span', 'tag', MODE_LABELS[entry.mode] || MODE_LABELS.translate))
  if (entry.fromMemory) head.append(el('span', 'memory-tag', 'Translation memory'))
  head.append(el('span', 'meta', new Date(entry.createdAt).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' })))
  head.append(el('span', 'spacer'))
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
  body.id = `entry-result-${entry.id}`
  const label = entry.status === 'error' ? 'Error'
    : ['pending', 'loading', 'streaming'].includes(entry.status) ? 'Processing'
      : entry.mode === 'guide' ? 'Guidance' : 'Translation'
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
  if (label) label.textContent = 'Processing'
  if (entry.mode === 'guide') {
    result.replaceWith(renderResult(entry))
    followStreamBottom()
    return
  }
  result.classList.remove('is-error', 'is-loading')
  const answer = el('div', 'translation-answer')
  const text = languageText('span', 'translation-text', entry.translatedText || '')
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
  const restoreHeading = document.activeElement === node.querySelector('.entry-head')
  const next = renderEntryEl(entry)
  node.replaceWith(next)
  if (restoreHeading) next.querySelector('.entry-head').focus({ preventScroll: true })
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
    stale.error = 'Replaced by a newer request.'
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
  entry.error = 'Request canceled. You can try again.'
  restoreFailedText(entry)
  renderEntry(entry)
  setStatus('Request canceled')
}

function regenerate(entry) {
  entry.requestId = makeId('r')
  entry.status = 'pending'
  entry.translatedText = ''
  entry.lexical = null
  entry.guide = null
  entry.structure = null
  entry.sentenceAnalysis = null
  entry.analysisExpanded = false
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
    setSpeechStatus('Playback stopped.')
    stopActiveSpeech()
    patchSpeechButtons()
    if (isSameEntry) return
  }
  const speechId = makeId('speech')
  state.speechId = speechId
  state.speechEntryId = entry.id
  setSpeechStatus('Reading aloud…')
  patchSpeechButtons()
  try {
    chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId, text } }, (response) => {
      if (!response?.ok && state.speechId === speechId) {
        setSpeechStatus(response?.message || 'Speech unavailable')
        state.speechId = null
        state.speechEntryId = null
        patchSpeechButtons()
      }
    })
  } catch {
    setSpeechStatus('Speech unavailable')
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
    button.textContent = response?.ok ? '✓ Saved' : 'Could not save'
    setStatus(response?.ok ? 'Saved to vocabulary' : 'Could not save')
    if (response?.ok) void updateStudyProgress()
  } catch {
    button.textContent = 'Could not save'
  }
  button.removeAttribute('aria-busy')
}

function bind() {
  bindRequestDebug({
    api: window.sttDesktop.requestDebug,
    copyText: (text) => window.sttDesktop.copyText(text),
    prepareOpen: () => {
      closeTransientPanels()
      $('btn-more').focus()
    },
  })
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
      showNotice('Could not open the releases page', 'error', null, true)
    }
  })
  $('btn-settings').addEventListener('click', openSettings)
  $('btn-close-settings').addEventListener('click', closeSettings)
  $('settings-panel').querySelector('.settings-nav').addEventListener('click', (event) => {
    const link = event.target.closest('a')
    if (!link) return
    event.preventDefault()
    selectSettingsSection(link.hash.slice(1))
  })
  $('model-settings-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void saveSettings()
  })
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
    $('archive-status').textContent = 'Import canceled'
  })
  $('btn-library').addEventListener('click', () => window.sttDesktop.openLibrary())
  $('btn-study-progress').addEventListener('click', () => window.sttDesktop.openLibrary())
  $('btn-log').addEventListener('click', () => window.sttDesktop.openLog())
  $('opt-always-on-top').addEventListener('change', (event) => {
    void window.sttDesktop.setAlwaysOnTop(event.target.checked)
    setStatus(event.target.checked ? 'Always on top enabled' : 'Always on top disabled')
  })
  $('opt-login-item').addEventListener('change', (event) => {
    void window.sttDesktop.setLoginItem(event.target.checked)
    setStatus(event.target.checked ? 'Launch at login enabled' : 'Launch at login disabled')
  })
  $('opt-live-translate').addEventListener('change', (event) => {
    state.liveTranslate = event.target.checked
    clearTimeout(state.liveTimer)
    state.liveTimer = 0
    void chrome.storage.sync.set({ desktop_live_translate: state.liveTranslate })
    setStatus(state.liveTranslate ? 'Translate as you type enabled' : 'Translate as you type disabled')
  })
  $('opt-target-language').addEventListener('change', (event) => setTargetLanguage(event.target.value, false))
  $('glossary-add').addEventListener('click', () => {
    const source = $('glossary-source').value.trim()
    const target = $('glossary-target').value.trim()
    if (!source || !target) {
      setStatus('Enter the term and its preferred translation.')
      return
    }
    state.glossary = sanitizeGlossary([...state.glossary, { source, target }])
    $('glossary-source').value = ''
    $('glossary-target').value = ''
    persistGlossary()
    renderGlossaryList()
    setStatus('Term added')
  })
  $('lang-target').addEventListener('change', (event) => setTargetLanguage(event.target.value, true))
  $('lang-source').addEventListener('change', (event) => setSourceLanguage(event.target.value, true))
  $('btn-swap-lang').addEventListener('click', swapLanguages)
  $('btn-clear').addEventListener('click', () => {
    if (!state.entries.length) {
      setStatus('No history to clear')
      return
    }
    const count = state.entries.length
    showSnackbar(`Clear translation history (${count})?`, 'Clear', () => {
      const removed = state.entries.slice()
      state.entries = []
      void window.sttDesktop.clearHistory()
      render()
      showSnackbar('Translation history cleared', 'Undo', () => {
        state.entries = removed
        render()
        setStatus('Translation history restored')
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
    setStatus(event.target.checked ? 'Translate on paste enabled' : 'Translate on paste disabled')
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
  $('web-import-settings-form').addEventListener('submit', (event) => void saveWebImportSettings(event))
  $('iqs-console-link').addEventListener('click', async (event) => {
    event.preventDefault()
    try {
      await window.sttDesktop.reading.openConsole()
    } catch {
      $('web-import-settings-status').textContent = 'Could not open the IQS console. Copy the link to open it in your browser.'
    }
  })
  for (const link of document.querySelectorAll('.bailian-console-link')) {
    link.addEventListener('click', async (event) => {
      event.preventDefault()
      try {
        await window.sttDesktop.openBailianConsole()
      } catch {
        showNotice('Could not open the Model Studio console. Copy the link to open it in your browser.', 'error', null, true)
      }
    })
  }
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
  $('opt-article-font').addEventListener('change', (event) => {
    updateArticleAppearance({ font: Number(event.target.value) })
  })
  $('opt-article-width').addEventListener('input', (event) => {
    updateArticleAppearance({ width: event.target.valueAsNumber }, false)
  })
  $('opt-article-width').addEventListener('change', () => void savePrefs())
  $('opt-article-fit').addEventListener('change', (event) => {
    updateArticleAppearance({ fit: event.target.checked })
  })
  $('opt-article-reset').addEventListener('click', () => updateArticleAppearance(DEFAULT_ARTICLE_APPEARANCE))
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
    setStatus(`Accent color: ${swatch.title}`)
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
      setStatus('Selection copied')
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
    if (event.isComposing || state.isComposing || $('request-debug').open) return
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
    setStatus('Floating card translation added to history')
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
  applyArticleAppearance()
  try {
    const restored = await window.sttDesktop.loadHistory()
    if (Array.isArray(restored) && restored.length) {
      state.entries = restored.map((entry) => ({
        ...entry,
        status: entry.status === 'done' ? 'done' : 'error',
        error: entry.status === 'done' ? '' : (entry.error || 'The last request did not finish. Try again.'),
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
    $('installed-version').textContent = version ? `v${version}` : 'Unknown'
  } catch {
    $('installed-version').textContent = 'Unknown'
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
      setStatus(state.lastSubmittedText ? 'Last source text restored' : 'Unsent text restored')
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
