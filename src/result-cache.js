const DEFAULT_MAX_ENTRIES = 32
const DEFAULT_MAX_BYTES = 1048576
const DEFAULT_TTL_MS = 300000
const MAX_CONTEXT_LENGTH = 2400
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/
const textEncoder = new TextEncoder()

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]))
}

function normalizePosition(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function createResultCacheKey({
  kind = '',
  endpoint,
  apiKey,
  requestBody,
  context,
  contextStart,
  contextEnd,
} = {}) {
  try {
    const identity = {
      kind: String(kind || ''),
      endpoint: String(endpoint || '').trim(),
      apiKey: String(apiKey || ''),
      requestBody: requestBody ?? null,
      context: String(context || '').slice(0, MAX_CONTEXT_LENGTH),
      contextStart: normalizePosition(contextStart),
      contextEnd: normalizePosition(contextEnd),
    }
    const normalized = sortJsonValue(JSON.parse(JSON.stringify(identity)))
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(JSON.stringify(normalized)))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    throw new Error('Unable to create result cache key.')
  }
}

function normalizeLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function isCacheKey(key) {
  return typeof key === 'string' && CACHE_KEY_PATTERN.test(key)
}

function serializeSuccess(value) {
  try {
    if (!value || typeof value !== 'object' || value.status !== 'success') return null
    const serialized = JSON.stringify(value)
    const parsed = JSON.parse(serialized)
    if (!parsed || typeof parsed !== 'object' || parsed.status !== 'success') return null
    return { serialized, bytes: textEncoder.encode(serialized).byteLength }
  } catch {
    return null
  }
}

export function createResultCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  const entryLimit = normalizeLimit(maxEntries, DEFAULT_MAX_ENTRIES)
  const byteLimit = normalizeLimit(maxBytes, DEFAULT_MAX_BYTES)
  const lifetime = normalizeLimit(ttlMs, DEFAULT_TTL_MS)
  const getTime = typeof now === 'function' ? now : Date.now
  const entries = new Map()
  let bytes = 0

  function deleteEntry(key) {
    const entry = entries.get(key)
    if (!entry) return false
    entries.delete(key)
    bytes -= entry.bytes
    return true
  }

  function pruneExpired(timestamp) {
    for (const [key, entry] of entries) {
      if (timestamp >= entry.expiresAt) deleteEntry(key)
    }
  }

  function get(key) {
    if (!isCacheKey(key)) return undefined
    const entry = entries.get(key)
    if (!entry) return undefined
    if (getTime() >= entry.expiresAt) {
      deleteEntry(key)
      return undefined
    }
    entries.delete(key)
    entries.set(key, entry)
    return JSON.parse(entry.serialized)
  }

  function set(key, value) {
    if (!isCacheKey(key) || !entryLimit || !byteLimit || !lifetime) return false
    const entry = serializeSuccess(value)
    if (!entry || entry.bytes > byteLimit) return false

    const timestamp = getTime()
    pruneExpired(timestamp)
    deleteEntry(key)
    while (entries.size >= entryLimit || bytes + entry.bytes > byteLimit) {
      deleteEntry(entries.keys().next().value)
    }
    entries.set(key, { ...entry, expiresAt: timestamp + lifetime })
    bytes += entry.bytes
    return true
  }

  function clear() {
    entries.clear()
    bytes = 0
  }

  function getStats() {
    pruneExpired(getTime())
    return { entries: entries.size, bytes }
  }

  return { get, set, delete: deleteEntry, clear, getStats }
}
