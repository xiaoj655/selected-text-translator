const VOCABULARY_STORAGE_KEY = 'vocabulary_entries'
const MAX_ENTRIES = 2000
const MAX_STORAGE_BYTES = 4 * 1024 * 1024
const DAY_MS = 86400000
const REVIEW_INTERVALS = Object.freeze([1, 3, 7, 14, 30])
let mutationQueue = Promise.resolve()

function normalizeString(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function getEntryKey(entry) {
  const meaning = entry.meaning.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').replace(/(?<!\.)[.。]$/u, '').trim()
  return `${entry.text.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ')}\n${meaning}`
}

function makeEntryId(key) {
  let first = 2166136261
  let second = 5381
  for (const char of key) {
    first = Math.imul(first ^ char.codePointAt(0), 16777619)
    second = Math.imul(second, 33) ^ char.codePointAt(0)
  }
  return `vocab-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}

function normalizeTimestamp(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizeSourceUrl(value) {
  try {
    const url = new URL(normalizeString(value, 2048))
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''
    url.password = ''
    return url.href.length <= 2048 ? url.href : ''
  } catch {
    return ''
  }
}

export function normalizeVocabularyEntry(input, now = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Vocabulary entry must be an object.')
  }
  const timestamp = normalizeTimestamp(now, 0)
  const text = normalizeString(input.text, 12001)
  if (text.length > 12000) throw new Error('Select up to 12,000 characters to save.')
  const meaning = normalizeString(input.meaning, 2000)
  if (!text || !meaning) throw new Error('A selection and its meaning are required before saving.')
  const entry = {
    text,
    meaning,
    context: normalizeString(input.context, 2400),
    usage: normalizeString(input.usage, 500),
    explanation: normalizeString(input.explanation, 2500),
    example: normalizeString(input.example, 1000),
    phonetic: normalizeString(input.phonetic, 160),
    sourceUrl: normalizeSourceUrl(input.sourceUrl),
  }
  const context = String(input.context || '')
  const trimOffset = context.length - context.trimStart().length
  const start = Number.isInteger(input.contextStart) ? input.contextStart - trimOffset : null
  const end = Number.isInteger(input.contextEnd) ? input.contextEnd - trimOffset : null
  const hasSpan = start !== null && end !== null && start >= 0 && end > start
    && end <= entry.context.length && entry.context.slice(start, end) === text
  entry.contextStart = hasSpan ? start : null
  entry.contextEnd = hasSpan ? end : null
  return {
    id: normalizeString(input.id, 160) || makeEntryId(getEntryKey(entry)),
    ...entry,
    createdAt: normalizeTimestamp(input.createdAt, timestamp),
    updatedAt: normalizeTimestamp(input.updatedAt, timestamp),
    reviewCount: Number.isInteger(input.reviewCount) && input.reviewCount >= 0 ? input.reviewCount : 0,
    dueAt: normalizeTimestamp(input.dueAt, timestamp + DAY_MS),
    intervalDays: Number.isFinite(input.intervalDays) && input.intervalDays >= 0 ? input.intervalDays : 0,
  }
}

export function getDueEntries(entries, now = 0) {
  if (!Array.isArray(entries)) return []
  return entries.filter((entry) => entry && Number.isFinite(entry.dueAt) && entry.dueAt <= now)
    .sort((left, right) => left.dueAt - right.dueAt || left.createdAt - right.createdAt)
}

export function scheduleReview(entry, rating, now = 0) {
  if (!['again', 'good'].includes(rating)) throw new Error('Choose again or good to schedule a review.')
  const normalized = normalizeVocabularyEntry(entry, now)
  const intervalDays = rating === 'again' ? 0
    : REVIEW_INTERVALS.find((days) => days > normalized.intervalDays) || REVIEW_INTERVALS.at(-1)
  return {
    ...normalized,
    updatedAt: now,
    reviewCount: normalized.reviewCount + 1,
    intervalDays,
    dueAt: now + (rating === 'again' ? 10 * 60 * 1000 : intervalDays * DAY_MS),
  }
}

async function readEntries() {
  const saved = await chrome.storage.local.get(VOCABULARY_STORAGE_KEY)
  if (!Array.isArray(saved?.[VOCABULARY_STORAGE_KEY])) return []
  const entries = []
  for (const value of saved[VOCABULARY_STORAGE_KEY].slice(0, MAX_ENTRIES)) {
    try {
      entries.push(normalizeVocabularyEntry(value, Date.now()))
    } catch { }
  }
  return entries
}

async function writeEntries(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error('Your vocabulary book is full. Export a backup and remove older entries.')
  if (new TextEncoder().encode(JSON.stringify(entries)).length > MAX_STORAGE_BYTES) {
    throw new Error('Your vocabulary book is full. Export a backup and remove older entries.')
  }
  await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: entries })
}

function normalizeStorageError(error) {
  if (error instanceof Error && /required|Choose|not found|book is full|12,000|vocabulary backup/.test(error.message)) return error.message
  return 'Unable to access your vocabulary book. Please try again.'
}

function enqueueMutation(operation) {
  const result = mutationQueue.then(async () => {
    try {
      return await operation()
    } catch (error) {
      return { ok: false, message: normalizeStorageError(error) }
    }
  })
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

export async function listVocabulary() {
  try {
    await mutationQueue
    const entries = await readEntries()
    return { ok: true, entries: entries.sort((left, right) => right.updatedAt - left.updatedAt) }
  } catch (error) {
    return { ok: false, message: normalizeStorageError(error) }
  }
}

export function saveVocabulary(input) {
  return enqueueMutation(async () => {
    const now = Date.now()
    const incoming = normalizeVocabularyEntry({
      text: input?.text,
      meaning: input?.meaning,
      context: input?.context,
      contextStart: input?.contextStart,
      contextEnd: input?.contextEnd,
      usage: input?.usage,
      explanation: input?.explanation,
      example: input?.example,
      phonetic: input?.phonetic,
      sourceUrl: input?.sourceUrl,
    }, now)
    const entries = await readEntries()
    const index = entries.findIndex((entry) => getEntryKey(entry) === getEntryKey(incoming))
    if (index !== -1) {
      const previous = entries[index]
      const enriched = { ...previous }
      for (const key of ['usage', 'explanation', 'example', 'phonetic', 'sourceUrl']) {
        if (!enriched[key] && incoming[key]) enriched[key] = incoming[key]
      }
      if (!enriched.context && incoming.context) {
        enriched.context = incoming.context
        enriched.contextStart = incoming.contextStart
        enriched.contextEnd = incoming.contextEnd
      } else if (enriched.context === incoming.context && enriched.contextStart === null) {
        enriched.contextStart = incoming.contextStart
        enriched.contextEnd = incoming.contextEnd
      }
      if (JSON.stringify(previous) !== JSON.stringify(enriched)) {
        enriched.updatedAt = now
        entries[index] = enriched
        await writeEntries(entries)
      }
      return { ok: true, entry: entries[index], alreadySaved: true }
    }
    entries.push(incoming)
    await writeEntries(entries)
    return { ok: true, entry: incoming, alreadySaved: false }
  })
}

export function removeVocabulary(id) {
  return enqueueMutation(async () => {
    const entries = await readEntries()
    const removed = entries.find((entry) => entry.id === id)
    const remaining = entries.filter((entry) => entry.id !== id)
    if (remaining.length === entries.length) throw new Error('This vocabulary entry was not found.')
    await writeEntries(remaining)
    return { ok: true, entry: removed }
  })
}

export function reviewVocabulary(id, rating, { expectedDueAt, expectedReviewCount } = {}) {
  return enqueueMutation(async () => {
    const entries = await readEntries()
    const index = entries.findIndex((entry) => entry.id === id)
    if (index === -1) throw new Error('This vocabulary entry was not found.')
    const current = entries[index]
    if ((expectedDueAt !== undefined && expectedDueAt !== current.dueAt)
      || (expectedReviewCount !== undefined && expectedReviewCount !== current.reviewCount)) {
      return { ok: false, code: 'review-changed', message: 'This expression was already reviewed elsewhere.', entry: current }
    }
    const entry = scheduleReview(current, rating, Date.now())
    entries[index] = entry
    await writeEntries(entries)
    return { ok: true, entry }
  })
}

export async function exportVocabulary() {
  try {
    const result = await listVocabulary()
    if (!result.ok) return result
    return { ok: true, data: { version: 2, exportedAt: Date.now(), entries: result.entries } }
  } catch (error) {
    return { ok: false, message: normalizeStorageError(error) }
  }
}

function validateBackupEntry(input) {
  const limits = { id: 160, text: 12000, meaning: 2000, context: 2400,
    explanation: 2500, example: 1000, phonetic: 160, sourceUrl: 2048 }
  const metadata = ['createdAt', 'updatedAt', 'dueAt', 'reviewCount', 'intervalDays', 'contextStart', 'contextEnd', 'usage']
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !Object.hasOwn(limits, key) && !metadata.includes(key))) {
    throw new Error('Invalid vocabulary backup: an entry has an unsupported format.')
  }
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof input[key] !== 'string' || input[key].length > limit
      || (['id', 'text', 'meaning'].includes(key) && !input[key].trim())) {
      throw new Error('Invalid vocabulary backup: an entry is incomplete or too long.')
    }
  }
  if (['createdAt', 'updatedAt', 'dueAt'].some((key) => !Number.isSafeInteger(input[key])
      || input[key] < 0 || input[key] > 8640000000000000)
    || input.createdAt > input.updatedAt
    || !Number.isSafeInteger(input.reviewCount) || input.reviewCount < 0
    || ![0, ...REVIEW_INTERVALS].includes(input.intervalDays)
    || (input.sourceUrl && !normalizeSourceUrl(input.sourceUrl))) {
    throw new Error('Invalid vocabulary backup: an entry has invalid learning progress or source data.')
  }
  if (input.usage !== undefined && (typeof input.usage !== 'string' || input.usage.length > 500)) {
    throw new Error('Invalid vocabulary backup: an entry has invalid usage data.')
  }
  const normalized = normalizeVocabularyEntry(input)
  const hasLocation = input.contextStart != null || input.contextEnd != null
  if (hasLocation && normalized.contextStart === null) {
    throw new Error('Invalid vocabulary backup: an entry has an invalid context position.')
  }
  return normalized
}

function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || ![1, 2].includes(data.version)
    || !Number.isSafeInteger(data.exportedAt) || data.exportedAt < 0 || data.exportedAt > 8640000000000000
    || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES
    || Object.keys(data).some((key) => !['version', 'exportedAt', 'entries'].includes(key))) {
    throw new Error('Invalid vocabulary backup. Choose a Selected version 1 or 2 JSON backup with up to 2,000 entries.')
  }
  let serialized
  try {
    serialized = JSON.stringify(data)
  } catch {
    throw new Error('Invalid vocabulary backup: unable to read this file.')
  }
  if (new TextEncoder().encode(serialized).length > MAX_STORAGE_BYTES) {
    throw new Error('Invalid vocabulary backup: the file exceeds 4 MB.')
  }
  return data.entries.map(validateBackupEntry)
}

export function importVocabulary(data) {
  return enqueueMutation(async () => {
    const incoming = validateBackup(data)
    const entries = await readEntries()
    const existingKeys = new Set(entries.map(getEntryKey))
    const existingIds = new Set(entries.map((entry) => entry.id))
    let added = 0
    let skipped = 0
    for (const entry of incoming) {
      const key = getEntryKey(entry)
      if (existingKeys.has(key)) { skipped++; continue }
      if (existingIds.has(entry.id)) throw new Error('Invalid vocabulary backup: conflicting entry IDs.')
      entries.push(entry)
      existingKeys.add(key)
      existingIds.add(entry.id)
      added++
    }
    if (added) await writeEntries(entries)
    return { ok: true, added, skipped }
  })
}
