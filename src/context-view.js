import { getContextSentence } from './context-sentence.js'

export function getContextView(entry = {}) {
  const fullText = String(entry?.context || '')
  const selectedText = String(entry?.text || '')
  const emptyView = {
    text: fullText,
    segments: createSegments(fullText),
    fullText,
    fullSegments: createSegments(fullText),
    isFocused: false,
    hasLocation: false,
    isAmbiguous: false,
  }
  if (!fullText) return emptyView
  const { location, isAmbiguous } = getTargetLocation(entry, selectedText, fullText)
  if (!location) return { ...emptyView, isAmbiguous }
  const fullSegments = createSegments(fullText, location)
  const sentence = getContextSentence({
    text: selectedText,
    context: fullText,
    contextStart: location.start,
    contextEnd: location.end,
  })
  const sentenceLocation = getSentenceLocation(fullText, sentence, location)
  const text = sentenceLocation ? sentence : fullText
  const start = sentenceLocation ? sentenceLocation.start : 0
  return {
    text,
    segments: createSegments(text, { start: location.start - start, end: location.end - start }),
    fullText,
    fullSegments,
    isFocused: text !== fullText,
    hasLocation: true,
    isAmbiguous: false,
  }
}

function getTargetLocation(entry, text, context) {
  const start = entry?.contextStart
  const end = entry?.contextEnd
  const hasOffsets = start != null || end != null
  if (hasOffsets) {
    const isValid = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start &&
      end <= context.length && context.slice(start, end) === text
    return {
      location: isValid ? { start, end } : null,
      isAmbiguous: !isValid,
    }
  }
  if (!text) return { location: null, isAmbiguous: false }
  const index = context.indexOf(text)
  if (index < 0) return { location: null, isAmbiguous: false }
  if (context.indexOf(text, index + 1) >= 0) return { location: null, isAmbiguous: true }
  return { location: { start: index, end: index + text.length }, isAmbiguous: false }
}

function getSentenceLocation(context, sentence, targetLocation) {
  if (!sentence) return null
  let start = context.indexOf(sentence)
  while (start >= 0 && start <= targetLocation.start) {
    const end = start + sentence.length
    if (end >= targetLocation.end) return { start, end }
    start = context.indexOf(sentence, start + 1)
  }
  return null
}

function createSegments(text, location) {
  if (!text) return []
  if (!location) return [{ text, isTarget: false }]
  const segments = []
  if (location.start > 0) segments.push({ text: text.slice(0, location.start), isTarget: false })
  segments.push({ text: text.slice(location.start, location.end), isTarget: true })
  if (location.end < text.length) segments.push({ text: text.slice(location.end), isTarget: false })
  return segments
}
