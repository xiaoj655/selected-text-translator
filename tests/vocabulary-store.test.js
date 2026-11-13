import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeVocabularyEntry, getDueEntries, scheduleReview, listVocabulary,
  saveVocabulary, removeVocabulary, reviewVocabulary, exportVocabulary, importVocabulary } from '../src/vocabulary-store.js'

const NOW = 1700000000000
const DAY_MS = 86400000
const sample = { text: 'reluctant', meaning: 'Hesitant or unwilling.',
  context: 'She was reluctant to leave.', example: 'I was reluctant to accept the offer.' }

async function withStorage(callback, { shouldFailGet = false, shouldFailSet = false, initialEntries } = {}) {
  const previous = globalThis.chrome
  const storage = initialEntries ? { vocabulary_entries: structuredClone(initialEntries) } : {}
  const calls = []
  globalThis.chrome = { storage: { local: {
    async get() {
      if (shouldFailGet) throw new Error('Internal storage detail')
      await Promise.resolve()
      return structuredClone(storage)
    },
    async set(values) {
      if (shouldFailSet) throw new Error('Internal storage detail')
      await Promise.resolve()
      calls.push(structuredClone(values))
      Object.assign(storage, structuredClone(values))
    },
  } } }
  try { await callback({ storage, calls }) }
  finally { globalThis.chrome = previous }
}

test('normalization requires meaning, bounds source fields, and gives new entries a next-day review', () => {
  const entry = normalizeVocabularyEntry({ ...sample, text: ' reluctant ', context: 'x'.repeat(4000),
    sourceUrl: 'javascript:alert(1)' }, NOW)
  assert.equal(entry.text, 'reluctant')
  assert.equal(entry.context.length, 2400)
  assert.equal(entry.sourceUrl, '')
  assert.equal(entry.createdAt, NOW)
  assert.equal(entry.dueAt, NOW + DAY_MS)
  assert.equal(entry.reviewCount, 0)
  assert.throws(() => normalizeVocabularyEntry({ text: 'word', meaning: '' }, NOW), /meaning are required/)
  assert.throws(() => normalizeVocabularyEntry([], NOW), /must be an object/)
})

test('normalization preserves a valid source URL and makes the same text and meaning case-insensitive', () => {
  const first = normalizeVocabularyEntry({ ...sample, sourceUrl: 'https://example.com/read' }, NOW)
  const second = normalizeVocabularyEntry({ text: 'RELUCTANT', meaning: 'hesitant or unwilling.' }, NOW)
  assert.equal(first.id, second.id)
  assert.equal(first.sourceUrl, 'https://example.com/read')
  assert.notEqual(first.id, normalizeVocabularyEntry({ ...sample, meaning: 'Slow to move.' }, NOW).id)
})

test('review intervals progress through 1, 3, 7, 14 and 30 days, while again returns in 10 minutes', () => {
  let entry = normalizeVocabularyEntry(sample, NOW)
  for (const interval of [1, 3, 7, 14, 30, 30]) {
    entry = scheduleReview(entry, 'good', NOW)
    assert.equal(entry.intervalDays, interval)
    assert.equal(entry.dueAt, NOW + interval * DAY_MS)
  }
  const again = scheduleReview(entry, 'again', NOW)
  assert.equal(again.dueAt, NOW + 600000)
  assert.equal(again.intervalDays, 0)
  assert.equal(again.reviewCount, 7)
  assert.equal(scheduleReview(again, 'good', NOW).intervalDays, 1)
  assert.throws(() => scheduleReview(entry, 'unknown', NOW), /Choose again or good/)
})

test('due review selection sorts without changing the saved collection', () => {
  const future = normalizeVocabularyEntry(sample, NOW)
  const older = { ...future, id: 'older', dueAt: NOW - 100 }
  const due = { ...future, id: 'due', dueAt: NOW }
  const entries = [future, due, older]
  assert.deepEqual(getDueEntries(entries, NOW).map((entry) => entry.id), ['older', 'due'])
  assert.deepEqual(entries.map((entry) => entry.id), [future.id, 'due', 'older'])
  assert.deepEqual(getDueEntries(null, NOW), [])
})

