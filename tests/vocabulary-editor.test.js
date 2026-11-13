import assert from 'node:assert/strict'
import test from 'node:test'
import { createVocabularyDraft, getVocabularyDraftUpdate, serializeVocabularyDraft,
  setVocabularyDraftField, syncVocabularyDraft, VOCABULARY_EDIT_FIELDS } from '../src/vocabulary-editor.js'

const entry = Object.freeze({
  id: 'saved-expression',
  text: 'take it in',
  meaning: 'To understand and absorb something.',
  usage: 'take in + information',
  example: 'Give yourself time to take it in.',
  explanation: 'Here, it refers to understanding new information.',
  phonetic: '/teɪk ɪt ɪn/',
  context: 'There was too much news to take it in at once.',
  sourceUrl: 'https://example.com/reading',
  reviewCount: 6,
  dueAt: 123456789,
})

test('a vocabulary draft keeps a separate editable baseline without changing the saved entry', () => {
  const draft = createVocabularyDraft(entry)
  const updated = setVocabularyDraftField(draft, 'meaning', 'A clearer explanation.')
  assert.equal(updated.values.meaning, 'A clearer explanation.')
  assert.equal(updated.original.meaning, entry.meaning)
  assert.equal(draft.values.meaning, entry.meaning)
  assert.equal(entry.meaning, 'To understand and absorb something.')
  assert.equal(updated.latestEntry.reviewCount, 6)
  assert.equal(updated.latestEntry.dueAt, 123456789)
})

test('updates include only changed learning fields and their original values', () => {
  let draft = createVocabularyDraft(entry)
  draft = setVocabularyDraftField(draft, 'meaning', '  A clearer explanation.  ')
  draft = setVocabularyDraftField(draft, 'example', '')
  const result = getVocabularyDraftUpdate(draft)
  assert.deepEqual(result, {
    ok: true,
    hasChanges: true,
    payload: {
      id: entry.id,
      changes: { meaning: 'A clearer explanation.', example: '' },
      expected: { meaning: entry.meaning, example: entry.example },
    },
  })
  for (const key of ['text', 'context', 'sourceUrl', 'reviewCount', 'dueAt', 'id']) {
    assert.equal(key in result.payload.changes, false)
  }
})

test('unchanged and whitespace-only edits do not produce a mutation', () => {
  const draft = setVocabularyDraftField(createVocabularyDraft(entry), 'meaning', `  ${entry.meaning}\n`)
  assert.deepEqual(getVocabularyDraftUpdate(draft), {
    ok: true,
    hasChanges: false,
    payload: { id: entry.id, changes: {}, expected: {} },
  })
})

test('read-only and unknown fields cannot be added to a draft', () => {
  const draft = createVocabularyDraft(entry)
  for (const key of ['id', 'text', 'context', 'sourceUrl', 'reviewCount', 'dueAt', '__proto__']) {
    assert.equal(setVocabularyDraftField(draft, key, 'changed'), draft)
  }
})

test('meaning remains required even when a textarea contains only whitespace', () => {
  const draft = setVocabularyDraftField(createVocabularyDraft(entry), 'meaning', ' \n\t ')
  const result = getVocabularyDraftUpdate(draft)
  assert.equal(result.ok, false)
  assert.equal(result.field, 'meaning')
  assert.match(result.message, /释义/)
})

test('each field accepts its exact length limit and rejects oversize content without truncating the draft', () => {
  for (const field of VOCABULARY_EDIT_FIELDS) {
    const accepted = setVocabularyDraftField(createVocabularyDraft(entry), field.key, 'x'.repeat(field.maxLength))
    assert.equal(getVocabularyDraftUpdate(accepted).ok, true, field.key)
    const rejected = setVocabularyDraftField(accepted, field.key, 'x'.repeat(field.maxLength + 1))
    const result = getVocabularyDraftUpdate(rejected)
    assert.equal(result.ok, false, field.key)
    assert.equal(result.field, field.key)
    assert.equal(rejected.values[field.key].length, field.maxLength + 1)
  }
})

