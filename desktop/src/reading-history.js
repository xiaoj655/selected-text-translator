import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicReadingUrl, readingReferrerPolicy } from './reading-network.js'

const MAX_ENTRIES = 100
const MAX_ARTICLE_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_BYTES = 50 * 1024 * 1024

function canonicalUrl(value, allowHttp = false) {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) || url.username || url.password) return ''
    url.hash = ''
    return url.href
  } catch { return '' }
}

function position(value) {
  if (!value || !Number.isInteger(value.offset) || value.offset < 0) return null
  return { offset: value.offset, top: Math.max(-1000, Math.min(1000, Number(value.top) || 0)),
    progress: Math.max(0, Math.min(1, Number(value.progress) || 0)) }
}

function relocatePosition(saved, before, after) {
  if (!saved?.offset || before === after) return saved
  const oldOffset = Math.min(saved.offset, before.length)
  const start = Math.max(0, oldOffset - 48)
  const quote = before.slice(start, oldOffset + 48)
  const match = after.indexOf(quote)
  const offset = match >= 0 && after.indexOf(quote, match + 1) < 0
    ? match + oldOffset - start
    : Math.round(oldOffset / before.length * after.length)
  return { ...saved, offset, progress: offset / after.length }
}

function cleanArticle(value) {
  if (!value || typeof value.text !== 'string' || !value.text.trim()) return null
  const kind = ['pasted_text', 'feed_article'].includes(value.kind) ? value.kind : 'web_article'
  const url = canonicalUrl(value.url, kind === 'feed_article')
  if (kind !== 'pasted_text' && !url) return null
  const article = {
    id: String(value.id || '').slice(0, 200),
    kind,
    title: String(value.title || 'Pasted text').slice(0, 300),
    source: String(value.source || '').slice(0, 300),
    text: value.text,
  }
  if (url) article.url = url
  if (typeof value.html === 'string') article.html = value.html
  if (typeof value.publishedAt === 'string') article.publishedAt = value.publishedAt.slice(0, 100)
  if (kind !== 'pasted_text' && Object.hasOwn(value, 'mediaReferrer')) {
    article.mediaReferrer = ''
    if (value.mediaReferrer) {
      try { article.mediaReferrer = `${publicReadingUrl(value.mediaReferrer, undefined, { allowHttp: true }).origin}/` }
      catch { /* Preserve the opt-out for invalid stored provenance. */ }
    }
    const policy = readingReferrerPolicy(value.mediaReferrerPolicy)
    if (policy) article.mediaReferrerPolicy = policy
  }
  return Buffer.byteLength(JSON.stringify(article)) <= MAX_ARTICLE_BYTES ? article : null
}

function historyBytes(entries) {
  return entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0)
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

  function stage(filePath, data) {
    mkdirSync(userDataDir, { recursive: true })
    const temporary = `${filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(data))
    return temporary
  }

  function write(filePath, data) {
    renameSync(stage(filePath, data), filePath)
  }

  function persist(next, savedPositions = positions) {
    const retainedPositions = Object.fromEntries(next.filter((entry) => savedPositions[entry.id])
      .map((entry) => [entry.id, savedPositions[entry.id]]))
    // Positions are small and change often; article snapshots only change when
    // importing, reloading, opening, or removing an article. Stage both
    // writes before replacing either file so a staging failure leaves both intact.
    const historyFile = stage(file, next)
    const pendingPositions = stage(positionsFile, retainedPositions)
    renameSync(pendingPositions, positionsFile)
    try {
      renameSync(historyFile, file)
    } catch (error) {
      try { write(positionsFile, positions) } catch { /* Preserve the original write error. */ }
      throw error
    }
    entries = next
    positions = retainedPositions
  }

  function articleFor(entry) {
    return { ...entry.article, historyId: entry.id, readingPosition: positions[entry.id] || null }
  }

  function save(value) {
    const article = cleanArticle(value)
    if (!article) throw new Error('This article is too large to save. Try a shorter passage.')
    const key = article.url || `text:${article.text}`
    const id = createHash('sha256').update(key).digest('hex')
    if (article.kind === 'pasted_text') article.id = `paste-${id}`
    if (article.kind === 'feed_article') article.id = `feed-history-${id}`
    const current = load().find((entry) => entry.id === id)
    const entry = { id, article, importedAt: current?.importedAt || now(), lastOpenedAt: now() }
    const next = [entry, ...load().filter((item) => item.id !== id)].slice(0, MAX_ENTRIES)
    let bytes = historyBytes(next)
    while (bytes > MAX_HISTORY_BYTES && next.length > 1) bytes -= Buffer.byteLength(JSON.stringify(next.pop()))
    const savedPositions = { ...positions }
    if (current?.article.text !== article.text) delete savedPositions[id]
    persist(next, savedPositions)
    return articleFor(entry)
  }

  async function reload(id, fetchArticle) {
    const previous = load().find((entry) => entry.id === id)?.article
    if (!previous?.url) return null
    const fetched = await fetchArticle(previous.url)
    const current = load().find((entry) => entry.id === id)
    if (current?.article !== previous) return null
    const article = cleanArticle({ ...fetched, url: previous.url, kind: previous.kind, publishedAt: previous.publishedAt })
    if (!article) throw new Error('Couldn’t save the reloaded article.')
    const content = JSON.stringify({ ...article, id: '' })
    if (content === JSON.stringify({ ...previous, id: '' })) return articleFor(current)
    // Separate saved articles can now redirect to the same page.
    article.id = createHash('sha256').update(id).update('\0').update(content).digest('hex')
    const entry = { ...current, article }
    const next = load().map((item) => item === current ? entry : item)
    if (historyBytes(next) > MAX_HISTORY_BYTES) throw new Error('Couldn’t save the reloaded article.')
    const updatedPosition = relocatePosition(positions[id], previous.text, article.text)
    persist(next, { ...positions, [id]: updatedPosition })
    return articleFor(entry)
  }

  function restore(id) {
    const entry = load().find((item) => item.id === id)
    if (!entry) return null
    const opened = { ...entry, lastOpenedAt: now() }
    persist([opened, ...load().filter((item) => item.id !== id)])
    return articleFor(opened)
  }

  return {
    list() {
      return load().map(({ id, article, importedAt, lastOpenedAt }) => ({
        id, title: article.title, source: article.source, url: article.url, kind: article.kind,
        excerpt: article.text.slice(0, 180), importedAt, lastOpenedAt, progress: positions[id]?.progress || 0,
      }))
    },
    save,
    reload,
    restore,
    openFeed(value) {
      const url = canonicalUrl(value?.url, true)
      if (!url) return null
      const existing = load().find((entry) => entry.article.url === url)
      if (existing) return restore(existing.id)
      if (value.feedHasBody !== true || typeof value.text !== 'string' || !value.text.trim()) return null
      return save({ ...value, url, kind: 'feed_article' })
    },
    savePosition(id, value, articleId) {
      const savedPosition = position(value)
      const entry = load().find((item) => item.id === id)
      if (!savedPosition || !entry || (articleId !== undefined && entry.article.id !== articleId)) return false
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
