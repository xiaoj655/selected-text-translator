import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 20
const MAX_TEXT = 4000

function sanitize(entry) {
  if (!entry || typeof entry !== 'object') return null
  const text = String(entry.text || '').slice(0, MAX_TEXT)
  if (!text) return null
  return {
    id: String(entry.id || ''),
    requestId: String(entry.requestId || ''),
    text,
    mode: entry.mode === 'guide' ? 'guide' : 'translate',
    status: entry.status === 'done' ? 'done' : 'error',
    translatedText: String(entry.translatedText || '').slice(0, MAX_TEXT),
    lexical: entry.lexical && typeof entry.lexical === 'object' ? entry.lexical : null,
    guide: entry.guide && typeof entry.guide === 'object' ? entry.guide : null,
    error: String(entry.error || ''),
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    hintCount: Math.max(1, Math.min(9, Number(entry.hintCount) || 1)),
    answerRevealed: Boolean(entry.answerRevealed),
    sourceLanguage: String(entry.sourceLanguage || 'auto').slice(0, 40),
    lookupExcluded: entry.lookupExcluded === true,
  }
}

export function createHistory(userDataDir) {
  const file = join(userDataDir, 'history.json')

  function load() {
    try {
      if (!existsSync(file)) return []
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.map(sanitize).filter(Boolean).slice(-MAX_ENTRIES)
    } catch {
      return []
    }
  }

  function save(entries) {
    try {
      const list = (Array.isArray(entries) ? entries : []).map(sanitize).filter(Boolean).slice(-MAX_ENTRIES)
      writeFileSync(file, JSON.stringify(list))
      return true
    } catch {
      return false
    }
  }

  function clear() {
    try {
      writeFileSync(file, '[]')
      return true
    } catch {
      return false
    }
  }

  return { load, save, clear }
}
