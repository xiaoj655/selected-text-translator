const TITLE_ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|Prof|Rev|Hon)\.\s*$/iu
const MAX_CONTEXT_SENTENCE_LENGTH = 1200

export function getContextSentence({ text, context, contextStart, contextEnd } = {}) {
  const selectedText = String(text || '')
  const surroundingText = String(context || '')
  if (!selectedText.trim() || !surroundingText.trim()) return ''
  const location = getSelectionLocation(selectedText, surroundingText, contextStart, contextEnd)
  if (!location) return ''
  const segments = getSentenceSegments(surroundingText)
  const covered = segments.filter(({ index, segment }) =>
    index < location.end && index + segment.length > location.start,
  )
  if (!covered.length) return ''
  const first = covered[0]
  const last = covered[covered.length - 1]
  const sentence = surroundingText.slice(first.index, last.index + last.segment.length).trim()
  if (sentence === selectedText.trim() || sentence.length > MAX_CONTEXT_SENTENCE_LENGTH) return ''
  return sentence
}

function getSelectionLocation(text, context, start, end) {
  if (start === undefined && end === undefined) {
    const index = context.indexOf(text)
    if (index < 0 || context.indexOf(text, index + 1) !== -1) return null
    return { start: index, end: index + text.length }
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end <= start || end > context.length || context.slice(start, end) !== text) return null
  return { start, end }
}

function getSentenceSegments(text) {
  let segments
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
    segments = Array.from(segmenter.segment(text), ({ index, segment }) => ({ index, segment }))
  } catch {
    segments = splitSentences(text)
  }
  return segments.reduce((result, current) => {
    const previous = result[result.length - 1]
    if (previous && TITLE_ABBREVIATION.test(previous.segment)) previous.segment += current.segment
    else result.push(current)
    return result
  }, [])
}

function splitSentences(text) {
  const segments = []
  let start = 0
  for (const match of text.matchAll(/[.!?]+["'”’)\]]*(?:\s+|$)/gu)) {
    const end = match.index + match[0].length
    segments.push({ index: start, segment: text.slice(start, end) })
    start = end
  }
  if (start < text.length) segments.push({ index: start, segment: text.slice(start) })
  return segments
}
