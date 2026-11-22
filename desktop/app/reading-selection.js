import { getSentenceSegments } from '../vendor/src/context-sentence.js'

const indexes = new WeakMap()
const MAX_CONTEXT_LENGTH = 2400
const MAX_STRUCTURE_LENGTH = 12000
const INTERACTIVE_CONTENT = 'a, button, input, textarea, select, summary, video, audio, iframe'
const SENTENCE_BLOCK = 'p, h1, h2, h3, h4, h5, h6, pre, li, dt, dd, blockquote, td, th, figcaption'

function sentenceSpans(text) {
  return getSentenceSegments(text).flatMap(({ index, segment }) => {
    const sentence = segment.trim()
    if (!sentence) return []
    const start = index + segment.length - segment.trimStart().length
    return [{ start, end: start + sentence.length }]
  })
}

// Keep structural paragraph boundaries even when an HTML author did not put
// whitespace between adjacent blocks. Offsets still refer to exact DOM text.
function materialSentenceSpans(material, text) {
  const boundaries = [0]
  const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
  let previousBlock
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement?.closest(SENTENCE_BLOCK)
    if (offset && block !== previousBlock) boundaries.push(offset)
    previousBlock = block
    offset += node.length
  }
  boundaries.push(text.length)
  return boundaries.flatMap((start, index) => {
    const end = boundaries[index + 1]
    if (end === undefined || end <= start) return []
    return sentenceSpans(text.slice(start, end)).map((sentence) => ({
      start: sentence.start + start, end: sentence.end + start,
    }))
  })
}

// Analysis deliberately covers exactly the touched sentences. Its separate
// text has explicit separators, with a mapping back to each original sentence.
export function readingSentenceScope(text, start, end, sentences = sentenceSpans(text)) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
    return { text: '', sentences: [], unavailable: 'No sentence is available for this selection.' }
  }
  const covered = sentences.filter((sentence) => sentence.end > start && sentence.start < end)
  if (!covered.length) return { text: '', sentences: [], unavailable: 'No sentence is available for this selection.' }
  let source = ''
  const mapped = covered.map((sentence) => {
    if (source) source += '\n\n'
    const analysisStart = source.length
    source += text.slice(sentence.start, sentence.end)
    return { ...sentence, analysisStart, analysisEnd: source.length }
  })
  if (source.length > MAX_STRUCTURE_LENGTH) {
    return { text: '', sentences: [], unavailable: 'These sentences are too long to analyze together. Select a shorter passage.' }
  }
  return { text: source, sentences: mapped, unavailable: '' }
}

// Keep whole sentences around the selection. The length limit is only a
// fallback for unusually long sentences, matching the shared request contract.
export function readingSentenceContext(text, start, end, sentences = sentenceSpans(text)) {
  const empty = { context: '', contextStart: null, contextEnd: null }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return empty
  const first = sentences.findIndex((sentence) => sentence.end > start)
  if (first < 0 || sentences[first].start >= end) return empty
  let last = first
  while (last + 1 < sentences.length && sentences[last + 1].start < end) last += 1
  const before = Math.max(0, first - 1)
  const after = Math.min(sentences.length - 1, last + 1)
  // Prefer both neighbours, then a complete neighbour, then the selected
  // sentence(s) alone. Never cut a sentence to fill a character window.
  for (const [from, to] of [[before, after], [before, last], [first, after], [first, last]]) {
    const contextStart = sentences[from].start
    const contextEnd = sentences[to].end
    if (contextStart > start || contextEnd < end || contextEnd - contextStart > MAX_CONTEXT_LENGTH) continue
    return { context: text.slice(contextStart, contextEnd), contextStart: start - contextStart, contextEnd: end - contextStart }
  }
  return empty
}

