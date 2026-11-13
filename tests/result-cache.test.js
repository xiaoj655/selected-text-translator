import test from 'node:test'
import assert from 'node:assert/strict'
import { createResultCache, createResultCacheKey } from '../src/result-cache.js'

const FIRST_KEY = 'a'.repeat(64)
const SECOND_KEY = 'b'.repeat(64)
const THIRD_KEY = 'c'.repeat(64)
const SUCCESS = { status: 'success', text: 'A useful explanation.' }

function createIdentity(overrides = {}) {
  return {
    kind: 'translate',
    endpoint: 'https://provider.example/v1/chat/completions',
    apiKey: 'test-only-key',
    requestBody: { model: 'test-model', messages: [{ role: 'user', content: 'Read this word.' }] },
    context: 'Read this word. Read this word.',
    contextStart: 10,
    contextEnd: 14,
    ...overrides,
  }
}

test('cache keys are SHA-256 hex and canonicalize request object property order', async () => {
  const key = await createResultCacheKey(createIdentity())
  const reorderedKey = await createResultCacheKey(createIdentity({
    requestBody: { messages: [{ content: 'Read this word.', role: 'user' }], model: 'test-model' },
  }))
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(reorderedKey, key)
  assert.equal(await createResultCacheKey(createIdentity({
    endpoint: ' https://provider.example/v1/chat/completions ',
  })), key)
})

test('cache identity includes provider, credential, model, prompt, kind, and context position', async () => {
  const identity = createIdentity()
  const key = await createResultCacheKey(identity)
  const variants = [
    { endpoint: 'https://another.example/v1/chat/completions' },
    { apiKey: 'another-test-only-key' },
    { requestBody: { ...identity.requestBody, model: 'another-model' } },
    { requestBody: { ...identity.requestBody, messages: [{ role: 'user', content: 'Another prompt.' }] } },
    { kind: 'pronunciation' },
    { context: 'Another context.' },
    { contextStart: 26 },
    { contextEnd: 30 },
  ]
  for (const variant of variants) {
    assert.notEqual(await createResultCacheKey(createIdentity(variant)), key)
  }
})

test('cache identity bounds context to 2400 characters and normalizes absent positions', async () => {
  const context = '汉'.repeat(2400)
  const key = await createResultCacheKey(createIdentity({ context }))
  assert.equal(await createResultCacheKey(createIdentity({ context: `${context}discarded` })), key)
  assert.notEqual(await createResultCacheKey(createIdentity({ context: `${'汉'.repeat(2399)}字` })), key)
  assert.equal(
    await createResultCacheKey(createIdentity({ contextStart: undefined, contextEnd: undefined })),
    await createResultCacheKey(createIdentity({ contextStart: null, contextEnd: Number.NaN })),
  )
})

test('invalid cache identities fail with a sanitized error', async () => {
  const requestBody = { sensitive: 'test-only-secret' }
  requestBody.cycle = requestBody
  await assert.rejects(createResultCacheKey(createIdentity({ requestBody })), {
    message: 'Unable to create result cache key.',
  })
})

test('successful values are independent JSON snapshots on both set and get', () => {
  const cache = createResultCache()
  const value = { status: 'success', reading: { hints: ['first'] } }
  assert.equal(cache.set(FIRST_KEY, value), true)
  value.reading.hints.push('original mutation')
  const result = cache.get(FIRST_KEY)
  result.reading.hints.push('returned mutation')
  assert.deepEqual(cache.get(FIRST_KEY), { status: 'success', reading: { hints: ['first'] } })
})

test('cache expires at TTL without extending lifetime on a read', () => {
  let timestamp = 100
  const cache = createResultCache({ ttlMs: 50, now: () => timestamp })
  cache.set(FIRST_KEY, SUCCESS)
  timestamp = 149
  assert.deepEqual(cache.get(FIRST_KEY), SUCCESS)
  timestamp = 150
  assert.equal(cache.get(FIRST_KEY), undefined)
  assert.deepEqual(cache.getStats(), { entries: 0, bytes: 0 })
})

test('setting a new success resets the TTL and storage size', () => {
  let timestamp = 100
  const cache = createResultCache({ ttlMs: 50, now: () => timestamp })
  cache.set(FIRST_KEY, SUCCESS)
  timestamp = 140
  const replacement = { status: 'success', text: 'new' }
  cache.set(FIRST_KEY, replacement)
  timestamp = 150
  assert.deepEqual(cache.get(FIRST_KEY), replacement)
  assert.deepEqual(cache.getStats(), { entries: 1, bytes: Buffer.byteLength(JSON.stringify(replacement)) })
  timestamp = 190
  assert.equal(cache.get(FIRST_KEY), undefined)
})

test('entry count evicts the least recently read value', () => {
  const cache = createResultCache({ maxEntries: 2 })
  cache.set(FIRST_KEY, SUCCESS)
  cache.set(SECOND_KEY, SUCCESS)
  cache.get(FIRST_KEY)
  cache.set(THIRD_KEY, SUCCESS)
  assert.equal(cache.get(SECOND_KEY), undefined)
  assert.deepEqual(cache.get(FIRST_KEY), SUCCESS)
  assert.deepEqual(cache.get(THIRD_KEY), SUCCESS)
  assert.equal(cache.getStats().entries, 2)
})

