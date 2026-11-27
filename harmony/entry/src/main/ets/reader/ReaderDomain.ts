interface TextRange {
  start: number
  end: number
}

export interface ReaderParagraph extends TextRange {
  id: string
  text: string
}

export interface ReaderArticle {
  id: string
  title: string
  paragraphs: ReaderParagraph[]
}

export interface ReaderLibraryEntry {
  article: ReaderArticle
  paragraphIndex: number
}

export type ReaderSelectionKind = 'word' | 'sentence'

export interface ReaderSelection extends TextRange {
  kind: ReaderSelectionKind
  text: string
  sentence: string
  sentenceStart: number
  sentenceEnd: number
}

const TITLE_LIMIT = 64
const CONTINUING_ABBREVIATION = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Hon|St|Mt|Jr|Sr|vs|e\.g|i\.e)\.$/i
const TERMINAL_ABBREVIATION = /(?:\betc\.|\b(?:[A-Z]\.){2,})$/

export function parseReaderArticle(input: string, id: string, titleOverride: string = ''): ReaderArticle | null {
  const paragraphs: ReaderParagraph[] = []
  const lines = /[^\r\n]+/g
  let line = lines.exec(input)
  while (line !== null) {
    const text = line[0].trim()
    if (text.length > 0) {
      const start = line.index + line[0].length - line[0].trimStart().length
      paragraphs.push({ id: `${id}:${start}`, text, start, end: start + text.length })
    }
    line = lines.exec(input)
  }
  if (paragraphs.length === 0) return null

  const firstLine = titleOverride.trim() || paragraphs[0].text
  let title = firstLine
  if (firstLine.length > TITLE_LIMIT) {
    const prefix = firstLine.slice(0, TITLE_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, '')
    const lastSpace = prefix.lastIndexOf(' ')
    title = (lastSpace >= 40 ? prefix.slice(0, lastSpace) : prefix) + '…'
  }
  return { id, title, paragraphs }
}

export function clampReaderParagraphIndex(article: ReaderArticle, paragraphIndex: number): number {
  if (!Number.isInteger(paragraphIndex)) return 0
  return Math.max(0, Math.min(paragraphIndex, article.paragraphs.length - 1))
}

function sentenceAt(text: string, offset: number): TextRange | null {
  const boundaries = /([.!?…。！？]+["'”’»)}\]]*)(\s+|$)/g
  let start = 0
  let end = text.length
  let boundary = boundaries.exec(text)
  while (boundary !== null) {
    const mark = boundary[1]
    const boundaryEnd = boundary.index + mark.length
    const nextStart = boundaries.lastIndex
    const following = text.charAt(nextStart)
    const ending = text.slice(Math.max(start, boundary.index - 24), boundaryEnd)
    const alwaysContinues = mark === '.' && CONTINUING_ABBREVIATION.test(ending)
    const mayContinue = (mark === '.' && TERMINAL_ABBREVIATION.test(ending)) || /^(?:\.{2,}|…)$/.test(mark)
    const continues = following.length > 0 && (alwaysContinues || (mayContinue && /[a-z]/.test(following)))
    if (!continues) {
      if (offset < nextStart) {
        end = boundaryEnd
        break
      }
      start = nextStart
    }
    boundary = boundaries.exec(text)
  }
  const sentence = text.slice(start, end)
  start += sentence.length - sentence.trimStart().length
  end -= sentence.length - sentence.trimEnd().length
  return start <= offset && offset < end ? { start, end } : null
}

export function resolveReaderSelection(text: string, offset: number, kind: ReaderSelectionKind): ReaderSelection | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= text.length || /\s/.test(text.charAt(offset))) return null
  const range = sentenceAt(text, offset)
  if (range === null) return null
  const sentence = text.slice(range.start, range.end)
  if (kind === 'sentence') {
    return { kind, text: sentence, start: range.start, end: range.end, sentence, sentenceStart: range.start, sentenceEnd: range.end }
  }

  const words = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’‐‑-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu
  const relativeOffset = offset - range.start
  let word = words.exec(sentence)
  while (word !== null && word.index <= relativeOffset) {
    if (relativeOffset < words.lastIndex) {
      return {
        kind,
        text: word[0],
        start: range.start + word.index,
        end: range.start + words.lastIndex,
        sentence,
        sentenceStart: range.start,
        sentenceEnd: range.end,
      }
    }
    word = words.exec(sentence)
  }
  return null
}