function textIndex(material) {
  const text = material.textContent
  const previous = indexes.get(material)
  if (previous?.text === text) return previous
  const index = {
    text,
    words: Array.from(text.matchAll(/\p{L}[\p{L}\p{M}\p{N}]*(?:['’\-‐‑][\p{L}\p{M}\p{N}]+)*/gu), ({ 0: word, index: start }) =>
      ({ start, end: start + word.length })),
    sentences: materialSentenceSpans(material, text),
  }
  indexes.set(material, index)
  return index
}

// Keep the original text and UTF-16 offsets used by the shared translation API.
function materialFor(node, root) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  const material = element?.closest('.reading-preview[data-reading-selectable]')
  return material && root.contains(material) ? material : null
}

function isInteractiveContent(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  return Boolean(element?.closest(INTERACTIVE_CONTENT))
}

export function readingSelection(root) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const material = materialFor(range.startContainer, root)
  if (!material || material !== materialFor(range.endContainer, root)) return null
  return selectionFromRange(material, range)
}

export function readingWordAt(root, x, y) {
  const hit = wordAtPoint(root, x, y)
  return hit && selectionFromRange(hit.material, hit.range)
}

function offsetBefore(material, range) {
  if (range.startContainer === material.firstChild && range.startContainer.nodeType === Node.TEXT_NODE) return range.startOffset
  const before = range.cloneRange()
  before.selectNodeContents(material)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

function offsetBoundaries(material) {
  const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let nodeStart = 0
  return (offset) => {
    while (node && offset > nodeStart + node.length) {
      nodeStart += node.length
      node = walker.nextNode()
    }
    return node ? [node, offset - nodeStart] : null
  }
}

export function rangeForOffsets(material, start, end = start) {
  const boundaryAt = offsetBoundaries(material)
  const from = boundaryAt(start)
  const to = boundaryAt(end)
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(...from)
  range.setEnd(...to)
  return range
}

// The binary search also gives the closest words on either side of whitespace.
function firstEndingAtOrAfter(spans, offset) {
  let from = 0
  let to = spans.length
  while (from < to) {
    const middle = Math.floor((from + to) / 2)
    if (spans[middle].end < offset) from = middle + 1
    else to = middle
  }
  return from
}

function wordAtPoint(root, x, y, dragStart = null) {
  const caret = document.caretRangeFromPoint(x, y)
  const material = caret && materialFor(caret.startContainer, root)
  if (!material || (dragStart && material !== dragStart.material)) return null
  if (!dragStart && isInteractiveContent(caret.startContainer)) return null
  const offset = offsetBefore(material, caret)
  const { words } = textIndex(material)
  const index = firstEndingAtOrAfter(words, offset)
  if (dragStart) {
    // Crossing punctuation or spaces as part of a drag still resolves to a whole word.
    const next = words[index]
    const previous = words[index - 1]
    return offset < dragStart.start && next?.start > offset ? previous || next : next || previous
  }
  const word = words[index]
  if (!word || word.start > offset) return null
  const range = rangeForOffsets(material, word.start, word.end)
  // A caret in whitespace can resolve to the end of the preceding word.
  const rect = [...range.getClientRects()].find((rect) => x >= rect.left - 1 && x <= rect.right + 1
    && y >= rect.top && y <= rect.bottom)
  return rect ? { material, ...word, range, rect } : null
}

function sentenceAt(material, offset) {
  const { sentences } = textIndex(material)
  return sentences[firstEndingAtOrAfter(sentences, offset)]
}

export function readingStructureRanges({ material, range, text }, spans) {
  if (!spans.length || !material.isConnected || !material.contains(range.startContainer)
    || !material.contains(range.endContainer)) return []
  const raw = range.toString()
  if (raw.trim() !== text) return []
  const base = offsetBefore(material, range) + raw.length - raw.trimStart().length
  const boundaryAt = offsetBoundaries(material)

  const ranges = []
  for (const { role, start, end } of spans) {
    const from = boundaryAt(base + start)
    const to = boundaryAt(base + end)
    if (!from || !to) return []
    const part = document.createRange()
    part.setStart(...from)
    part.setEnd(...to)
    if (part.toString() !== text.slice(start, end)) return []
    ranges.push({ role, range: part })
  }
  return ranges
}

export function readingSentenceStructureRanges({ material, sentenceScope }, spans) {
  if (!material?.isConnected || !sentenceScope?.text || !spans.length) return []
  const ranges = []
  for (const span of spans) {
    const sentence = sentenceScope.sentences.find(({ analysisStart, analysisEnd }) =>
      analysisStart <= span.start && analysisEnd >= span.end)
    if (!sentence) return []
    const start = sentence.start + span.start - sentence.analysisStart
    const end = sentence.start + span.end - sentence.analysisStart
    const range = rangeForOffsets(material, start, end)
    if (!range || range.toString() !== sentenceScope.text.slice(span.start, span.end)) return []
    ranges.push({ role: span.role, range })
  }
  return ranges
}

function selectionFromRange(material, originalRange) {
  const raw = originalRange.toString()
  const text = raw.trim()
  if (!text || text.length > 12000) return null
  const start = offsetBefore(material, originalRange) + raw.length - raw.trimStart().length
  const end = start + text.length
  const fullText = material.textContent
  if (fullText.slice(start, end) !== text) return null
  const range = originalRange.cloneRange()
  const { sentences } = textIndex(material)
  const sentenceScope = readingSentenceScope(fullText, start, end, sentences)
  const lastSentence = sentences.findLast((sentence) => sentence.end > start && sentence.start < end)
  return {
    material, range, text, start, end, sentenceScope, sentenceEnd: Math.max(end, lastSentence?.end || 0),
    ...readingSentenceContext(fullText, start, end, sentences),
  }
}

function sameRange(a, b) {
  return a && b && a.compareBoundaryPoints(Range.START_TO_START, b) === 0
    && a.compareBoundaryPoints(Range.END_TO_END, b) === 0
}

function hasModifier(event) {
  return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
}

export function installReadingSelection(root, onSelect, scroller) {
  const sentenceTrigger = document.createElement('button')
  sentenceTrigger.type = 'button'
  sentenceTrigger.className = 'reading-sentence-trigger'
  sentenceTrigger.setAttribute('aria-label', 'Look up sentence')
  sentenceTrigger.title = 'Look up sentence'
  sentenceTrigger.textContent = '↳'
  sentenceTrigger.hidden = true
  root.append(sentenceTrigger)

  let wordTimer = 0
  let sentenceTimer = 0
  let hideTimer = 0
  let hoveredSentence = null
  let selectionBeforePointer = null
  let selectionBeforeShift
  let drag = null
  let ignoreClick = false

  function clearWord() {
    clearTimeout(wordTimer)
    wordTimer = 0
  }

  function hideSentence() {
    clearTimeout(sentenceTimer)
    clearTimeout(hideTimer)
    sentenceTimer = 0
    hideTimer = 0
    hoveredSentence = null
    sentenceTrigger.hidden = true
  }

  function clearPending() {
    clearWord()
    hideSentence()
    selectionBeforeShift = undefined
    drag = null
  }

  function scheduleHideSentence() {
    clearTimeout(sentenceTimer)
    sentenceTimer = 0
    if (hoveredSentence && !hideTimer) hideTimer = setTimeout(hideSentence, 320)
  }

  function showSentence(word, sentence) {
    if (!word.material.isConnected || word.material.closest('[hidden]')) return
    const bounds = scroller.getBoundingClientRect()
    const anchor = [...word.range.getClientRects()].find((rect) => rect.top === word.rect.top) || word.rect
    if (anchor.top < bounds.top || anchor.bottom > bounds.bottom) return
    hoveredSentence = { material: word.material, ...sentence }
    sentenceTrigger.hidden = false
    const left = Math.min(word.material.getBoundingClientRect().right + 1, bounds.right - sentenceTrigger.offsetWidth - 2)
    const top = Math.max(bounds.top, Math.min((anchor.top + anchor.bottom - sentenceTrigger.offsetHeight) / 2,
      bounds.bottom - sentenceTrigger.offsetHeight))
    sentenceTrigger.style.left = `${Math.round(left)}px`
    sentenceTrigger.style.top = `${Math.round(top)}px`
  }

  function hover(event) {
    if (isInteractiveContent(event.target)) {
      scheduleHideSentence()
      return
    }
    const word = wordAtPoint(root, event.clientX, event.clientY)
    const sentence = word && sentenceAt(word.material, word.start)
    if (!sentence || sentence.end - sentence.start > 12000) {
      scheduleHideSentence()
      return
    }
    clearTimeout(hideTimer)
    hideTimer = 0
    clearTimeout(sentenceTimer)
    sentenceTimer = 0
    if (hoveredSentence?.material === word.material && hoveredSentence.start === sentence.start) return
    sentenceTimer = setTimeout(() => {
      sentenceTimer = 0
      showSentence(word, sentence)
    }, 150)
  }

  sentenceTrigger.addEventListener('pointerenter', () => {
    clearTimeout(hideTimer)
    clearTimeout(sentenceTimer)
    hideTimer = 0
    sentenceTimer = 0
  })
  sentenceTrigger.addEventListener('pointerleave', scheduleHideSentence)
  sentenceTrigger.addEventListener('click', () => {
    const target = hoveredSentence
    hideSentence()
    if (!target?.material.isConnected) return
    const range = rangeForOffsets(target.material, target.start, target.end)
    const selection = range && selectionFromRange(target.material, range)
    if (selection) {
      window.getSelection()?.removeAllRanges()
      onSelect(selection)
    }
  })

  document.addEventListener('pointerdown', (event) => {
    clearWord()
    drag = null
    ignoreClick = false
    selectionBeforePointer = null
    if (sentenceTrigger.contains(event.target)) return
    hideSentence()
    if (event.button === 0 && root.contains(event.target)) selectionBeforePointer = readingSelection(root)?.range || null
  }, true)

  root.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.detail !== 1 || hasModifier(event) || isInteractiveContent(event.target)
      || !materialFor(event.target, root)) return
    const word = wordAtPoint(root, event.clientX, event.clientY)
    if (!word) return
    drag = { ...word, x: event.clientX, y: event.clientY, active: false }
    // Prevent partial words during a plain drag. Modified and repeated clicks remain native.
    event.preventDefault()
  })

  function moveDrag(event) {
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return
    drag.active = true
    const target = wordAtPoint(root, event.clientX, event.clientY, drag)
    if (!target || !drag.material.isConnected) return
    const start = Math.min(drag.start, target.start)
    const end = Math.max(drag.end, target.end)
    if (drag.selection?.start === start && drag.selection.end === end) return
    const range = rangeForOffsets(drag.material, start, end)
    if (!range) return
    drag.selection = selectionFromRange(drag.material, range)
    const native = window.getSelection()
    if (target.start < drag.start) {
      native.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset)
    } else {
      native.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset)
    }
  }

  document.addEventListener('pointermove', (event) => {
    if (event.buttons === 1 && drag) {
      moveDrag(event)
      return
    }
    if (event.pointerType !== 'mouse' || event.buttons || sentenceTrigger.contains(event.target)) return
    if (root.contains(event.target)) hover(event)
    else scheduleHideSentence()
  })
  document.addEventListener('pointercancel', () => { drag = null })

  document.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return
    clearWord()
    const current = drag
    drag = null
    if (current?.active) {
      ignoreClick = true
      if (current.selection && current.material.isConnected) onSelect(current.selection)
      return
    }
    const material = materialFor(event.target, root)
    if (!material || isInteractiveContent(event.target)) return
    const selection = readingSelection(root)
    if (selection?.material === material && (event.detail > 1 || !sameRange(selection.range, selectionBeforePointer))) onSelect(selection)
  })

  root.addEventListener('click', (event) => {
    if (ignoreClick || event.detail !== 1 || hasModifier(event) || isInteractiveContent(event.target)
      || !materialFor(event.target, root)) return
    const selection = readingSelection(root)
    if (selection && !sameRange(selection.range, selectionBeforePointer)) return
    clearWord()
    const word = readingWordAt(root, event.clientX, event.clientY)
    if (!word) return
    if (selection) window.getSelection()?.removeAllRanges()
    wordTimer = setTimeout(() => {
      wordTimer = 0
      if (word.material.isConnected && !word.material.closest('[hidden]')) onSelect(word)
    }, 280)
  })

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Shift' && !event.repeat) selectionBeforeShift = readingSelection(root)?.range || null
  })
  document.addEventListener('keyup', (event) => {
    // Shift+Arrow can change the range repeatedly while Shift is held.
    if (event.key !== 'Shift') return
    const previous = selectionBeforeShift
    selectionBeforeShift = undefined
    if (previous === undefined || !root.contains(event.target)) return
    if (event.target.closest?.('input, textarea, button, a, summary')) return
    const selection = readingSelection(root)
    if (selection && !sameRange(selection.range, previous)) onSelect(selection)
  })

  document.addEventListener('scroll', hideSentence, true)
  window.addEventListener('resize', hideSentence)
  return { clearPending, hideSentence, hasPending: () => Boolean(wordTimer || sentenceTimer || hoveredSentence || drag) }
}
