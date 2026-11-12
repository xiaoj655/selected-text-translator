import test from 'node:test'
import assert from 'node:assert/strict'
import { getContextSentence } from '../src/context-sentence.js'

function selected(context, text, start = context.indexOf(text)) {
  return { text, context, contextStart: start, contextEnd: start + text.length }
}

test('context sentence preserves Dr. and other titles before the selected word', () => {
  const context = 'Dr. Smith will record the interview. Then he will leave.'
  assert.equal(getContextSentence(selected(context, 'record')), 'Dr. Smith will record the interview.')
  const multipleTitles = 'Prof. Lee met Mr. Smith to record the interview. They left.'
  assert.equal(getContextSentence(selected(multipleTitles, 'record')),
    'Prof. Lee met Mr. Smith to record the interview.')
})

test('context sentence keeps quotation marks and the complete surrounding sentence', () => {
  const context = 'She asked, “Can you record this?” He agreed.'
  assert.equal(getContextSentence(selected(context, 'record')), 'She asked, “Can you record this?”')
  const straightQuotes = 'She said, "Please record this." He nodded.'
  assert.equal(getContextSentence(selected(straightQuotes, 'record')), 'She said, "Please record this."')
})

test('explicit positions distinguish repeated words in different sentences', () => {
  const context = 'We will record the song. The record is ready.'
  assert.equal(getContextSentence(selected(context, 'record')), 'We will record the song.')
  assert.equal(getContextSentence(selected(context, 'record', context.lastIndexOf('record'))),
    'The record is ready.')
  assert.equal(getContextSentence({ text: 'record', context }), '')
})

test('a selection spanning sentences returns all complete covered sentences', () => {
  const context = 'We can record this. It will matter tomorrow. They agree.'
  assert.equal(getContextSentence(selected(context, 'record this. It will matter')),
    'We can record this. It will matter tomorrow.')
})

test('missing positions only infer an unambiguous exact occurrence', () => {
  assert.equal(getContextSentence({ text: 'reluctant', context: 'She was reluctant to accept. He waited.' }),
    'She was reluctant to accept.')
  assert.equal(getContextSentence({ text: 'record', context: 'A recording and a record.' }), '')
  assert.equal(getContextSentence({ text: 'missing', context: 'She was reluctant to accept.' }), '')
  assert.equal(getContextSentence({ text: '', context: 'Any sentence.' }), '')
})

test('invalid explicit positions cannot silently select another occurrence', () => {
  const context = 'We will record the song.'
  for (const offsets of [{ contextStart: -1, contextEnd: 6 }, { contextStart: 0, contextEnd: 6 },
    { contextStart: 8 }, { contextStart: 8.5, contextEnd: 14 }, { contextStart: 8, contextEnd: 99 }]) {
    assert.equal(getContextSentence({ text: 'record', context, ...offsets }), '')
  }
})

test('a sentence already fully selected has no redundant context action', () => {
  const context = '  She was reluctant to accept.  He waited.'
  assert.equal(getContextSentence(selected(context, 'She was reluctant to accept.')), '')
  assert.equal(getContextSentence({ text: 'Only this fragment', context: 'Only this fragment' }), '')
})

test('sentences at the length limit are retained while longer ones are not truncated', () => {
  const exactLimit = `A ${'x'.repeat(1190)} record.`
  assert.equal(exactLimit.length, 1200)
  assert.equal(getContextSentence(selected(exactLimit, 'record')), exactLimit)
  const beyondLimit = `A ${'x'.repeat(1191)} record.`
  assert.equal(getContextSentence(selected(beyondLimit, 'record')), '')
})

test('sentence lookup remains available when Intl.Segmenter is unavailable', () => {
  const original = Intl.Segmenter
  try {
    Intl.Segmenter = undefined
    const context = 'Dr. Smith said, "Please record this." He left.'
    assert.equal(getContextSentence(selected(context, 'record')), 'Dr. Smith said, "Please record this."')
  } finally {
    Intl.Segmenter = original
  }
})
