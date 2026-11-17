import { buildGlossaryInstruction } from './glossary.js'

export const MEMORY_MAX_ENTRIES = 500
export const MEMORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function normalizeMemoryText(text) {
  return String(text || '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

export function memoryTextKey(text) {
  return String(text || '').trim().replace(/\s+/gu, ' ')
}

export function makeMemoryKey({ text, mode = 'translate', targetLanguage = 'auto', sourceLanguage = 'auto', model = '', glossary = [] }) {
  const parts = [mode, sourceLanguage, targetLanguage, normalizeMemoryText(model), memoryTextKey(text)]
  const glossaryKey = normalizeMemoryText(buildGlossaryInstruction(glossary))
  if (glossaryKey) parts.push(glossaryKey)
  return parts.join('\u0000')
}

export function readMemoryEntry(memory, key) {
  if (!memory || typeof memory !== 'object' || !key) return null
  const entry = memory[key]
  if (!entry || typeof entry !== 'object') return null
  if (!Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > MEMORY_MAX_AGE_MS) return null
  return entry
}

export function writeMemoryEntry(memory, key, result, maxEntries = MEMORY_MAX_ENTRIES) {
  const next = { ...(memory && typeof memory === 'object' ? memory : {}) }
  if (!key) return next
  const now = Date.now()
  const newest = Object.values(next).reduce((max, entry) => {
    return entry && Number.isFinite(entry.savedAt) ? Math.max(max, entry.savedAt) : max
  }, 0)
  next[key] = {
    translatedText: String(result?.translatedText || ''),
    lexical: result?.lexical || null,
    guide: result?.guide || null,
    savedAt: Math.max(now, newest + 1),
  }
  return pruneMemory(next, { maxEntries })
}

export function pruneMemory(memory, { maxEntries = MEMORY_MAX_ENTRIES, maxAgeMs = MEMORY_MAX_AGE_MS, now = Date.now() } = {}) {
  if (!memory || typeof memory !== 'object') return {}
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : MEMORY_MAX_ENTRIES
  const fresh = Object.entries(memory)
    .filter(([, entry]) => entry && Number.isFinite(entry.savedAt) && now - entry.savedAt <= maxAgeMs)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, limit)
  return Object.fromEntries(fresh)
}

export function memorySize(memory) {
  return memory && typeof memory === 'object' ? Object.keys(memory).length : 0
}