test('duplicate saves retain the original learning history but different meanings remain separate', async () => {
  await withStorage(async ({ calls }) => {
    const first = await saveVocabulary(sample)
    assert.equal(first.ok, true)
    assert.equal(first.alreadySaved, false)
    const duplicate = await saveVocabulary({ text: 'RELUCTANT', meaning: 'hesitant or unwilling.' })
    assert.equal(duplicate.alreadySaved, true)
    assert.equal(duplicate.entry.id, first.entry.id)
    assert.equal(calls.length, 1)
    await saveVocabulary({ ...sample, meaning: 'A different contextual sense.' })
    assert.equal((await listVocabulary()).entries.length, 2)
  })
})

test('concurrent saves and reviews do not overwrite each other', async () => {
  await withStorage(async () => {
    const results = await Promise.all([
      saveVocabulary(sample),
      saveVocabulary({ text: 'give in', meaning: 'Stop resisting.' }),
      saveVocabulary({ text: 'subtle', meaning: 'Not easy to notice.' }),
    ])
    assert.equal(results.every((result) => result.ok), true)
    assert.equal((await listVocabulary()).entries.length, 3)
    await Promise.all(results.map((result) => reviewVocabulary(result.entry.id, 'good')))
    assert.equal((await listVocabulary()).entries.every((entry) => entry.reviewCount === 1), true)
  })
})

test('invalid save metadata cannot rewrite review progress or timestamps', async () => {
  await withStorage(async () => {
    const saved = await saveVocabulary({ ...sample, dueAt: 0, reviewCount: 500, intervalDays: 30, createdAt: 0 })
    assert.equal(saved.entry.reviewCount, 0)
    assert.equal(saved.entry.intervalDays, 0)
    assert.ok(saved.entry.createdAt > 0)
    assert.ok(saved.entry.dueAt > saved.entry.createdAt)
  })
})

test('remove and export operate only on learning entries and omit unrelated settings', async () => {
  await withStorage(async ({ storage }) => {
    storage.api_key = 'test-secret'
    const saved = await saveVocabulary(sample)
    const exported = await exportVocabulary()
    assert.equal(exported.data.version, 2)
    assert.equal(exported.data.entries.length, 1)
    assert.equal(JSON.stringify(exported).includes('test-secret'), false)
    assert.equal((await removeVocabulary(saved.entry.id)).ok, true)
    assert.equal((await listVocabulary()).entries.length, 0)
    assert.equal((await removeVocabulary(saved.entry.id)).ok, false)
  })
})

test('storage failures return useful errors without exposing raw failure details', async () => {
  await withStorage(async () => {
    const result = await listVocabulary()
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.message, /Internal/)
  }, { shouldFailGet: true })
  await withStorage(async () => {
    const result = await saveVocabulary(sample)
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.message, /Internal/)
  }, { shouldFailSet: true })
})

test('the book rejects a 2,001st unique entry while allowing an existing entry to be saved again', async () => {
  const entries = Array.from({ length: 2000 }, (_, index) => normalizeVocabularyEntry({ text: `word ${index}`,
    meaning: 'a saved sense' }, NOW))
  await withStorage(async ({ calls }) => {
    assert.equal((await saveVocabulary({ text: 'word 0', meaning: 'a saved sense' })).alreadySaved, true)
    const result = await saveVocabulary(sample)
    assert.equal(result.ok, false)
    assert.match(result.message, /book is full/)
    assert.equal(calls.length, 0)
  }, { initialEntries: entries })
})

test('saving long passages preserves the full supported selection and rejects oversized text explicitly', async () => {
  await withStorage(async () => {
    const passage = 'a'.repeat(12000)
    const saved = await saveVocabulary({ text: passage, meaning: 'a long passage' })
    assert.equal(saved.ok, true)
    assert.equal(saved.entry.text, passage)
    const oversized = await saveVocabulary({ text: `${passage}b`, meaning: 'too long' })
    assert.equal(oversized.ok, false)
    assert.match(oversized.message, /12,000/)
    assert.equal((await listVocabulary()).entries.length, 1)
  })
})

