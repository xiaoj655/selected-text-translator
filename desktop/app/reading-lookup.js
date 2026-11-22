import { button, el } from './tutor.js'
import { localizeErrorMessage } from './messages.js'
import { renderGuide, renderTranslation, sentenceStructure } from './translation-result.js'
import { resultPlainText, resultText } from './result-text.js'
import { showCopyDone } from './ui-text.js'
import { readingSelection, readingStructureRanges, readingWordAt } from './reading-selection.js'

const MODE_KEY = 'desktop_reading_lookup_mode'
const ACTIVE = new Set(['pending', 'loading', 'streaming'])
const SELECTION_HIGHLIGHT = 'reading-lookup-selection'
const STRUCTURE_HIGHLIGHTS = {
  subject: 'reading-lookup-subject',
  verb: 'reading-lookup-verb',
  object: 'reading-lookup-object',
  complement: 'reading-lookup-complement',
}

export function createReadingLookup({ rootEl, onOpenSettings, onLookup }) {
  const popover = el('section', 'reading-lookup')
  popover.id = 'reading-lookup'
  popover.hidden = true
  popover.setAttribute('popover', 'manual')
  popover.setAttribute('aria-label', 'Look up selected text')
  const header = el('header', 'reading-lookup-header')
  const title = el('strong', 'reading-lookup-text')
  title.id = 'reading-lookup-text'
  title.lang = 'en'
  const dismiss = button('×', 'reading-lookup-close', close, 'reading-lookup-close')
  dismiss.setAttribute('aria-label', 'Close lookup')
  header.append(title, dismiss)
  const modes = el('div', 'reading-lookup-modes')
  const translate = button('Translate', 'reading-lookup-translate', () => void request('translate'))
  const guide = button('Guided Reading', 'reading-lookup-guide', () => void request('guide'))
  modes.append(translate, guide)
  const body = el('div', 'reading-lookup-body')
  const result = el('div', 'result')
  result.id = 'reading-lookup-result'
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
  document.body.append(popover)

  const articles = new WeakMap()
  let entry = null
  let counter = 0
  let lastMode = 'translate'
  let modeChosen = false
  let wordTimer = 0
  let speechId = null
  const id = () => `reading-${Date.now()}-${++counter}`
  void chrome.storage.sync.get(MODE_KEY).then((values) => {
    if (!modeChosen && values?.[MODE_KEY] === 'guide') lastMode = 'guide'
  }).catch(() => {})

  function clearWordTimer() {
    clearTimeout(wordTimer)
    wordTimer = 0
  }

  function cancel() {
    if (!entry?.requestId) return
    const requestId = entry.requestId
    entry.requestId = null
    if (ACTIVE.has(entry.status)) {
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

  function clearStructureHighlights() {
    for (const name of Object.values(STRUCTURE_HIGHLIGHTS)) CSS.highlights?.delete(name)
  }

  function renderHighlights() {
    if (!CSS.highlights || typeof Highlight !== 'function') return false
    clearStructureHighlights()
    const ranges = readingStructureRanges(entry, sentenceStructure(entry))
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
    if (selection?.rangeCount === 1) {
      const nativeRange = selection.getRangeAt(0)
      if (entry.range.compareBoundaryPoints(Range.START_TO_START, nativeRange) === 0
        && entry.range.compareBoundaryPoints(Range.END_TO_END, nativeRange) === 0) selection.removeAllRanges()
    }
    return true
  }

  function close() {
    clearWordTimer()
    cancel()
    stopSpeech()
    entry = null
    if (popover.matches(':popover-open')) popover.hidePopover()
    popover.hidden = true
    CSS.highlights?.delete(SELECTION_HIGHLIGHT)
    clearStructureHighlights()
  }

  function position() {
    if (!entry || popover.hidden) return
    const rect = entry.range.getBoundingClientRect()
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left))
    const below = rect.bottom + 9
    const top = below + height <= window.innerHeight - 12 ? below : rect.top - height - 9
    popover.style.left = `${Math.round(left)}px`
    popover.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - height - 12, top)))}px`
  }

  function render() {
    if (!entry) return
    const hasHighlights = renderHighlights()
    const scrollTop = body.scrollTop
    translate.setAttribute('aria-pressed', String(entry.mode === 'translate'))
    guide.setAttribute('aria-pressed', String(entry.mode === 'guide'))
    result.replaceChildren()
    result.className = 'result'
    result.setAttribute('aria-busy', String(ACTIVE.has(entry.status)))
    if (entry.status === 'idle') result.textContent = 'Choose how to explore this selection.'
    else if (entry.status === 'error' || entry.status === 'cancelled') {
      result.classList.add('is-error')
      result.textContent = entry.error
    } else if (entry.mode === 'guide' && entry.guide) {
      result.append(renderGuide(entry, {
        showSentenceLegend: hasHighlights,
        onRevealHint(current) { current.hintCount += 1; render() },
        onToggleAnswer(current) { current.answerRevealed = !current.answerRevealed; render() },
      }))
    } else if (entry.translatedText) result.append(renderTranslation(entry))
    else result.textContent = 'Waiting for the model…'
    const done = entry.status === 'done'
    copy.disabled = !done
    save.disabled = !done || Boolean(entry.saving) || (entry.mode === 'guide' && !entry.answerRevealed)
    stop.hidden = !ACTIVE.has(entry.status)
    retry.hidden = !['error', 'cancelled'].includes(entry.status)
    settings.hidden = entry.status !== 'error'
    body.scrollTop = scrollTop
    position()
  }

  function open(selection, autoRequest) {
    close()
    entry = { ...selection, id: id(), createdAt: Date.now(), requestId: null, mode: null, status: 'idle', hintCount: 1, answerRevealed: false }
    title.textContent = selection.text
    title.title = selection.text
    feedback.textContent = ''
    save.textContent = 'Save'
    copy.textContent = 'Copy result'
    copy.classList.remove('is-done')
    popover.hidden = false
    popover.showPopover()
    render()
    if (autoRequest) void request(lastMode)
  }

  async function request(mode, forceRefresh = false) {
    if (!entry || !['translate', 'guide'].includes(mode)) return
    if (!forceRefresh && entry.mode === mode && (ACTIVE.has(entry.status) || entry.status === 'done')) return
    cancel()
    const current = entry
    const requestId = id()
    Object.assign(current, { requestId, mode, status: 'pending', translatedText: '', lexical: null, guide: null,
      hintCount: 1, answerRevealed: false, error: '' })
    modeChosen = true
    lastMode = mode
    void chrome.storage.sync.set({ [MODE_KEY]: mode }).catch(() => {})
    feedback.textContent = ''
    save.textContent = 'Save'
    render()
    try {
      const values = await chrome.storage.sync.get(['desktop_target_language', 'desktop_glossary'])
      if (entry !== current || current.requestId !== requestId) return
      const response = await chrome.runtime.sendMessage({
        type: 'START_TRANSLATION',
        payload: {
          selectionId: current.id, requestId, requestScope: 'reading', kind: mode, forceRefresh,
          text: current.text, context: current.context, contextStart: current.contextStart, contextEnd: current.contextEnd,
          sourceLanguage: 'english', targetLanguage: values.desktop_target_language || 'auto', glossary: values.desktop_glossary || [],
        },
      })
      if (entry === current && current.requestId === requestId && !response?.accepted) {
        current.status = 'error'
        current.error = 'Could not start the request. Try again.'
        render()
      }
    } catch {
      if (entry !== current || current.requestId !== requestId) return
      current.status = 'error'
      current.error = 'Could not reach the translation service. Try again.'
      render()
    }
  }

  function stopRequest() {
    cancel()
    if (!entry) return
    entry.status = 'cancelled'
    entry.error = 'Request stopped. Retry when you’re ready.'
    render()
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
    render()
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
      if (entry === current) render()
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
    if (message?.type !== 'TRANSLATION_EVENT' || !entry?.requestId || payload?.requestId !== entry.requestId) return
    switch (payload.status) {
      case 'started': entry.status = 'loading'; break
      case 'stream': entry.status = 'streaming'; entry.translatedText = String(payload.translatedText || ''); break
      case 'success':
        entry.translatedText = String(payload.translatedText || entry.translatedText || '').trim()
        entry.lexical = payload.lexicalDetails || null
        entry.guide = payload.result || null
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
    render()
  })

  rootEl.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return
    clearWordTimer()
    const material = event.target.closest?.('.reading-preview[data-reading-selectable]')
    if (!material) return
    const selection = readingSelection(rootEl)
    if (selection?.material === material) open(selection, false)
  })
  rootEl.addEventListener('click', (event) => {
    if (event.detail !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || readingSelection(rootEl)) return
    clearWordTimer()
    const word = readingWordAt(rootEl, event.clientX, event.clientY)
    if (word) wordTimer = setTimeout(() => {
      wordTimer = 0
      if (word.material.isConnected && !word.material.closest('[hidden]')) open(word, true)
    }, 280)
  })
  rootEl.addEventListener('keyup', (event) => {
    if (event.key !== 'Shift' && !event.key.startsWith('Arrow')) return
    if (event.target.closest?.('input, textarea, button, a, summary')) return
    const selection = readingSelection(rootEl)
    if (selection) open(selection, false)
  })
  document.addEventListener('pointerdown', (event) => {
    clearWordTimer()
    if (!popover.hidden && !popover.contains(event.target)) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || (popover.hidden && !wordTimer)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
  }, true)
  document.addEventListener('scroll', (event) => {
    if (!popover.contains(event.target)) close()
  }, true)
  window.addEventListener('resize', position)
  new ResizeObserver(position).observe(popover)
  document.addEventListener('visibilitychange', () => { if (document.hidden) close() })

  return {
    bindMaterial(material, article) {
      material.dataset.readingSelectable = 'true'
      articles.set(material, article)
    },
    close,
  }
}
