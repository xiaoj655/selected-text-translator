import { button, el } from './tutor.js'
import { localizeErrorMessage } from './messages.js'
import { renderGuide, renderGuidePreview, renderTranslation, sentenceStructure } from './translation-result.js'
import { resultPlainText, resultText } from './result-text.js'
import { showCopyDone } from './ui-text.js'
import { classifyReadingSelection } from '../vendor/src/reading-support.js'
import { installReadingSelection, readingSentenceStructureRanges } from './reading-selection.js'
import { createReadingLookupLayout } from './reading-lookup-layout.js'
import { readingAnalysisEntry, renderReadingSentence } from './reading-sentence.js'

const MODE_KEY = 'desktop_reading_lookup_mode'
const ACTIVE = new Set(['pending', 'loading', 'streaming'])
const SELECTION_HIGHLIGHT = 'reading-lookup-selection'
const STRUCTURE_HIGHLIGHTS = {
  subject: 'reading-lookup-subject',
  verb: 'reading-lookup-verb',
  object: 'reading-lookup-object',
  complement: 'reading-lookup-complement',
}

function sameRange(a, b) {
  return a && b && a.compareBoundaryPoints(Range.START_TO_START, b) === 0
    && a.compareBoundaryPoints(Range.END_TO_END, b) === 0
}

function sameSentenceScope(a, b) {
  return a.text && a.text === b.text
    && a.sentences[0].start === b.sentences[0].start
    && a.sentences.at(-1).end === b.sentences.at(-1).end
}

