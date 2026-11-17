import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RATE_LIMIT_RETRIES, isRateLimited, planRetry, sleepAbortable } from '../src/retry-policy.js'

test('isRateLimited only matches 429', () => {
  assert.equal(isRateLimited(429), true)
  assert.equal(isRateLimited(500), false)
  assert.equal(isRateLimited(401), false)
  assert.equal(isRateLimited(200), false)
  assert.equal(isRateLimited(undefined), false)
})

test('planRetry honors Retry-After seconds including zero', () => {
  assert.deepEqual(planRetry({ status: 429, attempt: 0, retryAfter: '2' }),
    { retry: true, delayMs: 2000 })
  assert.deepEqual(planRetry({ status: 429, attempt: 0, retryAfter: '0' }),
    { retry: true, delayMs: 0 })
})

test('planRetry applies exponential backoff when Retry-After is absent or invalid', () => {
  assert.deepEqual(planRetry({ status: 429, attempt: 0 }), { retry: true, delayMs: 400 })
  assert.deepEqual(planRetry({ status: 429, attempt: 1 }), { retry: true, delayMs: 800 })
  assert.deepEqual(planRetry({ status: 429, attempt: 0, retryAfter: 'garbage' }),
    { retry: true, delayMs: 400 })
})

test('planRetry respects the retry cap and never retries other statuses', () => {
  assert.equal(planRetry({ status: 429, attempt: MAX_RATE_LIMIT_RETRIES }).retry, false)
  assert.equal(planRetry({ status: 429, attempt: 99 }).retry, false)
  assert.equal(planRetry({ status: 500, attempt: 0 }).retry, false)
  assert.equal(planRetry({ status: 200, attempt: 0 }).retry, false)
  assert.equal(planRetry({ status: 429, attempt: -1 }).retry, false)
})

test('planRetry caps Retry-After at the configured maximum', () => {
  const result = planRetry({ status: 429, attempt: 0, retryAfter: '9999' })
  assert.equal(result.retry, true)
  assert.equal(result.delayMs, 8000)
})

test('sleepAbortable resolves early when the signal aborts', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = sleepAbortable(5000, controller.signal)
  controller.abort()
  await pending
  assert.ok(Date.now() - started < 1000)
  await sleepAbortable(0, controller.signal)
})
