import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverProviderModels, getModelsEndpoint } from '../src/provider-diagnostics.js'

test('model discovery normalizes compatible base URLs without query secrets', () => {
  assert.equal(getModelsEndpoint('https://example.com/v1/chat/completions?token=hidden'), 'https://example.com/v1/models')
  assert.equal(getModelsEndpoint('https://example.com/v1/'), 'https://example.com/v1/models')
  assert.throws(() => getModelsEndpoint('file:///tmp/models'), /HTTP/)
})

test('model discovery validates the response and never exposes raw API errors', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ data: [{ id: 'qwen-mt-flash' }, { id: 'generic' }, { id: 'generic' }, {}] })
    assert.deepEqual(await discoverProviderModels({ baseUrl: 'https://example.com/v1', apiKey: 'test' }), {
      ok: true, models: ['generic', 'qwen-mt-flash'],
    })
    globalThis.fetch = async () => new Response('upstream echoed a secret', { status: 401 })
    const failure = await discoverProviderModels({ baseUrl: 'https://example.com/v1', apiKey: 'test' })
    assert.equal(failure.ok, false)
    assert.doesNotMatch(failure.message, /secret/)
    assert.equal((await discoverProviderModels({ baseUrl: 'https://example.com/v1' })).ok, false)
  } finally { globalThis.fetch = originalFetch }
})
