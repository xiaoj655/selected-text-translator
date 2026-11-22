import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReadingHistory } from '../src/reading-history.js'

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'stt-reading-history-'))
  try { run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

const ARTICLE = { id: 'content-version-1', kind: 'web_article', title: 'A complete article', source: 'publisher.example',
  url: 'https://publisher.example/story', text: 'The team reviewed the complete report. '.repeat(500),
  html: '<p>The team reviewed the complete report.</p>' }

test('reading history restores full snapshots and text anchors after a restart', () => fixture((directory) => {
  const history = createReadingHistory(directory)
  const saved = history.save(ARTICLE)
  assert.ok(saved.text.length > 12000)
  const snapshot = readFileSync(join(directory, 'reading-history.json'), 'utf8')
  const position = { offset: 14000, top: 8.5, progress: 0.7 }
  assert.equal(history.savePosition(saved.historyId, position), true)
  assert.equal(readFileSync(join(directory, 'reading-history.json'), 'utf8'), snapshot,
    'saving a reading position must not rewrite the complete article snapshots')
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'reading-positions.json'), 'utf8'))[saved.historyId], position)
  const restarted = createReadingHistory(directory)
  assert.deepEqual(restarted.restore(saved.historyId), { ...ARTICLE, historyId: saved.historyId, readingPosition: position })
  const [summary] = restarted.list()
  assert.equal(summary.id, saved.historyId)
  assert.equal(summary.progress, 0.7)
  assert.ok(!Object.hasOwn(summary, 'html'), 'history summaries should not transfer complete HTML')
  assert.ok(summary.excerpt.length <= 180)
}))

test('URL duplicates update the saved snapshot and preserve positions only for identical text', () => fixture((directory) => {
  let clock = 10
  const history = createReadingHistory(directory, { now: () => clock++ })
  const first = history.save(ARTICLE)
  const position = { offset: 100, top: 20, progress: 0.1 }
  history.savePosition(first.historyId, position)
  const same = history.save({ ...ARTICLE, id: 'new-html-version', url: `${ARTICLE.url}#section` })
  assert.equal(same.historyId, first.historyId)
  assert.deepEqual(same.readingPosition, position)
  const changed = history.save({ ...ARTICLE, id: 'content-version-2', text: `${ARTICLE.text}Added an ending.` })
  assert.equal(changed.historyId, first.historyId)
  assert.equal(changed.readingPosition, null)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'reading-positions.json'), 'utf8')), {})
  assert.equal(history.list().length, 1)
  assert.equal(history.list()[0].importedAt, 10)
  assert.ok(history.list()[0].lastOpenedAt > 10)
}))

test('pasted text is saved and repeated visits sort by most recently opened', () => fixture((directory) => {
  let clock = 100
  const history = createReadingHistory(directory, { now: () => clock++ })
  const web = history.save(ARTICLE)
  const pasted = history.save({ id: 'paste-1', kind: 'pasted_text', title: 'Pasted text', text: 'A pasted passage.' })
  assert.equal(history.list()[0].id, pasted.historyId)
  history.restore(web.historyId)
  assert.equal(history.list()[0].id, web.historyId)
  const again = history.save({ id: 'paste-2', kind: 'pasted_text', text: 'A pasted passage.' })
  assert.equal(again.historyId, pasted.historyId)
  assert.equal(history.list().length, 2)
  assert.equal(createReadingHistory(directory).restore(again.historyId).text, 'A pasted passage.')
}))

test('deleting and clearing survive restarts and stale position writes cannot recreate entries', () => fixture((directory) => {
  const history = createReadingHistory(directory)
  const saved = history.save(ARTICLE)
  history.savePosition(saved.historyId, { offset: 100 })
  history.remove(saved.historyId)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'reading-positions.json'), 'utf8')), {})
  assert.equal(history.savePosition(saved.historyId, { offset: 10 }), false)
  assert.equal(history.restore(saved.historyId), null)
  assert.deepEqual(createReadingHistory(directory).list(), [])
  const second = history.save(ARTICLE)
  history.savePosition(second.historyId, { offset: 200 })
  history.clear()
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'reading-positions.json'), 'utf8')), {})
  assert.equal(history.savePosition(second.historyId, { offset: 10 }), false)
  assert.deepEqual(createReadingHistory(directory).list(), [])
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'reading-history.json'), 'utf8')), [])
}))

test('invalid content does not create history and damaged history can be replaced', () => fixture((directory) => {
  writeFileSync(join(directory, 'reading-history.json'), '{broken')
  const history = createReadingHistory(directory)
  assert.deepEqual(history.list(), [])
  assert.throws(() => history.save({ ...ARTICLE, text: '' }))
  assert.throws(() => history.save({ ...ARTICLE, url: 'javascript:bad()' }))
  assert.deepEqual(history.list(), [])
  const saved = history.save(ARTICLE)
  assert.equal(createReadingHistory(directory).list()[0].id, saved.historyId)
  assert.equal(history.savePosition(saved.historyId, { offset: -10 }), false)
}))

test('legacy inline positions migrate to the small positions file when an article is opened', () => fixture((directory) => {
  const position = { offset: 1000, top: 12, progress: 0.2 }
  writeFileSync(join(directory, 'reading-history.json'), JSON.stringify([
    { id: 'legacy-article', article: ARTICLE, importedAt: 100, lastOpenedAt: 200, position },
  ]))
  const history = createReadingHistory(directory)
  assert.equal(history.list()[0].progress, 0.2)
  assert.deepEqual(history.restore('legacy-article').readingPosition, position)
  assert.deepEqual(createReadingHistory(directory).restore('legacy-article').readingPosition, position)
  const [snapshot] = JSON.parse(readFileSync(join(directory, 'reading-history.json'), 'utf8'))
  assert.equal(Object.hasOwn(snapshot, 'position'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'reading-positions.json'), 'utf8'))['legacy-article'], position)
}))
