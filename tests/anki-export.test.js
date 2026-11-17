import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnkiTsv, countAnkiRows } from '../src/anki-export.js'

function entry(overrides = {}) {
  return {
    text: 'record',
    meaning: '唱片',
    phonetic: '/ˈrɛkərd/',
    explanation: 'a music release',
    example: 'their new record',
    context: 'The band will record a new record.',
    usage: 'release a record',
    ...overrides,
  }
}

test('buildAnkiTsv emits Front / Back / Tags columns', () => {
  const tsv = buildAnkiTsv([entry()])
  const columns = tsv.split('\t')
  assert.equal(columns.length, 3)
  assert.equal(columns[0], 'record')
  assert.match(columns[1], /^唱片/u)
  assert.match(columns[1], /音标 \/ˈrɛkərd\//u)
  assert.match(columns[1], /释义 a music release/u)
  assert.match(columns[1], /例句 their new record/u)
  assert.match(columns[1], /语境 The band will record a new record\./u)
  assert.match(columns[1], /用法 release a record/u)
  assert.equal(columns[2], 'selected-english')
})

test('buildAnkiTsv escapes HTML and flattens newlines and tabs', () => {
  const tsv = buildAnkiTsv([entry({
    text: '<b>word</b>\tvalue',
    meaning: 'line one\nline two & <tag>',
    example: '',
  })])
  const columns = tsv.split('\t')
  assert.equal(columns[0], '&lt;b&gt;word&lt;/b&gt; value')
  assert.match(columns[1], /line one<br>line two &amp; &lt;tag&gt;/u)
  assert.doesNotMatch(columns[1], /例句/u)
})

test('buildAnkiTsv skips entries missing text or meaning and malformed values', () => {
  const tsv = buildAnkiTsv([
    entry({ text: '', meaning: 'empty front' }),
    entry({ text: 'empty back', meaning: '' }),
    null,
    'not an entry',
    [],
    { text: 'valid', meaning: '有效' },
  ])
  assert.equal(tsv, 'valid\t有效\tselected-english')
})

test('buildAnkiTsv returns an empty string for missing or empty input', () => {
  assert.equal(buildAnkiTsv(null), '')
  assert.equal(buildAnkiTsv(undefined), '')
  assert.equal(buildAnkiTsv({}), '')
  assert.equal(buildAnkiTsv([]), '')
})

test('countAnkiRows counts rows and handles an empty export', () => {
  const tsv = buildAnkiTsv([entry({ text: 'a' }), entry({ text: 'b' })])
  assert.equal(countAnkiRows(tsv), 2)
  assert.equal(countAnkiRows(''), 0)
})
