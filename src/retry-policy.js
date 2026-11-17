export const MAX_RATE_LIMIT_RETRIES = 2
const RETRY_BASE_MS = 400
const RETRY_CAP_MS = 4000
const RETRY_AFTER_CAP_MS = 8000

export function isRateLimited(status) {
  return status === 429
}

function parseRetryAfter(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(RETRY_AFTER_CAP_MS, seconds * 1000))
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, Math.min(RETRY_AFTER_CAP_MS, date - now))
  return null
}

export function planRetry({ status, attempt, retryAfter, now = Date.now() } = {}) {
  if (!isRateLimited(status)) return { retry: false, delayMs: 0 }
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_RATE_LIMIT_RETRIES) {
    return { retry: false, delayMs: 0 }
  }
  const parsed = parseRetryAfter(retryAfter, now)
  const delayMs = parsed !== null ? parsed : Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt)
  return { retry: true, delayMs }
}

export function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
