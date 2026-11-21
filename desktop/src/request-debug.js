const MAX_ENTRIES = 30
const MAX_BODY_LENGTH = 48_000
const REDACTED = '[redacted]'
const VISIBLE_HEADERS = new Set(['accept', 'content-type', 'x-dashscope-sse'])

function credentialVariants(value) {
  if (!value) return []
  const escaped = JSON.stringify(value).slice(1, -1)
  const encoded = encodeURIComponent(value.toWellFormed())
  return [value, escaped, encoded, encoded.replace(/%[\dA-F]{2}/gu, (byte) => byte.toLowerCase())]
}

function redactBody(body, redact) {
  if (typeof body !== 'string') return null
  try {
    return JSON.stringify(JSON.parse(body), (_key, value) => {
      if (typeof value === 'string') return redact(value)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), item]))
    })
  } catch {
    return redact(body)
  }
}

function snapshotRequest(input, init, configuredSecrets) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) return null
  const headers = new Headers(init.headers)
  const secrets = [...configuredSecrets, url.username, url.password]
  for (const [name, value] of headers) {
    if (!VISIBLE_HEADERS.has(name)) {
      secrets.push(value, value.replace(/^(?:Basic|Bearer)\s+/iu, ''))
    }
  }
  const query = new URLSearchParams()
  for (const [name, value] of url.searchParams) {
    const publicVersion = name === 'api-version' && /^\d{4}-\d{2}-\d{2}(?:-preview)?$/u.test(value)
    query.append(name, publicVersion ? value : REDACTED)
  }
  url.search = query.toString()
  url.username = ''
  url.password = ''
  url.hash = ''

  const variants = [...new Set(secrets.flatMap(credentialVariants))].sort((a, b) => b.length - a.length)
  const secretPattern = variants.length
    ? new RegExp(variants.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
    : null
  const redact = (value) => secretPattern ? value.replace(secretPattern, REDACTED) : value
  const body = redactBody(init.body, redact)
  return {
    method: String(init.method || 'GET').toUpperCase(),
    url: redact(url.href).slice(0, 4096),
    headers: Object.fromEntries([...headers].map(([name, value]) => [
      redact(name), VISIBLE_HEADERS.has(name) ? redact(value) : REDACTED,
    ])),
    body: body?.slice(0, MAX_BODY_LENGTH) ?? null,
    truncated: (body?.length ?? 0) > MAX_BODY_LENGTH,
  }
}

export function createRequestDebug({ notify = () => {}, fetcher = (...args) => globalThis.fetch(...args) } = {}) {
  const entries = []
  const credentials = new Map()
  let enabled = false
  let nextId = 0

  function publish() {
    try {
      notify()
    } catch {
      // The workbench may have closed while a request was pending.
    }
  }

  function getState() {
    return { enabled, entries: structuredClone(entries) }
  }

  function clear() {
    entries.length = 0
    publish()
    return getState()
  }

  function setEnabled(flag) {
    if (enabled === (flag === true)) return getState()
    enabled = flag === true
    return clear()
  }

  function setCredential(key, value) {
    const secret = typeof value === 'string' ? value.trim() : ''
    if (secret) credentials.set(key, secret)
    else credentials.delete(key)
  }

  function finish(entry, started, outcome, status) {
    if (!entries.includes(entry)) return
    entry.status = status
    entry.outcome = outcome
    entry.durationMs = Math.round(performance.now() - started)
    publish()
  }

  function forKind(kind) {
    return async (input, init = {}) => {
      if (!enabled) return fetcher(input, init)
      let request
      try {
        request = snapshotRequest(input, init, credentials.values())
      } catch {
        // An unsupported request cannot interfere with the provider call.
      }
      if (!request) return fetcher(input, init)

      const entry = {
        id: ++nextId, kind, timestamp: Date.now(), ...request,
        outcome: 'pending', status: null, durationMs: null,
      }
      entries.unshift(entry)
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
      publish()

      const started = performance.now()
      try {
        const response = await fetcher(input, init)
        finish(entry, started, 'response', response.status)
        return response
      } catch (error) {
        finish(entry, started, init.signal?.aborted ? 'aborted' : 'error', null)
        throw error
      }
    }
  }

  return { clear, forKind, getState, setCredential, setEnabled }
}
