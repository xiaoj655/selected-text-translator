import { localizeErrorMessage } from './messages.js'
import { resultText, resultPlainText } from './result-text.js'
import { ACTION_LABELS, showCopyDone } from './ui-text.js'
import { formatStudyProgress, getStudyProgress } from '../vendor/src/vocabulary-progress.js'
import { makeMemoryKey, readMemoryEntry, writeMemoryEntry } from '../vendor/src/translation-memory.js'
import {
  buildLearningArchive,
  mergeHistoryEntries,
  parseLearningArchive,
  serializeLearningArchive,
} from '../vendor/src/learning-archive.js'

const $ = (id) => document.getElementById(id)

const ACCENTS = ['indigo', 'ocean', 'emerald', 'rose', 'amber']

const state = {
  mode: 'translate',
  targetLanguage: 'auto',
  model: '',
  translationMemory: {},
  entries: [],
  counter: 0,
  configured: false,
  speechId: null,
  speechEntryId: null,
  hotkey: '',
  capture: null,
  draft: null,
  snackbarTimer: null,
  lastElapsed: 0,
  prefs: { pasteAutoSubmit: true, enterToSend: false, theme: 'system', font: 'normal', accent: 'indigo', reducedMotion: false },
  collapsed: new Set(),
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

function setStatus(text) {
  $('statusbar').textContent = text
  renderDiagnostics()
}

function renderDiagnostics() {
  const lines = [
    `配置:${state.configured ? '已连接' : '未连接'}`,
    `热键:${state.hotkey || '未注册'}`,
    `取词:${state.capture?.source || '尚未触发'}`,
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
  $('composer-hint').textContent = state.prefs.enterToSend
    ? 'Enter 发送 · Shift+Enter 换行' : 'Ctrl+Enter 发送 · Enter 换行'
}

function isTyping(node) {
  if (!node) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

function showHelp() {
  closeTransientPanels()
  $('help-hotkey').textContent = state.hotkey || '未注册'
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
  hideHelp()
  closeExportMenu()
  closeMoreMenu()
  closeSidebar()
  closeSettings()
}

function updateScrollFab() {
  const stream = $('stream')
  const far = stream.scrollHeight - stream.scrollTop - stream.clientHeight > 120
  $('btn-scroll-bottom').hidden = !far
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
  state.collapsed.delete(id)
  renderEntry(entry)
  closeSidebar()
  const node = $('stream').querySelector(`[data-entry-id="${id}"]`)
  if (!node) return
  node.scrollIntoView({ behavior: state.prefs.reducedMotion ? 'auto' : 'smooth', block: 'center' })
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

function updateStats() {
  const entries = state.entries
  const guides = entries.filter((entry) => entry.mode === 'guide').length
  const chars = entries.reduce((sum, entry) => sum + String(entry.text || '').length, 0)
  const node = $('status-stats')
  node.textContent = `共 ${entries.length} 条 · 翻译 ${entries.length - guides} · 引导 ${guides} · 原文 ${chars.toLocaleString('zh-CN')} 字`
  node.title = `本次会话共 ${entries.length} 条记录,原文累计 ${chars} 字`
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
  $('more-menu').hidden = true
  $('btn-more').setAttribute('aria-expanded', 'false')
}

function toggleMoreMenu() {
  const menu = $('more-menu')
  const wasOpen = !menu.hidden
  closeTransientPanels()
  if (wasOpen) return
  menu.hidden = false
  $('btn-more').setAttribute('aria-expanded', 'true')
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

async function importLearningArchive(file) {
  const statusEl = $('archive-status')
  if (!file) return
  try {
    const parsed = parseLearningArchive(await file.text())
    const sources = await readArchiveSources()
    const existingKeys = new Set(sources.vocabularyEntries.map((entry) => `${entry.text}\n${entry.meaning}`))
    let added = 0
    const vocabulary = [...sources.vocabularyEntries]
    for (const entry of parsed.vocabularyEntries) {
      const key = `${entry.text}\n${entry.meaning}`
      if (existingKeys.has(key)) continue
      existingKeys.add(key)
      vocabulary.push(entry)
      added++
    }
    const memory = { ...sources.translationMemory, ...parsed.translationMemory }
    const history = mergeHistoryEntries(sources.history, parsed.historyEntries)
    await chrome.storage.local.set({ vocabulary_entries: vocabulary, translation_memory: memory })
    window.sttDesktop.saveHistory(history)
    state.translationMemory = memory
    state.entries = history.map((entry) => ({
      ...entry,
      status: entry.status === 'done' ? 'done' : 'error',
      error: entry.status === 'done' ? '' : (entry.error || '上次未完成,可重新生成'),
    }))
    render()
    void updateStudyProgress()
    statusEl.textContent = `已导入档案:新增收藏 ${added} 条,恢复记忆 ${Object.keys(parsed.translationMemory).length} 条,记录 ${parsed.historyEntries.length} 条。`
    setStatus('已导入完整学习档案')
  } catch (error) {
    statusEl.textContent = `导入失败:${String(error?.message || error)}`
  }
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

async function showCaptureHint(payload) {
  let platform = ''
  try {
    platform = await window.sttDesktop.platform?.() || ''
  } catch { }
  const source = payload?.source || ''
  let text = '没能自动取词。把文字粘贴到下面的输入框即可,或先复制再按热键。'
  if (source === 'error') {
    if (platform === 'darwin') {
      text = '自动取词需要「辅助功能」权限。请在系统设置 → 隐私与安全性 → 辅助功能中允许本应用,然后选中文字再按热键;也可直接粘贴。'
    } else if (platform === 'win32') {
      text = '自动取词失败。请先选中文字再按热键;若仍失败,可复制文字后直接粘贴,或在设置里切换为「仅用剪贴板取词」。'
    }
  }
  showNotice(text, 'info', {
    label: '查看设置',
    run: openSettings,
  })
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
  if (!current.trim() || current === incoming) return
  state.draft = current
}
function restoreDraft() {
  if (!state.draft) return
  $('input').value = state.draft
  state.draft = null
  updateComposer()
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
  $('settings-backdrop').hidden = true
  $('settings-panel').hidden = true
  if (wasOpen) $('btn-settings').focus()
}

async function loadFlags() {
  try {
    const flags = await window.sttDesktop.getFlags()
    $('opt-always-on-top').checked = Boolean(flags?.alwaysOnTop)
    $('opt-login-item').checked = Boolean(flags?.loginItem)
    $('opt-clipboard-only').checked = Boolean(flags?.clipboardOnly)
    $('opt-main-window-only').checked = Boolean(flags?.floatingCardDisabled)
    $('cfg-hotkey').value = state.hotkey || ''
  } catch {
    // flags are optional
  }
}

async function loadSettings() {
  try {
    const values = await chrome.storage.sync.get(['base_url', 'api_key', 'model', 'learning_model', 'speech_rate'])
    const rate = Number(values?.speech_rate)
    const safeRate = Number.isFinite(rate) && rate >= 0.5 && rate <= 1.5 ? rate : 0.9
    $('cfg-speech-rate').value = String(safeRate)
    $('speech-rate-value').textContent = `${safeRate.toFixed(1)}×`
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
        targetLanguage: state.targetLanguage,
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
    $('input').value = text
    updateComposer()
    submit()
  } catch {
    setStatus('读取剪贴板失败')
  }
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
  const recent = state.entries[state.entries.length - 1]
  if (recent && recent.text === text && ['pending', 'loading', 'streaming'].includes(recent.status)
    && Date.now() - recent.createdAt < 2000) {
    setStatus('相同内容正在处理中,请稍候')
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
    fromMemory: false,
  }
  const memoryKey = makeMemoryKey({ text, mode: state.mode, targetLanguage: state.targetLanguage, model: state.model })
  const cached = readMemoryEntry(state.translationMemory, memoryKey)
  if (cached) {
    entry.status = 'done'
    entry.translatedText = cached.translatedText || ''
    entry.lexical = cached.lexical || null
    entry.guide = cached.guide || null
    entry.fromMemory = true
    entry.memoryKey = memoryKey
    state.lastElapsed = 0
  } else {
    entry.memoryKey = memoryKey
  }
  stopActiveSpeech()
  state.entries.push(entry)
  $('input').value = ''
  updateComposer()
  hideNotice()
  render()
  if (cached) {
    setStatus('来自翻译记忆 · 即时')
    persistHistory()
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
      }
      state.lastElapsed = Date.now() - entry.createdAt
      setStatus(`完成 · ${state.lastElapsed} ms`)
      if (entry.memoryKey) {
        state.translationMemory = writeMemoryEntry(state.translationMemory, entry.memoryKey, {
          translatedText: entry.translatedText,
          lexical: entry.lexical,
          guide: entry.guide,
        })
        try {
          Promise.resolve(chrome.storage.local.set({ translation_memory: state.translationMemory })).catch(() => {})
        } catch { }
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

function handleSpeechEvent(payload) {
  if (payload.speechId !== state.speechId) return
  if (!['end', 'error', 'interrupted', 'cancelled'].includes(payload.status)) return
  state.speechId = null
  state.speechEntryId = null
  if (payload.message) setStatus(payload.message)
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
  box.append(el('h2', '', '让每个英文词句,都真正读懂'))
  box.append(el('p', 'empty-lead', '不只给译文。按需选择「直接翻译」快速理解,或用「引导理解」自己想出含义。'))

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

  const line1 = el('p', 'empty-tip', '复制内容后点「粘贴并翻译」,或直接试试:')
  box.append(line1)
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
      if (state.configured) submit()
      else setStatus('已填入示例,点「翻译」或按 Ctrl+Enter')
    })
    examples.append(button)
  }
  box.append(examples)
  const hotkey = el('p', 'empty-hotkey')
  hotkey.append('在任意应用中选中英文,按 ')
  hotkey.append(el('kbd', '', state.hotkey || 'Alt+Shift+E'))
  hotkey.append(' 即可取词。')
  box.append(hotkey)
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
  box.append(el('div', 'guide-intro', '先想一想,再看提示,最后揭晓答案 · 主动思考记得更牢'))
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
  if (lexical) result.append(lexical)
  return result
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

function renderActions(entry) {
  const bar = el('div', 'actions')

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
  } else {
    const regenerate = el('button', '', ACTION_LABELS.regenerate)
    regenerate.type = 'button'
    regenerate.addEventListener('click', () => regenerate(entry))
    bar.append(regenerate)
  }

  const more = el('button', 'action-more', '⋯')
  more.type = 'button'
  more.title = '更多操作'
  more.setAttribute('aria-label', '更多操作')
  more.setAttribute('aria-expanded', 'false')
  const menu = el('div', 'action-menu')
  menu.hidden = true
  const menuAdd = (label, handler, danger = false) => {
    const button = el('button', danger ? 'is-danger' : '', label)
    button.type = 'button'
    button.addEventListener('click', (event) => {
      menu.hidden = true
      more.setAttribute('aria-expanded', 'false')
      handler(event)
    })
    menu.append(button)
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
  menuAdd('收藏', (event) => void saveVocabulary(entry, event.currentTarget))
  menuAdd('导出此条为 Markdown', () => {
    const index = state.entries.indexOf(entry)
    const filename = `译文-${entry.id || index + 1}.md`
    downloadText(filename, entryToMarkdown(entry, index), 'text/markdown')
    setStatus('已导出此条为 Markdown')
  })
  menuAdd('删除', () => deleteEntry(entry), true)
  more.addEventListener('click', (event) => {
    event.stopPropagation()
    const wasOpen = !menu.hidden
    document.querySelectorAll('.action-menu').forEach((item) => { item.hidden = true })
    document.querySelectorAll('.action-more').forEach((item) => item.setAttribute('aria-expanded', 'false'))
    if (!wasOpen) {
      menu.hidden = false
      more.setAttribute('aria-expanded', 'true')
      requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect()
        const streamBottom = $('stream').getBoundingClientRect().bottom
        menu.classList.toggle('is-up', rect.bottom > streamBottom - 8)
      })
    }
  })
  bar.append(more, menu)
  return bar
}

function renderEntryEl(entry) {
  const wrapper = el('div', 'entry')
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
  const stick = forceBottom || isNearBottom()
  stream.replaceChildren()
  if (!state.entries.length) stream.append(renderEmpty())
  else for (const entry of state.entries) stream.append(renderEntryEl(entry))
  if (stick) stream.scrollTop = stream.scrollHeight
  updateScrollFab()
  renderHistory()
  updateStats()
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
  result.replaceChildren(document.createTextNode(entry.translatedText || ''), el('span', 'caret'))
  const lexical = renderLexical(entry)
  if (lexical) result.append(lexical)
  followStreamBottom()
  updateStats()
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
  updateStats()
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
  renderEntry(entry)
  sendRequest(entry, true)
}

function toggleSpeech(entry, text = entry.text) {
  if (state.speechId) {
    stopActiveSpeech()
    patchSpeechButtons()
    return
  }
  const speechId = makeId('speech')
  state.speechId = speechId
  state.speechEntryId = entry.id
  setStatus('正在朗读…')
  patchSpeechButtons()
  try {
    chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId, text } }, (response) => {
      if (!response?.ok && state.speechId === speechId) {
        state.speechId = null
        state.speechEntryId = null
        setStatus(response?.message || '朗读不可用')
        patchSpeechButtons()
      }
    })
  } catch {
    state.speechId = null
    state.speechEntryId = null
    setStatus('朗读不可用')
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
  $('btn-send').addEventListener('click', submit)
  $('btn-settings').addEventListener('click', openSettings)
  $('btn-close-settings').addEventListener('click', closeSettings)
  $('btn-save-settings').addEventListener('click', () => void saveSettings())
  $('btn-discover').addEventListener('click', () => void discoverModels())
  for (const id of ['cfg-base-url', 'cfg-api-key', 'cfg-model', 'cfg-learning']) {
    $(id).addEventListener('input', updateSettingsValidity)
  }
  $('btn-toggle-key').addEventListener('click', (event) => { event.preventDefault(); toggleKeyVisibility() })
  $('settings-panel').addEventListener('keydown', (event) => {
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
  $('opt-clipboard-only').addEventListener('change', (event) => {
    void window.sttDesktop.setCaptureMode(event.target.checked ? 'clipboard' : 'auto')
    setStatus(event.target.checked
      ? '已切换为仅剪贴板取词:复制后按热键即可,不需要辅助功能权限'
      : '已恢复自动取词')
  })
  $('opt-main-window-only').addEventListener('change', (event) => {
    void window.sttDesktop.setFloatingCardDisabled(event.target.checked)
    setStatus(event.target.checked
      ? '已停用悬浮翻译卡:快捷键取词会直接在主窗口翻译'
      : '已恢复悬浮翻译卡')
  })
  $('opt-target-language').addEventListener('change', (event) => {
    state.targetLanguage = event.target.value
    void chrome.storage.sync.set({ desktop_target_language: state.targetLanguage })
    setStatus(state.targetLanguage === 'auto'
      ? '目标语言已设为自动(按原文语言判断)'
      : `目标语言已设为 ${event.target.options[event.target.selectedIndex]?.text || state.targetLanguage}`)
  })
  $('btn-hotkey').addEventListener('click', async () => {
    const value = $('cfg-hotkey').value.trim()
    if (!value) return
    const applied = await window.sttDesktop.setHotkey(value)
    if (applied) {
      state.hotkey = applied
      setStatus(`热键已设为 ${applied}`)
      renderDiagnostics()
    } else {
      setStatus('热键注册失败,可能与其他程序冲突,请换一个组合')
    }
  })
  $('btn-clear').addEventListener('click', () => {
    if (!state.entries.length) {
      setStatus('没有可清空的学习记录')
      return
    }
    const count = state.entries.length
    showSnackbar('确定清空全部 ' + count + ' 条学习记录？', '清空', () => {
      const removed = state.entries.slice()
      state.entries = []
      void window.sttDesktop.clearHistory()
      render()
      showSnackbar('已清空 ' + count + ' 条学习记录', '撤销', () => {
        state.entries = removed
        render()
        setStatus('已撤销清空')
      })
    })
  })
  $('snackbar-close').addEventListener('click', hideSnackbar)
  const input = $('input')
  input.addEventListener('input', updateComposer)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('help-overlay').hidden) {
        event.stopPropagation()
        hideHelp()
        return
      }
      if (isExportOpen()) {
        event.stopPropagation()
        closeExportMenu()
        return
      }
      if (isSidebarOpen()) {
        event.stopPropagation()
        closeSidebar()
        return
      }
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
  $('btn-paste-translate').addEventListener('click', () => void pasteAndTranslate())
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
  $('cfg-speech-rate').addEventListener('input', (event) => {
    const rate = Number(event.target.value)
    $('speech-rate-value').textContent = `${rate.toFixed(1)}×`
    void chrome.storage.sync.set({ speech_rate: rate })
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
    if (event.target.closest('button')) closeMoreMenu()
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
      menu.hidden = true
      more?.setAttribute('aria-expanded', 'false')
    })
  })

  $('btn-help').addEventListener('click', toggleHelp)
  $('btn-close-help').addEventListener('click', hideHelp)
  $('help-overlay').addEventListener('click', (event) => {
    if (event.target === $('help-overlay')) hideHelp()
  })
  $('help-overlay').addEventListener('keydown', (event) => {
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
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 'k' && $('help-overlay').hidden) {
      event.preventDefault()
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
        openActionMenu.hidden = true
        const more = openActionMenu.previousElementSibling
        if (more) more.setAttribute('aria-expanded', 'false')
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
    if (['base_url', 'api_key', 'model', 'learning_model'].some((key) => key in changes)) void checkConfig()
  })

  window.sttDesktop.onSelection((payload) => {
    state.capture = payload
    renderDiagnostics()
    const text = String(payload?.text || '').trim()
    void checkConfig()
    if (text) {
      stashDraft(text)
      $('input').value = text
      updateComposer()
      setStatus(`已取到 ${text.length} 字 · 来源:${payload.source || '剪贴板'}`)
      submit()
      showDraftNotice()
    } else {
      setStatus('没有取到选中文字,可以直接粘贴到这里翻译')
      if (state.draft) showDraftNotice()
      else void showCaptureHint(payload)
      $('input').focus()
    }
  })
  window.sttDesktop.onCardEntry((entry) => {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return
    if (state.entries.some((item) => item.requestId === entry.requestId)) return
    state.entries.push({
      id: String(entry.id || makeId('s')),
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
    persistHistory()
    render()
    setStatus('悬浮卡片的翻译已同步到学习记录')
  })
  window.sttDesktop.onStatus((info) => {
    if (info?.hotkey) state.hotkey = info.hotkey
    if (info?.message) setStatus(info.message)
    if (info?.hotkey) renderDiagnostics()
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
    const savedTarget = await chrome.storage.sync.get(['desktop_target_language'])
    state.targetLanguage = savedTarget?.desktop_target_language || 'auto'
    const targetSelect = $('opt-target-language')
    if (targetSelect) targetSelect.value = state.targetLanguage
  } catch {
    // default target language
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
    const savedPrefs = await chrome.storage.sync.get(['desktop_prefs'])
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
  try {
    state.hotkey = await window.sttDesktop.getHotkey()
  } catch {
    state.hotkey = ''
  }
  render()
  $('input').focus()
  if (!state.configured && !state.entries.length) openSettings()
}

void init()
