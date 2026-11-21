import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestDebug } from '../desktop/src/request-debug.js'

test('request debugging is opt-in and redacts credentials without altering the provider call', async () => {
  const calls = []
  const response = new Response(null, { status: 429 })
  const debug = createRequestDebug({ fetcher: async (...args) => { calls.push(args); return response } })
  const send = debug.forKind('translation')
  const configuredKey = 'configured-"test"/key'
  const outgoingKey = 'unsaved-request-key'
  debug.setCredential('api_key', configuredKey)
  const url = `https://private-user:private-password@provider.example/v1/${encodeURIComponent(configuredKey)}?token=first-secret&token=second-secret&other=third-secret&api-version=2024-10-01-preview#private-fragment`
  const init = {
    method: 'POST',
    headers: { AUTHORIZATION: `Bearer ${outgoingKey}`, 'X-API-Key': 'custom-header-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'example-model', stream: false,
      messages: [{ role: 'user', content: JSON.stringify({ text: `Keep this ${configuredKey} ${outgoingKey}` }) }],
    }),
  }
  assert.equal(await send(url, init), response)
  assert.deepEqual(debug.getState(), { enabled: false, entries: [] })
  debug.setEnabled(true)
  assert.equal(await send(url, init), response)
  assert.deepEqual(calls, [[url, init], [url, init]])

  const [entry] = debug.getState().entries
  const serialized = JSON.stringify(entry)
  for (const secret of [configuredKey, encodeURIComponent(configuredKey), outgoingKey, 'custom-header-key',
    'private-user', 'private-password', 'first-secret', 'second-secret', 'third-secret', 'private-fragment']) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.deepEqual(entry.headers, {
    authorization: '[redacted]', 'content-type': 'application/json', 'x-api-key': '[redacted]',
  })
  assert.deepEqual([...new URL(entry.url).searchParams], [
    ['token', '[redacted]'], ['token', '[redacted]'], ['other', '[redacted]'], ['api-version', '2024-10-01-preview'],
  ])
  assert.deepEqual(JSON.parse(entry.body), {
    model: 'example-model', stream: false,
    messages: [{ role: 'user', content: '{"text":"Keep this [redacted] [redacted]"}' }],
  })
  assert.equal(entry.status, 429)
  assert.equal(entry.outcome, 'response')
  assert.ok(entry.durationMs >= 0)
})

test('clearing or disabling removes pending records and outcome updates cannot restore them', async () => {
  let complete
  let updates = 0
  const debug = createRequestDebug({
    notify: () => { updates += 1 },
    fetcher: (_url, { signal }) => new Promise((resolve, reject) => {
      complete = resolve
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const send = debug.forKind('guidance')
  const url = 'https://provider.example/v1/chat/completions'
  debug.setEnabled(true)
  const first = send(url)
  assert.equal(debug.getState().entries[0].outcome, 'pending')
  assert.deepEqual(debug.clear(), { enabled: true, entries: [] })
  complete(new Response(null))
  await first
  assert.deepEqual(debug.getState().entries, [])

  const controller = new AbortController()
  const cancelled = send(url, { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(debug.getState().entries[0].outcome, 'aborted')
  const second = send(url)
  assert.deepEqual(debug.setEnabled(false), { enabled: false, entries: [] })
  complete(new Response(null))
  await second
  assert.equal(updates, 7)
  assert.deepEqual(debug.setEnabled(true).entries, [])
})

test('request capture keeps the latest 30 entries and marks truncated payloads', async () => {
  const debug = createRequestDebug({ fetcher: async () => new Response(null) })
  const send = debug.forKind('tutor')
  debug.setEnabled(true)
  for (let index = 1; index <= 31; index += 1) {
    await send(`https://provider.example/${index}`, { body: index === 31 ? 'x'.repeat(60_000) : undefined })
  }
  const { entries } = debug.getState()
  assert.equal(entries.length, 30)
  assert.equal(entries[0].id, 31)
  assert.equal(entries.at(-1).id, 2)
  assert.equal(entries[0].truncated, true)
  assert.ok(entries[0].body.length < 60_000)
  assert.equal(entries[1].body, null)
})
