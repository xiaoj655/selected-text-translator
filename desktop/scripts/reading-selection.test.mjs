import assert from 'node:assert/strict'
import test from 'node:test'
import { readingSentenceContext } from '../app/reading-selection.js'

function contextFor(text, selected, occurrence = 0) {
  let start = -1
  for (let index = 0; index <= occurrence; index += 1) start = text.indexOf(selected, start + 1)
  assert.ok(start >= 0, 'the fixture must contain the selection')
  const result = readingSentenceContext(text, start, start + selected.length)
  if (result.context) assert.equal(result.context.slice(result.contextStart, result.contextEnd), selected)
  return result
}

test('a word gets its complete sentence and one whole sentence on either side', () => {
  const text = 'An unrelated introduction. The team prepared a trial. They will record the result. That evidence guides the release. Another unrelated detail.'
  assert.equal(contextFor(text, 'record').context,
    'The team prepared a trial. They will record the result. That evidence guides the release.')
})

test('article boundaries only include the available neighbouring sentence', () => {
  const text = 'The first sentence starts here. The second sentence adds context. The final sentence ends here.'
  assert.equal(contextFor(text, 'first').context, 'The first sentence starts here. The second sentence adds context.')
  assert.equal(contextFor(text, 'final').context, 'The second sentence adds context. The final sentence ends here.')
})

test('a multi-sentence selection retains every selected sentence and one neighbour on each side', () => {
  const text = 'This is outside the window. A trial took place. It produced a useful record. The team kept it. A later review confirmed the result. This is outside again.'
  assert.equal(contextFor(text, 'It produced a useful record. The team kept it.').context,
    'A trial took place. It produced a useful record. The team kept it. A later review confirmed the result.')
})

test('blank lines preserve paragraph boundaries without using up neighbouring sentences', () => {
  const text = 'An unrelated paragraph.\n\nThe trial has finished.\n\nThey will record the result.\n\nIt will guide the release.\n\nAnother unrelated paragraph.'
  assert.equal(contextFor(text, 'record').context,
    'The trial has finished.\n\nThey will record the result.\n\nIt will guide the release.')
})

test('a repeated word near the end of an article gets its own occurrence and sentences', () => {
  const prefix = 'A record keeps decisions available. Background information helps the team. '.repeat(240)
  const text = `${prefix}\n\nA new interview was scheduled. We will record it tomorrow. The editor will review it. An unrelated final detail.`
  assert.ok(text.length > 12000)
  const result = readingSentenceContext(text, text.indexOf('record it tomorrow'), text.indexOf('record it tomorrow') + 'record'.length)
  assert.equal(result.context, 'A new interview was scheduled. We will record it tomorrow. The editor will review it.')
  assert.equal(result.context.slice(result.contextStart, result.contextEnd), 'record')
})

test('title abbreviations remain attached to their sentence', () => {
  const text = 'The interview is ready. Dr. Brown will record it. The editor is waiting.'
  assert.equal(contextFor(text, 'Brown').context, text)
})

test('the fallback drops oversized neighbouring sentences instead of cutting them', () => {
  const longSentence = `${'Background information '.repeat(130)}is available.`
  const text = `${longSentence} They will record a trial. The editor will review it.`
  assert.equal(contextFor(text, 'record').context, 'They will record a trial. The editor will review it.')
})

test('an oversized containing sentence sends the selection alone without partial context', () => {
  const text = `First sentence. ${'Information '.repeat(250)}will record a trial later. Last sentence.`
  assert.deepEqual(contextFor(text, 'record'), { context: '', contextStart: null, contextEnd: null })
})

test('selected text beyond the context budget is preserved by omitting optional context', () => {
  const selected = `${'Selected information '.repeat(150)}is complete.`
  const text = `Before the selection. ${selected} After the selection.`
  assert.deepEqual(contextFor(text, selected), { context: '', contextStart: null, contextEnd: null })
})

test('sentence context preserves exact UTF-16 offsets around Unicode text', () => {
  const text = 'The editor said “ready.” 🧭 We will record the author’s idea. It could help the team.'
  const result = contextFor(text, 'author’s')
  assert.equal(result.context, text)
  assert.equal(result.contextStart, text.indexOf('author’s'))
})