test('optional learning fields may be cleared', () => {
  let draft = createVocabularyDraft(entry)
  for (const field of VOCABULARY_EDIT_FIELDS.filter((field) => !field.isRequired)) {
    draft = setVocabularyDraftField(draft, field.key, '')
  }
  const result = getVocabularyDraftUpdate(draft)
  assert.equal(result.ok, true)
  assert.deepEqual(result.payload.changes, { usage: '', example: '', explanation: '', phonetic: '' })
})

test('storage refresh keeps unsaved input and its baseline while exposing latest content for explicit reload', () => {
  const draft = setVocabularyDraftField(createVocabularyDraft(entry), 'meaning', 'My unsaved explanation.')
  const latestEntry = { ...entry, meaning: 'Changed elsewhere.', example: 'A new saved example.' }
  const synced = syncVocabularyDraft(draft, latestEntry)
  assert.equal(synced.values.meaning, 'My unsaved explanation.')
  assert.equal(synced.values.example, entry.example)
  assert.deepEqual(synced.original, draft.original)
  assert.equal(synced.latestEntry.meaning, 'Changed elsewhere.')
  assert.equal(synced.hasExternalChanges, true)
  assert.equal(synced.isMissing, false)
  assert.deepEqual(getVocabularyDraftUpdate(synced).payload.expected, { meaning: entry.meaning })
  const reloaded = createVocabularyDraft(synced.latestEntry)
  assert.equal(reloaded.values.meaning, 'Changed elsewhere.')
  assert.equal(reloaded.values.example, 'A new saved example.')
})

test('concurrent review changes preserve draft input without reporting a learning-content change', () => {
  const draft = setVocabularyDraftField(createVocabularyDraft(entry), 'usage', 'take it all in')
  const synced = syncVocabularyDraft(draft, { ...entry, reviewCount: 7, dueAt: 987654321 })
  assert.equal(synced.hasExternalChanges, false)
  assert.equal(synced.values.usage, 'take it all in')
  assert.equal(synced.latestEntry.reviewCount, 7)
  assert.deepEqual(getVocabularyDraftUpdate(synced).payload.expected, { usage: entry.usage })
})

test('external deletion and another entry cannot replace or discard a draft', () => {
  const draft = setVocabularyDraftField(createVocabularyDraft(entry), 'example', '<script>my draft</script>')
  for (const latest of [null, { ...entry, id: 'another-entry' }]) {
    const synced = syncVocabularyDraft(draft, latest)
    assert.equal(synced.isMissing, true)
    assert.equal(synced.latestEntry, null)
    assert.deepEqual(synced.values, draft.values)
    assert.deepEqual(synced.original, draft.original)
    assert.match(serializeVocabularyDraft(synced), /<script>my draft<\/script>/)
  }
})

test('conflict state and busy state survive a background refresh without replacing input', () => {
  const draft = { ...setVocabularyDraftField(createVocabularyDraft(entry), 'meaning', 'Keep this input.'),
    code: 'entry-changed', message: 'Conflict', isSaving: true }
  const synced = syncVocabularyDraft(draft, { ...entry, meaning: 'Another definition.' })
  assert.equal(synced.code, 'entry-changed')
  assert.equal(synced.isSaving, true)
  assert.equal(synced.values.meaning, 'Keep this input.')
  assert.equal(synced.original.meaning, entry.meaning)
})

test('copying a draft includes original expression and every current editable field', () => {
  const draft = setVocabularyDraftField(createVocabularyDraft(entry), 'meaning', 'My own words.')
  const text = serializeVocabularyDraft(draft)
  assert.match(text, /^take it in\n\n/)
  assert.match(text, /在这里的意思\nMy own words\./)
  assert.match(text, /音标\n\/teɪk ɪt ɪn\//)
  assert.equal(text.includes('https://example.com'), false)
  assert.equal(serializeVocabularyDraft(null), '')
})