export function createReadingLookup({ rootEl, scroller, dock, onOpenSettings, onLookup }) {
  const popover = el('section', 'reading-lookup')
  popover.id = 'reading-lookup'
  popover.hidden = true
  popover.setAttribute('aria-label', 'Look up selected text')
  const header = el('header', 'reading-lookup-header')
  const title = el('strong', 'reading-lookup-text')
  title.id = 'reading-lookup-text'
  title.lang = 'en'
  const dismiss = button('×', 'reading-lookup-close', () => close(), 'reading-lookup-close')
  dismiss.setAttribute('aria-label', 'Close lookup')
  const expand = button('Expand', 'reading-lookup-expand', () => layout.expand())
  const collapse = button('Minimize', 'reading-lookup-minimize', () => layout.collapse())
  const jump = button('Back to source', 'reading-lookup-original', () => {
    const bounds = scroller.getBoundingClientRect()
    const rect = entry?.range.getClientRects()[0]
    if (rect) scroller.scrollTop += rect.top - bounds.top - 18
  })
  const headerActions = el('div', 'reading-lookup-header-actions')
  headerActions.append(jump, expand, collapse, dismiss)
  header.append(title, headerActions)
  const modes = el('div', 'reading-lookup-modes')
  const translate = button('Translate', 'reading-lookup-translate', () => selectMode('translate'))
  const guide = button('Guided Reading', 'reading-lookup-guide', () => selectMode('guide'))
  modes.append(translate, guide)
  const body = el('div', 'reading-lookup-body')
  const result = el('div', 'result')
  result.id = 'reading-lookup-result'
  const meaning = el('div', 'result')
  const structure = el('div')
  result.append(meaning, structure)
  const feedback = el('p', 'reading-lookup-feedback')
  feedback.setAttribute('role', 'status')
  body.append(result, feedback)
  const actions = el('footer', 'reading-lookup-actions')
  const copy = button('Copy result', 'reading-lookup-copy', () => void copyResult())
  const speak = button('Read aloud', 'reading-lookup-speak', () => void toggleSpeech())
  const save = button('Save', 'reading-lookup-save', () => void saveResult())
  const stop = button('Stop', 'reading-lookup-stop', stopRequest)
  const retry = button('Retry', 'reading-lookup-retry', () => void request(entry?.mode || lastMode, true))
  const settings = button('Open settings', 'reading-lookup-settings', () => { close(); onOpenSettings?.() })
  actions.append(copy, speak, save, stop, retry, settings)
  popover.append(header, modes, body, actions)
  dock.append(popover)
  const layout = createReadingLookupLayout({ panel: popover, scroller, dock })

  const articles = new WeakMap()
  let entry = null
  let counter = 0
  let lastMode
  let speechId = null
  const id = () => `reading-${Date.now()}-${++counter}`
  const modeReady = chrome.storage.sync.get(MODE_KEY).then(
    (values) => { lastMode ??= values?.[MODE_KEY] === 'guide' ? 'guide' : 'translate' },
    () => { lastMode ??= 'translate' },
  )

  const selection = installReadingSelection(rootEl, open, scroller)

  function cancel() {
    if (!entry?.requestId) return
    const requestId = entry.requestId
    entry.requestId = null
    if (ACTIVE.has(entry.status) || (entry.mode === 'translate' && entry.status === 'done')) {
      void chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', payload: { requestId, requestScope: 'reading' } }).catch(() => {})
    }
  }

  function stopSpeech() {
    if (!speechId) return
    const previous = speechId
    speechId = null
    speak.textContent = 'Read aloud'
    void chrome.runtime.sendMessage({ type: 'STOP_SPEECH', payload: { speechId: previous } }).catch(() => {})
  }

  function cancelAnalysis() {
    const analysis = entry?.analysis
    if (!analysis?.requestId) return
    const requestId = analysis.requestId
    analysis.requestId = null
    void chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', payload: {
      requestId, requestScope: 'reading', kind: 'structure',
    } }).catch(() => {})
  }

  function clearStructureHighlights() {
    for (const name of Object.values(STRUCTURE_HIGHLIGHTS)) CSS.highlights?.delete(name)
  }

  function renderHighlights() {
    if (!CSS.highlights || typeof Highlight !== 'function') return false
    clearStructureHighlights()
    const spans = entry.analysis.expanded ? sentenceStructure(readingAnalysisEntry(entry)) : []
    const ranges = readingSentenceStructureRanges(entry, spans)
    if (!ranges.length) {
      CSS.highlights.set(SELECTION_HIGHLIGHT, new Highlight(entry.range))
      return false
    }

    CSS.highlights.delete(SELECTION_HIGHLIGHT)
    for (const { role, range } of ranges) {
      const name = STRUCTURE_HIGHLIGHTS[role]
      if (!CSS.highlights.has(name)) CSS.highlights.set(name, new Highlight())
      CSS.highlights.get(name).add(range)
    }
    // The native selection paints over the role colors. Clear it only if it is
    // still the selection that opened this lookup.
    const selection = window.getSelection()
    if (selection?.rangeCount === 1 && sameRange(entry.range, selection.getRangeAt(0))) selection.removeAllRanges()
    return true
  }

  function close({ preserveAnalysis = false } = {}) {
    selection.clearPending()
    cancel()
    if (!preserveAnalysis) cancelAnalysis()
    stopSpeech()
    entry = null
    layout.close()
    CSS.highlights?.delete(SELECTION_HIGHLIGHT)
    clearStructureHighlights()
  }

  function renderMeaning() {
    const scrollTop = body.scrollTop
    const structurePanel = scrollTop > 0 ? structure.firstElementChild : null
    const structureTop = structurePanel?.getBoundingClientRect().top
    const viewingStructure = structurePanel && structureTop <= body.getBoundingClientRect().top
    translate.setAttribute('aria-pressed', String(entry.mode === 'translate'))
    guide.setAttribute('aria-pressed', String(entry.mode === 'guide'))
    meaning.replaceChildren()
    meaning.classList.toggle('is-error', ['error', 'cancelled'].includes(entry.status))
    meaning.setAttribute('aria-busy', String(ACTIVE.has(entry.status)))
    if (entry.status === 'error' || entry.status === 'cancelled') {
      meaning.textContent = entry.error
    } else if (entry.mode === 'guide' && entry.guide) {
      meaning.append(renderGuide(entry, {
        onRevealHint(current) { current.hintCount += 1; renderMeaning() },
        onToggleAnswer(current) { current.answerRevealed = !current.answerRevealed; renderMeaning() },
      }))
    } else if (entry.mode === 'guide' && entry.previewHint) {
      meaning.append(renderGuidePreview(entry.previewHint))
    } else if (entry.translatedText) {
      meaning.append(renderTranslation(entry))
    } else {
      meaning.textContent = 'Waiting for the model…'
    }
    renderActions()
    if (viewingStructure) {
      body.scrollTop += structurePanel.getBoundingClientRect().top - structureTop
    } else {
      body.scrollTop = scrollTop
    }
    layout.position()
  }

  function renderActions() {
    const done = entry.status === 'done'
    copy.disabled = !done
    save.disabled = !done || Boolean(entry.saving) || (entry.mode === 'guide' && !entry.answerRevealed)
    stop.hidden = !entry.requestId || !ACTIVE.has(entry.status)
    retry.hidden = !['error', 'cancelled'].includes(entry.status)
    settings.hidden = entry.status !== 'error'
    popover.classList.toggle('is-detailed', entry.mode === 'guide' || entry.status === 'error' || entry.status === 'cancelled')
  }

  function renderAnalysis() {
    const scrollTop = body.scrollTop
    renderHighlights()
    if (!entry.singleWord || entry.status === 'done' || structure.firstElementChild) {
      structure.replaceChildren(renderReadingSentence(entry, {
        onToggle(expanded) {
          entry.analysis.expanded = expanded
          if (expanded && entry.analysis.status === 'idle') void requestAnalysis()
          else renderAnalysis()
        },
        onRetry() { void requestAnalysis(true) },
      }))
    }
    body.scrollTop = scrollTop
    layout.position()
  }

  function open(selected) {
    const sameMaterial = entry?.material === selected.material
    if (sameMaterial && entry.start === selected.start && entry.end === selected.end && entry.text === selected.text) {
      layout.reopen()
      return
    }
    const singleWord = classifyReadingSelection(selected.text) === 'word'
    const preserveAnalysis = !singleWord && sameMaterial && entry.analysis.status === 'loading'
      && sameSentenceScope(entry.sentenceScope, selected.sentenceScope)
    const analysis = preserveAnalysis ? entry.analysis
      : { status: 'idle', detailExpanded: false, requestId: null, result: null, error: '' }
    analysis.expanded = !singleWord
    close({ preserveAnalysis })
    const current = { ...selected, id: id(), createdAt: Date.now(), requestId: null, mode: null, status: 'pending', singleWord, analysis }
    entry = current
    title.textContent = selected.text
    title.title = selected.text
    feedback.textContent = ''
    save.textContent = 'Save'
    copy.textContent = 'Copy result'
    copy.classList.remove('is-done')
    structure.replaceChildren()
    body.scrollTop = 0
    layout.open(current)
    if (lastMode) void request(lastMode)
    else {
      renderMeaning()
      void modeReady.then(() => {
        if (entry === current && !current.mode) void request(lastMode)
      })
    }
    if (singleWord || preserveAnalysis) renderAnalysis()
    else void requestAnalysis()
  }

  function selectMode(mode) {
    if (!entry) return
    if (lastMode !== mode) {
      lastMode = mode
      void chrome.storage.sync.set({ [MODE_KEY]: mode }).catch(() => {})
    }
    void request(mode)
  }

  async function request(mode, forceRefresh = false) {
    if (!entry || !['translate', 'guide'].includes(mode)) return
    if (!forceRefresh && entry.mode === mode && (ACTIVE.has(entry.status) || entry.status === 'done')) return
    cancel()
    const current = entry
    const requestId = id()
    Object.assign(current, { requestId, mode, status: 'pending', translatedText: '', lexical: null, guide: null, structure: null,
      sentenceAnalysis: null, analysisExpanded: false, previewHint: '',
      hintCount: 1, answerRevealed: false, error: '' })
    if (mode === 'guide') layout.expand()
    feedback.textContent = ''
    save.textContent = 'Save'
    renderMeaning()
    try {
      const values = await chrome.storage.sync.get(['desktop_target_language', 'desktop_glossary'])
      if (entry !== current || current.requestId !== requestId) return
      const response = await chrome.runtime.sendMessage({
        type: 'START_TRANSLATION',
        payload: {
          selectionId: current.id, requestId, requestScope: 'reading', kind: mode, forceRefresh,
          includeSentenceStructure: false,
          text: current.text, context: current.context, contextStart: current.contextStart, contextEnd: current.contextEnd,
          sourceLanguage: 'english', targetLanguage: values.desktop_target_language || 'auto', glossary: values.desktop_glossary || [],
        },
      })
      if (entry === current && current.requestId === requestId && !response?.accepted) {
        current.status = 'error'
        current.error = 'Could not start the request. Try again.'
        renderMeaning()
      }
    } catch {
      if (entry !== current || current.requestId !== requestId) return
      current.status = 'error'
      current.error = 'Could not reach the translation service. Try again.'
      renderMeaning()
    }
  }

  async function requestAnalysis(forceRefresh = false) {
    const current = entry
    if (!current?.sentenceScope.text || (!forceRefresh && current.analysis.status !== 'idle')) {
      if (current) renderAnalysis()
      return
    }
    cancelAnalysis()
    const analysis = current.analysis
    const requestId = id()
    Object.assign(analysis, { status: 'loading', requestId, error: '', result: null })
    renderAnalysis()
    try {
      const response = await chrome.runtime.sendMessage({ type: 'START_TRANSLATION', payload: {
        selectionId: current.id, requestId, requestScope: 'reading', kind: 'structure', forceRefresh,
        text: current.sentenceScope.text, sourceLanguage: 'english',
      } })
      if (entry?.analysis === analysis && analysis.requestId === requestId && !response?.accepted) {
        analysis.status = 'error'
        analysis.requestId = null
        analysis.error = 'Could not start sentence analysis. Try again.'
        renderAnalysis()
      }
    } catch {
      if (entry?.analysis !== analysis || analysis.requestId !== requestId) return
      analysis.status = 'error'
      analysis.requestId = null
      analysis.error = 'Could not reach the sentence analysis service. Try again.'
      renderAnalysis()
    }
  }

  function stopRequest() {
    cancel()
    if (!entry) return
    entry.status = 'cancelled'
    entry.error = 'Request stopped. Retry when you’re ready.'
    renderMeaning()
  }

  async function copyResult() {
    const current = entry
    if (current?.status !== 'done') return
    try {
      await window.sttDesktop.copyText(resultPlainText(current))
      if (entry === current) showCopyDone(copy)
    } catch {
      if (entry === current) feedback.textContent = 'Could not copy the result. Try again.'
    }
  }

  async function saveResult() {
    const current = entry
    if (!current || current.status !== 'done' || current.saving) return
    current.saving = true
    renderActions()
    try {
      const answer = current.guide?.answer || {}
      const response = await chrome.runtime.sendMessage({ type: 'VOCABULARY_SAVE', payload: {
        text: current.text, meaning: resultText(current), context: current.context,
        contextStart: current.contextStart, contextEnd: current.contextEnd,
        phonetic: current.lexical?.phonetic || current.guide?.phonetic || '',
        explanation: answer.explanation || current.lexical?.contextual_analysis || '',
        example: answer.example || '', usage: answer.usage || '', sourceUrl: articles.get(current.material)?.url || '',
      } })
      if (entry === current) {
        save.textContent = response?.ok ? '✓ Saved' : 'Save'
        feedback.textContent = response?.ok ? 'Saved to vocabulary.' : response?.message || 'Could not save. Try again.'
      }
    } catch {
      if (entry === current) feedback.textContent = 'Could not save. Try again.'
    } finally {
      current.saving = false
      if (entry === current) renderActions()
    }
  }

  async function toggleSpeech() {
    if (speechId) { stopSpeech(); return }
    if (!entry) return
    const current = entry
    const nextId = id()
    speechId = nextId
    speak.textContent = 'Stop reading'
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { speechId: nextId, text: current.text } })
      if (speechId === nextId && !response?.ok) {
        speechId = null
        speak.textContent = 'Read aloud'
        if (entry === current) feedback.textContent = response?.message || 'Speech unavailable.'
      }
    } catch {
      if (speechId === nextId) {
        speechId = null
        speak.textContent = 'Read aloud'
        if (entry === current) feedback.textContent = 'Speech unavailable.'
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    const payload = message?.payload
    if (message?.type === 'SPEECH_EVENT' && speechId && payload?.speechId === speechId) {
      if (['end', 'error', 'interrupted', 'cancelled'].includes(payload.status)) {
        speechId = null
        speak.textContent = 'Read aloud'
      }
      if (payload.status === 'error') feedback.textContent = 'Speech unavailable. Check speech settings and system voices.'
      if (payload.status === 'fallback') feedback.textContent = payload.message
      return
    }
    if (message?.type !== 'TRANSLATION_EVENT' || !entry) return
    if (entry.analysis.requestId && payload?.requestId === entry.analysis.requestId) {
      const analysis = entry.analysis
      if (payload.status === 'success') {
        analysis.result = payload.result
        analysis.status = 'done'
        analysis.requestId = null
      } else if (['error', 'missing-configuration'].includes(payload.status)) {
        analysis.status = 'error'
        analysis.error = localizeErrorMessage(payload)
        analysis.requestId = null
      } else return
      renderAnalysis()
      return
    }
    if (!entry.requestId || payload?.requestId !== entry.requestId) return
    switch (payload.status) {
      case 'started': entry.status = 'loading'; break
      case 'stream':
        entry.status = 'streaming'
        if (entry.mode === 'guide') entry.previewHint = String(payload.previewHint || '')
        else entry.translatedText = String(payload.translatedText || '')
        break
      case 'success':
        entry.translatedText = String(payload.translatedText || entry.translatedText || '').trim()
        entry.lexical = payload.lexicalDetails || null
        entry.guide = payload.result || null
        entry.structure = payload.structure || null
        entry.sentenceAnalysis = payload.sentenceAnalysis || null
        entry.status = (entry.mode === 'guide' ? entry.guide : entry.translatedText) ? 'done' : 'error'
        entry.error = entry.mode === 'guide' ? 'No guidance was generated. Try again.' : 'No translation was generated. Try again.'
        if (entry.status === 'done' && /\s/u.test(entry.text)) {
          void Promise.resolve(onLookup?.({ id: entry.id, text: entry.text, sourceLanguage: 'english',
            guideType: entry.guide?.guideType, createdAt: entry.createdAt })).catch(() => {})
        }
        break
      case 'error':
      case 'missing-configuration': entry.status = 'error'; entry.error = localizeErrorMessage(payload); break
      default: return
    }
    renderMeaning()
    if (entry.singleWord && entry.status === 'done' && !structure.firstElementChild) renderAnalysis()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || (!entry && !selection.hasPending())) return
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
  }, true)
  scroller.addEventListener('scroll', selection.clearPending)

  return {
    bindMaterial(material, article) {
      material.dataset.readingSelectable = 'true'
      articles.set(material, article)
    },
    close,
  }
}