function createBackup(entries) {
  return { version: 1, exportedAt: NOW, entries }
}

test('import restores exported learning progress and strips source URL credentials', async () => {
  const entry = scheduleReview(normalizeVocabularyEntry({ ...sample,
    sourceUrl: 'https://name:password@example.com/read' }, NOW), 'good', NOW)
  await withStorage(async () => {
    const imported = await importVocabulary(createBackup([entry]))
    assert.deepEqual(imported, { ok: true, added: 1, skipped: 0 })
    const listed = (await listVocabulary()).entries[0]
    assert.equal(listed.reviewCount, 1)
    assert.equal(listed.dueAt, entry.dueAt)
    assert.equal(listed.createdAt, NOW)
    assert.equal(listed.sourceUrl, 'https://example.com/read')
    const exported = await exportVocabulary()
    assert.equal(JSON.stringify(exported).includes('password'), false)
  })
})

test('import skips duplicates without overwriting existing review history and writes once for the entire batch', async () => {
  const old = scheduleReview(normalizeVocabularyEntry(sample, NOW), 'good', NOW)
  const duplicate = { ...old, reviewCount: 99, intervalDays: 30, dueAt: 0 }
  const other = normalizeVocabularyEntry({ text: 'give in', meaning: 'Stop resisting.' }, NOW)
  await withStorage(async ({ calls }) => {
    const result = await importVocabulary(createBackup([duplicate, other, other]))
    assert.deepEqual(result, { ok: true, added: 1, skipped: 2 })
    const entries = (await listVocabulary()).entries
    assert.equal(entries.find((entry) => entry.id === old.id).reviewCount, 1)
    assert.equal(entries.find((entry) => entry.id === old.id).dueAt, old.dueAt)
    assert.equal(calls.length, 1)
  }, { initialEntries: [old] })
})

test('invalid backup entries and conflicting IDs reject the entire import without partial writes', async () => {
  const entry = normalizeVocabularyEntry(sample, NOW)
  const invalid = { ...entry, id: 'bad', text: 'invalid', meaning: '' }
  const conflicting = { ...entry, text: 'a different word', meaning: 'a different sense' }
  await withStorage(async ({ calls, storage }) => {
    assert.equal((await importVocabulary(createBackup([entry, invalid]))).ok, false)
    assert.equal((await importVocabulary(createBackup([entry, conflicting]))).ok, false)
    assert.equal(calls.length, 0)
    assert.deepEqual(storage, {})
  })
})

test('import validates backup version, limits, field types and review metadata before writing', async () => {
  const entry = normalizeVocabularyEntry(sample, NOW)
  const invalidBackups = [
    { ...createBackup([entry]), version: 3 },
    { ...createBackup([entry]), api_key: 'not-a-backup' },
    createBackup(Array.from({ length: 2001 }, () => entry)),
    createBackup([{ ...entry, reviewCount: -1 }]),
    createBackup([{ ...entry, dueAt: 'tomorrow' }]),
    createBackup([{ ...entry, intervalDays: 1000 }]),
    createBackup([{ ...entry, context: null }]),
    createBackup([{ ...entry, text: 'x'.repeat(12001) }]),
  ]
  await withStorage(async ({ calls }) => {
    for (const backup of invalidBackups) assert.equal((await importVocabulary(backup)).ok, false)
    assert.equal(calls.length, 0)
  })
})

test('concurrent import and save merge safely through the same mutation queue', async () => {
  const imported = normalizeVocabularyEntry({ text: 'give in', meaning: 'Stop resisting.' }, NOW)
  await withStorage(async () => {
    const results = await Promise.all([importVocabulary(createBackup([imported])), saveVocabulary(sample)])
    assert.equal(results.every((result) => result.ok), true)
    assert.equal((await listVocabulary()).entries.length, 2)
  })
})