test('setting an existing key refreshes its LRU position', () => {
  const cache = createResultCache({ maxEntries: 2 })
  cache.set(FIRST_KEY, SUCCESS)
  cache.set(SECOND_KEY, SUCCESS)
  cache.set(FIRST_KEY, { status: 'success', text: 'Updated' })
  cache.set(THIRD_KEY, SUCCESS)
  assert.equal(cache.get(SECOND_KEY), undefined)
  assert.equal(cache.get(FIRST_KEY).text, 'Updated')
})

test('UTF-8 byte budget evicts LRU entries and rejects oversized individual results', () => {
  const value = { status: 'success', text: '中文' }
  const size = Buffer.byteLength(JSON.stringify(value))
  const cache = createResultCache({ maxBytes: size * 2 })
  cache.set(FIRST_KEY, value)
  cache.set(SECOND_KEY, value)
  cache.get(FIRST_KEY)
  cache.set(THIRD_KEY, value)
  assert.equal(cache.get(SECOND_KEY), undefined)
  assert.deepEqual(cache.getStats(), { entries: 2, bytes: size * 2 })
  assert.equal(cache.set(SECOND_KEY, { status: 'success', text: '字'.repeat(size) }), false)
  assert.deepEqual(cache.getStats(), { entries: 2, bytes: size * 2 })
})

test('byte budget can evict multiple entries for a larger success', () => {
  const small = { status: 'success' }
  const smallSize = Buffer.byteLength(JSON.stringify(small))
  const large = { status: 'success', text: 'x'.repeat(smallSize) }
  const largeSize = Buffer.byteLength(JSON.stringify(large))
  const cache = createResultCache({ maxBytes: largeSize })
  cache.set(FIRST_KEY, small)
  cache.set(SECOND_KEY, small)
  assert.equal(cache.getStats().entries, 2)
  assert.equal(cache.set(THIRD_KEY, large), true)
  assert.equal(cache.get(FIRST_KEY), undefined)
  assert.equal(cache.get(SECOND_KEY), undefined)
  assert.deepEqual(cache.get(THIRD_KEY), large)
  assert.deepEqual(cache.getStats(), { entries: 1, bytes: largeSize })
})

test('expired entries are removed before enforcing count and byte limits', () => {
  let timestamp = 0
  const cache = createResultCache({ maxEntries: 2, ttlMs: 10, now: () => timestamp })
  cache.set(FIRST_KEY, SUCCESS)
  timestamp = 5
  cache.set(SECOND_KEY, SUCCESS)
  cache.get(FIRST_KEY)
  timestamp = 10
  cache.set(THIRD_KEY, SUCCESS)
  assert.equal(cache.get(FIRST_KEY), undefined)
  assert.deepEqual(cache.get(SECOND_KEY), SUCCESS)
  assert.deepEqual(cache.get(THIRD_KEY), SUCCESS)
  timestamp = 20
  assert.deepEqual(cache.getStats(), { entries: 0, bytes: 0 })
})

test('errors, streams, malformed values, and invalid keys never enter the cache', () => {
  const cache = createResultCache()
  const circular = { status: 'success' }
  circular.circular = circular
  const invalidValues = [
    null,
    undefined,
    'success',
    {},
    { status: 'error', error: 'Request failed.' },
    { status: 'stream', text: 'Partial' },
    { status: 'started' },
    { status: 'success', value: 1n },
    { status: 'success', toJSON: () => 'invalid' },
    { get status() { throw new Error('Invalid status getter.') } },
    circular,
  ]
  for (const value of invalidValues) assert.equal(cache.set(FIRST_KEY, value), false)
  assert.equal(cache.set('raw selection text', SUCCESS), false)
  assert.equal(cache.set(null, SUCCESS), false)
  assert.equal(cache.get('raw selection text'), undefined)
  assert.deepEqual(cache.getStats(), { entries: 0, bytes: 0 })
})

test('zero limits disable caching', () => {
  for (const options of [{ maxEntries: 0 }, { maxBytes: 0 }, { ttlMs: 0 }]) {
    const cache = createResultCache(options)
    assert.equal(cache.set(FIRST_KEY, SUCCESS), false)
    assert.equal(cache.get(FIRST_KEY), undefined)
  }
})

test('delete and clear release all stored bytes', () => {
  const cache = createResultCache()
  cache.set(FIRST_KEY, SUCCESS)
  cache.set(SECOND_KEY, SUCCESS)
  assert.equal(cache.delete(FIRST_KEY), true)
  assert.equal(cache.delete(FIRST_KEY), false)
  assert.equal(cache.get(FIRST_KEY), undefined)
  assert.equal(cache.getStats().entries, 1)
  cache.clear()
  assert.equal(cache.get(SECOND_KEY), undefined)
  assert.deepEqual(cache.getStats(), { entries: 0, bytes: 0 })
})
