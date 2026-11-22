import { parseHTML } from 'linkedom'
import { coachError } from './tutor.js'

export const READING_TEXT_BUDGET = 12000
const MAX_PASSAGE_LENGTH = 1800
const MAX_PASSAGES = 96
const OMITTED = '\n\n[... omitted article passages ...]\n\n'
const STOP_WORDS = new Set(('the and was can not are for our out all but about after again also because before being between could does from have into itself '
  + 'just more most other over same should some such than that their them then there these they this those through '
  + 'under very were what when where which while with would your explain why how').split(' '))

function boundedText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit).toWellFormed() : ''
}

function articlePassages(text) {
  const passages = []
  let offset = 0
  for (const raw of text.split(/\n\s*\n/u)) {
    const paragraphStart = text.indexOf(raw, offset)
    offset = paragraphStart + raw.length
    let start = paragraphStart + raw.length - raw.trimStart().length
    const paragraphEnd = paragraphStart + raw.trimEnd().length
    const paragraph = passages.length
    while (start < paragraphEnd) {
      let end = Math.min(paragraphEnd, start + MAX_PASSAGE_LENGTH)
      if (end < paragraphEnd) {
        const tail = text.slice(start + Math.floor(MAX_PASSAGE_LENGTH / 2), end)
        const boundaries = [...tail.matchAll(/[.!?][”"')\]]*\s+|\s+/gu)]
        const boundary = boundaries.findLast(({ 0: value }) => /^[.!?]/u.test(value)) || boundaries.at(-1)
        if (boundary) end = start + Math.floor(MAX_PASSAGE_LENGTH / 2) + boundary.index + boundary[0].length
        if (/[\uD800-\uDBFF]/u.test(text[end - 1] || '')) end -= 1
      }
      const part = text.slice(start, end).trimEnd()
      if (part) passages.push({ start, end: start + part.length, text: part, paragraph })
      start = end
      while (start < paragraphEnd && /\s/u.test(text[start])) start += 1
    }
  }
  return passages
}

function headingsFor(article, text) {
  if (typeof article.html !== 'string' || !article.html) return []
  const { document } = parseHTML(`<html><body>${article.html}</body></html>`)
  const headings = []
  let length = 0
  for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const value = heading.textContent.trim()
    if (!value || !text.includes(value) || headings.includes(value)) continue
    if (length + value.length > 1200) break
    headings.push(value)
    length += value.length
  }
  return headings
}

function queryTerms(value) {
  return [...new Set((value.toLowerCase().match(/\p{L}[\p{L}\p{N}'’-]*/gu) || [])
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word)))]
}

function selectedText(text, passages, selected) {
  const ordered = [...selected].sort((a, b) => a - b).map((index) => passages[index])
  if (!ordered.length) return ''
  let result = ordered[0].start ? OMITTED.trimStart() : ''
  let previous = null
  for (const passage of ordered) {
    if (previous) {
      const gap = text.slice(previous.end, passage.start)
      result += gap.trim() ? OMITTED : gap
    }
    result += passage.text
    previous = passage
  }
  if (previous.end < text.length) result += OMITTED.trimEnd()
  return result
}

function citationPassages(text, passages, selected) {
  const result = []
  let previous
  for (const index of [...selected].sort((a, b) => a - b)) {
    const passage = passages[index]
    if (previous && previous.paragraph === passage.paragraph && !text.slice(previous.end, passage.start).trim()) {
      result[result.length - 1] += text.slice(previous.end, passage.start) + passage.text
    } else result.push(passage.text)
    previous = passage
  }
  return result
}

export function buildReadingContext(article, { question = '', history = [], focusText = '' } = {}) {
  const text = (typeof article?.text === 'string' ? article.text.trim() : '')
    || (typeof article?.excerpt === 'string' ? article.excerpt.trim() : '')
  if (!text) throw coachError('This article has no text to read. Try another article or paste a passage.')
  const url = boundedText(article.url, 1600)
  let kind = url ? article.hasFullText === true ? 'feed_article' : 'feed_excerpt' : 'pasted_text'
  if (article.kind === 'web_article') kind = 'web_article'
  const context = {
    title: boundedText(article.title, 400),
    source: boundedText(article.source, 120),
    publishedAt: boundedText(article.publishedAt, 60),
    url, text, kind,
  }
  const passages = articlePassages(text)
  if (text.length <= READING_TEXT_BUDGET) return {
    article: context,
    passages: citationPassages(text, passages, new Set(passages.map((_passage, index) => index))),
  }

  const headings = headingsFor(article, text)
  const textBudget = READING_TEXT_BUDGET - headings.reduce((total, heading) => total + heading.length, 0)
  const candidates = []
  const add = (index) => {
    if (index >= 0 && index < passages.length && !candidates.includes(index)) candidates.push(index)
  }
  const around = (index) => { add(index); add(index - 1); add(index + 1) }
  const validFocus = typeof focusText === 'string' && focusText.trim().length <= 12000 ? focusText.trim() : ''
  const focusStart = validFocus ? text.indexOf(validFocus) : -1
  const isQuestion = Boolean(question.trim())
  if (isQuestion) {
    const quotes = [...question.matchAll(/["“]([^"”]{4,500})["”]/gu)].map((match) => match[1])
    for (const quote of quotes) {
      const start = text.indexOf(quote)
      if (start >= 0) around(passages.findIndex((passage) => passage.start <= start && passage.end > start))
    }
    if (focusStart >= 0) around(passages.findIndex((passage) => passage.start <= focusStart && passage.end > focusStart))
    const terms = queryTerms(question)
    const previousTerms = queryTerms(history.slice(-2).map((turn) => turn.text).join(' '))
    const frequencies = new Map()
    const words = passages.map((passage) => new Set(queryTerms(passage.text)))
    for (const word of new Set([...terms, ...previousTerms])) {
      frequencies.set(word, words.reduce((count, block) => count + Number(block.has(word)), 0))
    }
    const score = (block, tokens, weight) => tokens.reduce((total, word) => total
      + (block.has(word) ? weight * Math.log(1 + passages.length / (1 + frequencies.get(word))) : 0), 0)
    const ranked = passages.map((passage, index) => ({ index,
      score: score(words[index], terms, 4) + score(words[index], previousTerms, 1) }))
      .filter((match) => match.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
    for (const match of ranked.slice(0, 8)) around(match.index)
  }
  // With no question, cover the beginning, conclusion and middle before filling
  // in headings and evenly spaced passages from the rest of the article.
  around(0)
  around(passages.length - 1)
  around(Math.floor((passages.length - 1) / 2))
  around(Math.round((passages.length - 1) / 4))
  around(Math.round((passages.length - 1) * 3 / 4))
  for (let step = 1; step < MAX_PASSAGES; step += 1) add(Math.round((passages.length - 1) * step / MAX_PASSAGES))

  const selected = new Set()
  for (const index of candidates) {
    if (selected.size >= MAX_PASSAGES) break
    const next = new Set([...selected, index])
    if (selectedText(text, passages, next).length <= textBudget) selected.add(index)
  }
  context.text = selectedText(text, passages, selected)
  context.textIsPartial = true
  context.totalTextLength = text.length
  if (headings.length) context.headings = headings
  return { article: context, passages: citationPassages(text, passages, selected) }
}
