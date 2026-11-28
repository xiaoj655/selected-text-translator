import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReadingHistory } from '../src/reading-history.js'

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'stt-reading-history-'))
  try { await run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

const ARTICLE = { id: 'content-version-1', kind: 'web_article', title: 'A complete article', source: 'publisher.example',
  url: 'https://publisher.example/story', text: 'The team reviewed the complete report. '.repeat(500),
  html: '<p>The team reviewed the complete report.</p>' }
const FEED_ARTICLE = { id: 'feed-story', title: 'A report in the feed', source: 'Example RSS', url: ARTICLE.url,
  feedHasBody: true, text: 'The committee published an update.', html: '<p>The committee published an update.</p>' }

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

test('opening a feed article preserves its original snapshot and position across refreshes and restarts', () => fixture((directory) => {
  let clock = 100
  const history = createReadingHistory(directory, { now: () => clock++ })
  const url = 'http://publisher.example/story'
  const saved = history.openFeed({ ...FEED_ARTICLE, url })
  assert.equal(saved.kind, 'feed_article')
  assert.equal(saved.id, `feed-history-${saved.historyId}`)
  assert.equal(saved.html, FEED_ARTICLE.html)
  const position = { offset: 28, top: 12, progress: 0.5 }
  assert.equal(history.savePosition(saved.historyId, position, saved.id), true)
  history.save(ARTICLE)
  assert.notEqual(history.list()[0].id, saved.historyId)
  const refreshed = history.openFeed({ ...FEED_ARTICLE, url: `${url}#section`, text: 'Updated feed text.' })
  assert.deepEqual(refreshed, { ...saved, readingPosition: position })
  assert.equal(history.list()[0].id, saved.historyId)
  assert.equal(history.list().length, 2)
  assert.deepEqual(createReadingHistory(directory).restore(saved.historyId), refreshed)
}))

test('feed summaries only reopen an existing snapshot and never create a history entry', () => fixture((directory) => {
  const history = createReadingHistory(directory)
  const summary = { ...FEED_ARTICLE, feedHasBody: false, text: 'A short summary.' }
  assert.equal(history.openFeed(summary), null)
  assert.deepEqual(history.list(), [])
  const fromWeb = history.save(ARTICLE)
  assert.deepEqual(history.openFeed(summary), fromWeb)
  assert.equal(history.list().length, 1)
}))

test('importing a full web article upgrades the feed snapshot and rejects writes from the old snapshot', () => fixture((directory) => {
  const history = createReadingHistory(directory)
  const feed = history.openFeed(FEED_ARTICLE)
  const position = { offset: 28, top: 12, progress: 0.5 }
  assert.equal(history.savePosition(feed.historyId, position, feed.id), true)
  const fromWeb = history.save(ARTICLE)
  assert.equal(fromWeb.historyId, feed.historyId)
  assert.equal(fromWeb.readingPosition, null)
  assert.equal(history.savePosition(feed.historyId, position, feed.id), false)
  assert.equal(history.list().length, 1)
  assert.deepEqual(history.openFeed(FEED_ARTICLE), fromWeb)
}))

test('reloading a saved feed article replaces its HTML in place and keeps the reading position', () => fixture(async (directory) => {
  let clock = 100
  const history = createReadingHistory(directory, { now: () => clock++ })
  const url = 'http://publisher.example/story'
  const publishedAt = '2026-11-28T09:00:00.000Z'
  const saved = history.openFeed({ ...FEED_ARTICLE, url, publishedAt })
  const position = { offset: 10, top: 12, progress: 0.25 }
  history.savePosition(saved.historyId, position, saved.id)
  const fromWeb = history.save(ARTICLE)
  const before = history.list()
  const html = '<img src="stt-media://asset/?url=https%3A%2F%2Fpublisher.example%2Fchart.png">' + saved.html
  const fetched = { ...ARTICLE, text: saved.text, html, mediaReferrer: 'https://redirected-publisher.com/story?private=1',
    mediaReferrerPolicy: 'same-origin' }
  const refreshed = await history.reload(saved.historyId, (requestedUrl) => {
    assert.equal(requestedUrl, url)
    return fetched
  })
  assert.equal(refreshed.historyId, saved.historyId)
  assert.notEqual(refreshed.id, fromWeb.id)
  assert.deepEqual(await history.reload(saved.historyId, () => fetched), refreshed)
  assert.equal(refreshed.url, url)
  assert.equal(refreshed.mediaReferrer, 'https://redirected-publisher.com/')
  assert.equal(refreshed.mediaReferrerPolicy, 'same-origin')
  assert.equal(refreshed.kind, saved.kind)
  assert.equal(refreshed.publishedAt, publishedAt)
  assert.equal(refreshed.html, html)
  assert.deepEqual(refreshed.readingPosition, position)
  assert.deepEqual(history.list().map(({ id, importedAt, lastOpenedAt }) => ({ id, importedAt, lastOpenedAt })),
    before.map(({ id, importedAt, lastOpenedAt }) => ({ id, importedAt, lastOpenedAt })))
  assert.deepEqual(createReadingHistory(directory).restore(saved.historyId), refreshed)
}))

test('a saved feed keeps its explicit media opt-out across restart', () => fixture((directory) => {
  const history = createReadingHistory(directory)
  const saved = history.openFeed({ ...FEED_ARTICLE, mediaReferrer: '' })
  assert.equal(createReadingHistory(directory).restore(saved.historyId).mediaReferrer, '')
}))

test('reloading uses the latest reading anchor and locates it in the new text', () => fixture(async (directory) => {
  const history = createReadingHistory(directory)
  const anchor = 'The publisher included a uniquely identifying passage at this point in the article.'
  const text = `${ARTICLE.text}${anchor}${ARTICLE.text}`
  const saved = history.save({ ...ARTICLE, text })
  const response = Promise.withResolvers()
  const reloading = history.reload(saved.historyId, () => response.promise)
  const offset = text.indexOf(anchor) + 18
  const position = { offset, top: 12, progress: offset / text.length }
  history.savePosition(saved.historyId, position, saved.id)
  const prefix = 'New introduction at the start of the article. '
  const updatedText = `${prefix}${text}`
  response.resolve({ ...ARTICLE, id: 'content-version-2', text: updatedText })
  const refreshed = await reloading
  assert.deepEqual(refreshed.readingPosition, { ...position, offset: offset + prefix.length,
    progress: (offset + prefix.length) / updatedText.length })
  assert.equal(history.savePosition(saved.historyId, position, saved.id), false)
  assert.deepEqual(createReadingHistory(directory).restore(saved.historyId), refreshed)
}))

test('failed or stale reloads preserve existing snapshots and cannot recreate deleted entries', () => fixture(async (directory) => {
  const history = createReadingHistory(directory)
  const saved = history.openFeed(FEED_ARTICLE)
  const position = { offset: 10, top: 12, progress: 0.25 }
  history.savePosition(saved.historyId, position, saved.id)
  await assert.rejects(history.reload(saved.historyId, () => { throw new Error('Source unavailable') }), /Source unavailable/u)
  await assert.rejects(history.reload(saved.historyId, () => ({ ...ARTICLE, text: '' })), /Couldn’t save/u)
  assert.deepEqual(createReadingHistory(directory).restore(saved.historyId), { ...saved, readingPosition: position })

  const pendingImport = Promise.withResolvers()
  const reloadDuringImport = history.reload(saved.historyId, () => pendingImport.promise)
  const imported = history.save(ARTICLE)
  pendingImport.resolve({ ...ARTICLE, id: 'stale-preview', text: 'Old content from the source.' })
  assert.equal(await reloadDuringImport, null)
  assert.deepEqual(createReadingHistory(directory).restore(saved.historyId), imported)

  const pendingRemoval = Promise.withResolvers()
  const reloadDuringRemoval = history.reload(saved.historyId, () => pendingRemoval.promise)
  history.remove(saved.historyId)
  pendingRemoval.resolve(ARTICLE)
  assert.equal(await reloadDuringRemoval, null)
  assert.deepEqual(createReadingHistory(directory).list(), [])
}))

test('a failed reload snapshot write preserves the stored article and position', () => fixture(async (directory) => {
  const history = createReadingHistory(directory)
  const saved = history.save(ARTICLE)
  const position = { offset: 110, top: 12, progress: 0.25 }
  history.savePosition(saved.historyId, position, saved.id)
  const blocked = join(directory, 'reading-history.json.tmp')
  mkdirSync(blocked)
  await assert.rejects(history.reload(saved.historyId, () => ({ ...ARTICLE, text: 'A shorter updated article.' })), { code: 'EISDIR' })
  assert.equal(history.list()[0].progress, position.progress)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'reading-positions.json'), 'utf8'))[saved.historyId], position)
  rmSync(blocked, { recursive: true })
  assert.deepEqual(createReadingHistory(directory).restore(saved.historyId), { ...saved, readingPosition: position })
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
