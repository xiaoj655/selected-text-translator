import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 100
const MAX_ARTICLE_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_BYTES = 50 * 1024 * 1024

function canonicalUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    url.hash = ''
    return url.href
  } catch { return '' }
}

function position(value) {
  if (!value || !Number.isInteger(value.offset) || value.offset < 0) return null
  return { offset: value.offset, top: Math.max(-1000, Math.min(1000, Number(value.top) || 0)),
    progress: Math.max(0, Math.min(1, Number(value.progress) || 0)) }
}

function cleanArticle(value) {
  if (!value || typeof value.text !== 'string' || !value.text.trim()) return null
  const url = canonicalUrl(value.url)
  if (value.kind !== 'pasted_text' && !url) return null
  const article = {
    id: String(value.id || '').slice(0, 200),
    kind: value.kind === 'pasted_text' ? 'pasted_text' : 'web_article',
    title: String(value.title || 'Pasted text').slice(0, 300),
    source: String(value.source || '').slice(0, 300),
    text: value.text,
  }
  if (url) article.url = url
  if (typeof value.html === 'string') article.html = value.html
  if (typeof value.publishedAt === 'string') article.publishedAt = value.publishedAt.slice(0, 100)
  return Buffer.byteLength(JSON.stringify(article)) <= MAX_ARTICLE_BYTES ? article : null
}

export function createReadingHistory(userDataDir, { now = Date.now } = {}) {
  const file = join(userDataDir, 'reading-history.json')
  const positionsFile = join(userDataDir, 'reading-positions.json')
  let entries
  let positions = {}

  function load() {
    if (entries) return entries
    entries = []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) return entries
      const seen = new Set()
      for (const item of parsed) {
        const article = cleanArticle(item?.article)
        if (!article || typeof item.id !== 'string' || seen.has(item.id)) continue
        seen.add(item.id)
        entries.push({ id: item.id, article, importedAt: Number(item.importedAt) || now(),
          lastOpenedAt: Number(item.lastOpenedAt) || now() })
        const legacyPosition = position(item.position)
        if (legacyPosition) positions[item.id] = legacyPosition
        if (entries.length >= MAX_ENTRIES) break
      }
      entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    } catch { /* An absent or unreadable history starts empty. */ }
    try {
      const savedPositions = JSON.parse(readFileSync(positionsFile, 'utf8'))
      for (const entry of entries) {
        const savedPosition = position(savedPositions?.[entry.id])
        if (savedPosition) positions[entry.id] = savedPosition
      }
    } catch { /* Older histories keep their positions inside the snapshot file. */ }
    return entries
  }

  function write(filePath, data) {
    mkdirSync(userDataDir, { recursive: true })
    const temporary = `${filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(data))
    renameSync(temporary, filePath)
  }

  function persist(next, savedPositions = positions) {
    const retainedPositions = Object.fromEntries(next.filter((entry) => savedPositions[entry.id])
      .map((entry) => [entry.id, savedPositions[entry.id]]))
    // Positions are small and change often; article snapshots only change when
    // importing, opening, or removing an article. This also migrates old data.
    write(positionsFile, retainedPositions)
    write(file, next)
    entries = next
    positions = retainedPositions
  }

  function articleFor(entry) {
    return { ...entry.article, historyId: entry.id, readingPosition: positions[entry.id] || null }
  }

  return {
    list() {
      return load().map(({ id, article, importedAt, lastOpenedAt }) => ({
        id, title: article.title, source: article.source, url: article.url, kind: article.kind,
        excerpt: article.text.slice(0, 180), importedAt, lastOpenedAt, progress: positions[id]?.progress || 0,
      }))
    },
    save(value) {
      const article = cleanArticle(value)
      if (!article) throw new Error('This article is too large to save. Try a shorter passage.')
      const key = article.url || `text:${article.text}`
      const id = createHash('sha256').update(key).digest('hex')
      if (article.kind === 'pasted_text') article.id = `paste-${id}`
      const current = load().find((entry) => entry.id === id)
      const entry = { id, article, importedAt: current?.importedAt || now(), lastOpenedAt: now() }
      const next = [entry, ...load().filter((item) => item.id !== id)].slice(0, MAX_ENTRIES)
      let bytes = next.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0)
      while (bytes > MAX_HISTORY_BYTES && next.length > 1) bytes -= Buffer.byteLength(JSON.stringify(next.pop()))
      const savedPositions = { ...positions }
      if (current?.article.text !== article.text) delete savedPositions[id]
      persist(next, savedPositions)
      return articleFor(entry)
    },
    restore(id) {
      const entry = load().find((item) => item.id === id)
      if (!entry) return null
      const opened = { ...entry, lastOpenedAt: now() }
      persist([opened, ...load().filter((item) => item.id !== id)])
      return articleFor(opened)
    },
    savePosition(id, value) {
      const savedPosition = position(value)
      if (!savedPosition || !load().some((entry) => entry.id === id)) return false
      if (JSON.stringify(positions[id]) === JSON.stringify(savedPosition)) return true
      const next = { ...positions, [id]: savedPosition }
      write(positionsFile, next)
      positions = next
      return true
    },
    remove(id) {
      persist(load().filter((entry) => entry.id !== id))
      return true
    },
    clear() {
      load()
      persist([])
      return true
    },
  }
}
