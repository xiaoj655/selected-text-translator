import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampReaderParagraphIndex,
  parseReaderArticle,
  resolveReaderSelection,
} from '../entry/src/main/ets/reader/ReaderDomain.ts'

test('pasted paragraphs restore exact source ranges and stable identifiers', () => {
  const pasted = '\r\n  Heading 🌱  \r\n\t\r\n First paragraph. \n\n  Second one. \r'
  const article = parseReaderArticle(pasted, 'article-1')

  assert.equal(article.title, 'Heading 🌱')
  assert.deepEqual(article.paragraphs.map(({ text }) => text), ['Heading 🌱', 'First paragraph.', 'Second one.'])
  for (const paragraph of article.paragraphs) {
    assert.equal(paragraph.id, `article-1:${paragraph.start}`)
    assert.equal(pasted.slice(paragraph.start, paragraph.end), paragraph.text)
  }
  assert.deepEqual(parseReaderArticle(pasted, 'article-1'), article)
  assert.equal(parseReaderArticle('   \n\r\t', 'empty'), null)
})

test('a long first line is shortened for the title without losing article text or splitting a surrogate pair', () => {
  const line = 'A'.repeat(62) + '🌱 goes after the title boundary.'
  const article = parseReaderArticle(line, 'long')

  assert.equal(article.title, 'A'.repeat(62) + '…')
  assert.equal(article.paragraphs[0].text, line)
})

test('an optional title does not change the pasted body or its offsets', () => {
  const article = parseReaderArticle('The first paragraph.', 'titled', ' An article ')

  assert.equal(article.title, 'An article')
  assert.equal(article.paragraphs[0].text, 'The first paragraph.')
  assert.equal(article.paragraphs[0].start, 0)
})

test('word lookup preserves UTF-16 offsets for repeated words, contractions, and hyphenated words', () => {
  const paragraph = '👋 They record a record. They’re well‑known.'
  const secondRecord = paragraph.lastIndexOf('record')
  const word = resolveReaderSelection(paragraph, secondRecord + 1, 'word')

  assert.deepEqual(word, {
    kind: 'word',
    text: 'record',
    start: secondRecord,
    end: secondRecord + 'record'.length,
    sentence: '👋 They record a record.',
    sentenceStart: 0,
    sentenceEnd: paragraph.indexOf(' They’re'),
  })
  assert.equal(resolveReaderSelection(paragraph, paragraph.indexOf('’'), 'word').text, 'They’re')
  assert.equal(resolveReaderSelection(paragraph, paragraph.indexOf('‑'), 'word').text, 'well‑known')
  assert.equal(resolveReaderSelection(paragraph, paragraph.indexOf(' '), 'word'), null)
  assert.equal(resolveReaderSelection(paragraph, paragraph.indexOf('.'), 'word'), null)
  assert.equal(resolveReaderSelection(paragraph, paragraph.length, 'word'), null)
  assert.equal(resolveReaderSelection(paragraph, -1, 'word'), null)
})

test('sentence lookup keeps titles, common abbreviations, decimal points, and trailing quotes', () => {
  const paragraph = 'Done. Dr. Taylor asked, “Is it well-known?” U.S. researchers said 3.14, e.g. in the first example. Next.'
  const quotation = resolveReaderSelection(paragraph, paragraph.indexOf('Taylor'), 'sentence')

  assert.equal(quotation.text, 'Dr. Taylor asked, “Is it well-known?”')
  assert.equal(quotation.start, paragraph.indexOf('Dr.'))
  assert.equal(quotation.end, paragraph.indexOf(' U.S.'))
  assert.equal(quotation.text, paragraph.slice(quotation.start, quotation.end))
  assert.equal(
    resolveReaderSelection(paragraph, paragraph.indexOf('the first'), 'sentence').text,
    'U.S. researchers said 3.14, e.g. in the first example.',
  )
  assert.equal(resolveReaderSelection(paragraph, paragraph.indexOf('Next'), 'sentence').text, 'Next.')
  const afterAbbreviation = 'We packed food, etc. Then we left.'
  assert.equal(resolveReaderSelection(afterAbbreviation, afterAbbreviation.indexOf('Then'), 'sentence').text, 'Then we left.')
})

test('no punctuation is required for lookup and surrounding whitespace stays outside the selection', () => {
  const paragraph = '  An unfinished thought  '
  const selection = resolveReaderSelection(paragraph, paragraph.indexOf('unfinished'), 'sentence')

  assert.equal(selection.text, 'An unfinished thought')
  assert.equal(selection.start, 2)
  assert.equal(selection.end, paragraph.length - 2)
  assert.equal(resolveReaderSelection(paragraph, 1, 'sentence'), null)
})

test('the restored paragraph index stays within the available text', () => {
  const article = parseReaderArticle('First.\n\nSecond.', 'progress')

  assert.equal(clampReaderParagraphIndex(article, 1), 1)
  assert.equal(clampReaderParagraphIndex(article, 12), 1)
  assert.equal(clampReaderParagraphIndex(article, -1), 0)
  assert.equal(clampReaderParagraphIndex(article, NaN), 0)
  assert.equal(clampReaderParagraphIndex(article, 1.5), 0)
})
