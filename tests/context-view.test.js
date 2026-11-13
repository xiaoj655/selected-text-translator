import test from 'node:test'
import assert from 'node:assert/strict'
import { getContextView } from '../src/context-view.js'

function selected(context, text, start = context.indexOf(text)) {
  return { text, context, contextStart: start, contextEnd: start + text.length }
}

function assertSegments(view) {
  assert.equal(view.segments.map(({ text }) => text).join(''), view.text)
  assert.equal(view.fullSegments.map(({ text }) => text).join(''), view.fullText)
}

test('repeated words retain the precise verb or noun occurrence in both context views', () => {
  const context = 'We will record the song. The record is ready.'
  const verbView = getContextView(selected(context, 'record'))
  const nounView = getContextView(selected(context, 'record', context.lastIndexOf('record')))
  assert.equal(verbView.text, 'We will record the song.')
  assert.equal(nounView.text, 'The record is ready.')
  assert.deepEqual(nounView.segments, [
    { text: 'The ', isTarget: false },
    { text: 'record', isTarget: true },
    { text: ' is ready.', isTarget: false },
  ])
  assert.deepEqual(nounView.fullSegments, [
    { text: 'We will record the song. The ', isTarget: false },
    { text: 'record', isTarget: true },
    { text: ' is ready.', isTarget: false },
  ])
  for (const view of [verbView, nounView]) {
    assert.equal(view.hasLocation, true)
    assert.equal(view.isFocused, true)
    assert.equal(view.isAmbiguous, false)
    assertSegments(view)
  }
})

test('only the selected occurrence is highlighted when a sentence repeats the target', () => {
  const context = 'They record each record carefully. Then they leave.'
  const view = getContextView(selected(context, 'record', context.lastIndexOf('record')))
  assert.deepEqual(view.segments, [
    { text: 'They record each ', isTarget: false },
    { text: 'record', isTarget: true },
    { text: ' carefully.', isTarget: false },
  ])
  assertSegments(view)
})

test('a repeated whole sentence uses the original target offset for its focused highlight', () => {
  const context = 'The record is ready. We moved on. The record is ready. Then we left.'
  const view = getContextView(selected(context, 'record', context.lastIndexOf('record')))
  assert.equal(view.text, 'The record is ready.')
  assert.deepEqual(view.segments, [
    { text: 'The ', isTarget: false },
    { text: 'record', isTarget: true },
    { text: ' is ready.', isTarget: false },
  ])
  assert.equal(view.fullSegments[0].text, 'The record is ready. We moved on. The ')
  assertSegments(view)
})

test('a target spanning sentences keeps every covered sentence and the exact selected text', () => {
  const context = 'They agree. We can record this. It will matter tomorrow. They leave.'
  const text = 'record this. It will matter'
  const view = getContextView(selected(context, text))
  assert.equal(view.text, 'We can record this. It will matter tomorrow.')
  assert.deepEqual(view.segments, [
    { text: 'We can ', isTarget: false },
    { text, isTarget: true },
    { text: ' tomorrow.', isTarget: false },
  ])
  assertSegments(view)
})

test('titles and quotation marks stay in the focused sentence', () => {
  for (const [context, expected] of [
    ['Dr. Smith will record this. Then he leaves.', 'Dr. Smith will record this.'],
    ['She asked, “Can you record this?” He agreed.', 'She asked, “Can you record this?”'],
    ['She said, "Please record this." He nodded.', 'She said, "Please record this."'],
  ]) {
    const view = getContextView(selected(context, 'record'))
    assert.equal(view.text, expected)
    assert.equal(view.segments.find(({ isTarget }) => isTarget).text, 'record')
    assertSegments(view)
  }
})

test('legacy missing or null offsets locate only a unique literal occurrence', () => {
  const context = '  She was reluctant to accept. He waited.  '
  for (const offsets of [{}, { contextStart: null, contextEnd: null },
    { contextStart: undefined, contextEnd: null }, { contextStart: null }]) {
    const view = getContextView({ text: 'reluctant', context, ...offsets })
    assert.equal(view.text, 'She was reluctant to accept.')
    assert.equal(view.fullText, context)
    assert.equal(view.hasLocation, true)
    assert.equal(view.isAmbiguous, false)
    assertSegments(view)
  }
})