test('an import exceeding the combined storage byte limit leaves the original book untouched', async () => {
  const original = Array.from({ length: 190 }, (_, index) => normalizeVocabularyEntry({
    text: `${index} ${'a'.repeat(11990)}`, meaning: 'existing sense',
  }, NOW))
  const incoming = Array.from({ length: 190 }, (_, index) => normalizeVocabularyEntry({
    text: `${index} ${'b'.repeat(11990)}`, meaning: 'imported sense',
  }, NOW))
  await withStorage(async ({ calls }) => {
    const result = await importVocabulary(createBackup(incoming))
    assert.equal(result.ok, false)
    assert.match(result.message, /book is full/)
    assert.equal(calls.length, 0)
    assert.equal((await listVocabulary()).entries.length, original.length)
  }, { initialEntries: original })
})

test('same-sense punctuation variants enrich missing learning fields without resetting progress', async () => {
  const original = scheduleReview(normalizeVocabularyEntry({ text: 'record', meaning: '记录。',
    context: 'The band will record a new record tomorrow.' }, NOW), 'good', NOW)
  await withStorage(async () => {
    const saved = await saveVocabulary({ text: 'record', meaning: '记录', usage: 'record + sound',
      context: original.context, contextStart: 14, contextEnd: 20 })
    assert.equal(saved.alreadySaved, true)
    assert.equal(saved.entry.id, original.id)
    assert.equal(saved.entry.usage, 'record + sound')
    assert.equal(saved.entry.contextStart, 14)
    assert.equal(saved.entry.reviewCount, 1)
    assert.equal(saved.entry.dueAt, original.dueAt)
    assert.equal((await listVocabulary()).entries.length, 1)
    await saveVocabulary({ text: 'record', meaning: 'a music album' })
    assert.equal((await listVocabulary()).entries.length, 2)
  }, { initialEntries: [original] })
})

test('two stale pages cannot advance the same review interval twice', async () => {
  const original = { ...normalizeVocabularyEntry(sample, NOW), dueAt: 0 }
  await withStorage(async ({ calls }) => {
    const expected = { expectedDueAt: 0, expectedReviewCount: 0 }
    const responses = await Promise.all([
      reviewVocabulary(original.id, 'good', expected),
      reviewVocabulary(original.id, 'good', expected),
    ])
    assert.equal(responses[0].ok, true)
    assert.equal(responses[1].code, 'review-changed')
    assert.equal(responses[1].entry.reviewCount, 1)
    assert.equal(responses[1].entry.intervalDays, 1)
    assert.equal(calls.length, 1)
  }, { initialEntries: [original] })
})

test('usage and exact context positions survive review and backup restoration', async () => {
  const context = 'The band will record a new record tomorrow.'
  await withStorage(async () => {
    const saved = await saveVocabulary({ text: 'record', meaning: 'a music album', context,
      contextStart: 27, contextEnd: 33, usage: 'a record by + artist' })
    const reviewed = await reviewVocabulary(saved.entry.id, 'good')
    assert.equal(reviewed.entry.contextStart, 27)
    assert.equal(reviewed.entry.contextEnd, 33)
    assert.equal(reviewed.entry.usage, 'a record by + artist')
    const backup = await exportVocabulary()
    assert.equal(backup.data.version, 2)
    const removed = await removeVocabulary(saved.entry.id)
    assert.deepEqual(removed.entry, reviewed.entry)
    assert.equal((await importVocabulary(backup.data)).added, 1)
    const restored = (await listVocabulary()).entries[0]
    assert.deepEqual(restored, reviewed.entry)
  })
})

test('version 1 backups remain readable and invalid optional metadata is rejected atomically', async () => {
  const legacy = normalizeVocabularyEntry(sample, NOW)
  delete legacy.usage
  delete legacy.contextStart
  delete legacy.contextEnd
  await withStorage(async ({ calls }) => {
    assert.equal((await importVocabulary(createBackup([legacy]))).ok, true)
    const restored = (await listVocabulary()).entries[0]
    assert.equal(restored.usage, '')
    assert.equal(restored.contextStart, null)
    const invalid = [
      { ...restored, usage: null },
      { ...restored, contextStart: 0, contextEnd: 4 },
      { ...restored, contextStart: 1.5, contextEnd: 5 },
      { ...restored, contextStart: null, contextEnd: 5 },
    ]
    for (const entry of invalid) assert.equal((await importVocabulary(createBackup([entry]))).ok, false)
    assert.equal(calls.length, 1)
  })
})