test('missing offsets never guess among repeated literal occurrences or overlapping matches', () => {
  for (const [text, context] of [
    ['record', 'We record the song. The record is ready.'],
    ['record', 'A recording and a record.'],
    ['aa', 'aaaa'],
  ]) {
    const view = getContextView({ text, context })
    assert.equal(view.text, context)
    assert.deepEqual(view.segments, [{ text: context, isTarget: false }])
    assert.equal(view.isFocused, false)
    assert.equal(view.hasLocation, false)
    assert.equal(view.isAmbiguous, true)
    assertSegments(view)
  }
})

test('invalid explicit offsets do not fall back to a unique text match', () => {
  const context = 'We will record the song. Then we leave.'
  for (const offsets of [
    { contextStart: -1, contextEnd: 6 },
    { contextStart: 0, contextEnd: 6 },
    { contextStart: 8 },
    { contextStart: null, contextEnd: 14 },
    { contextStart: 8.5, contextEnd: 14.5 },
    { contextStart: 8, contextEnd: 99 },
    { contextStart: 8, contextEnd: 8 },
    { contextStart: '8', contextEnd: 14 },
  ]) {
    const view = getContextView({ text: 'record', context, ...offsets })
    assert.equal(view.text, context)
    assert.equal(view.hasLocation, false)
    assert.equal(view.isAmbiguous, true)
    assert.deepEqual(view.segments, [{ text: context, isTarget: false }])
    assertSegments(view)
  }
})

test('missing context produces an empty view without manufacturing a target context', () => {
  const expected = {
    text: '', segments: [], fullText: '', fullSegments: [],
    isFocused: false, hasLocation: false, isAmbiguous: false,
  }
  for (const entry of [undefined, null, {}, { text: 'record' },
    { text: 'record', context: null }, { text: 'record', context: '', contextStart: 0, contextEnd: 6 }]) {
    assert.deepEqual(getContextView(entry), expected)
  }
})

test('a missing target preserves the full original context without a sentence guess', () => {
  const context = '  She accepted. He waited.  '
  for (const text of ['missing', '']) {
    const view = getContextView({ text, context })
    assert.equal(view.text, context)
    assert.equal(view.fullText, context)
    assert.equal(view.hasLocation, false)
    assert.equal(view.isFocused, false)
    assert.equal(view.isAmbiguous, false)
    assertSegments(view)
  }
})

test('HTML-shaped context stays literal plain text in every segment', () => {
  const context = '<p>We <em>record</em> &amp; keep it.</p> Next sentence.'
  const view = getContextView(selected(context, 'record'))
  assert.equal(view.fullText, context)
  assert.deepEqual(view.fullSegments, [
    { text: '<p>We <em>', isTarget: false },
    { text: 'record', isTarget: true },
    { text: '</em> &amp; keep it.</p> Next sentence.', isTarget: false },
  ])
  assertSegments(view)
})

test('an overlong sentence falls back to full context with the exact target still highlighted', () => {
  const sentence = `A ${'x'.repeat(1191)} record.`
  const context = `Before this. ${sentence} After this.`
  const view = getContextView(selected(context, 'record'))
  assert.equal(sentence.length, 1201)
  assert.equal(view.text, context)
  assert.equal(view.hasLocation, true)
  assert.equal(view.isFocused, false)
  assert.equal(view.isAmbiguous, false)
  assert.deepEqual(view.segments, view.fullSegments)
  assert.equal(view.segments.find(({ isTarget }) => isTarget).text, 'record')
  assertSegments(view)
})

test('Unicode locations use UTF-16 offsets and preserve every original character', () => {
  const context = '😀 We record music. 🎵 The record is ready.'
  const view = getContextView(selected(context, 'record', 27))
  assert.equal(context.slice(27, 33), 'record')
  assert.equal(view.text, '🎵 The record is ready.')
  assert.deepEqual(view.fullSegments, [
    { text: '😀 We record music. 🎵 The ', isTarget: false },
    { text: 'record', isTarget: true },
    { text: ' is ready.', isTarget: false },
  ])
  assert.equal(view.hasLocation, true)
  assertSegments(view)
})

test('a target containing a complete sentence retains exact offsets in the full context fallback', () => {
  const context = 'Before this. The record is ready. After this.'
  const view = getContextView(selected(context, 'The record is ready.'))
  assert.equal(view.text, context)
  assert.equal(view.isFocused, false)
  assert.equal(view.hasLocation, true)
  assert.equal(view.segments.find(({ isTarget }) => isTarget).text, 'The record is ready.')
  assertSegments(view)
})

test('deriving context views leaves the stored entry untouched', () => {
  const entry = Object.freeze(selected('We record this. Then we leave.', 'record'))
  const original = { ...entry }
  getContextView(entry)
  assert.deepEqual(entry, original)
})
