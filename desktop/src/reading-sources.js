import { createHash } from 'node:crypto'

export const READING_SOURCES = {
  news: [
    { name: 'Ars Technica', url: 'https://arstechnica.com/feed/', hosts: ['arstechnica.com'] },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/tech/index.xml', hosts: ['www.theverge.com'] },
  ],
  engineering: [
    { name: 'The GitHub Blog', url: 'https://github.blog/engineering/feed/', hosts: ['github.blog'] },
    { name: 'Julia Evans', url: 'https://jvns.ca/atom.xml', hosts: ['jvns.ca'] },
  ],
  ideas: [
    { name: 'Martin Fowler', url: 'https://martinfowler.com/feed.atom', hosts: ['martinfowler.com'] },
    { name: 'The Pragmatic Engineer', url: 'https://newsletter.pragmaticengineer.com/feed', hosts: ['newsletter.pragmaticengineer.com'] },
  ],
}

const MAX_FEED_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 8000
const ARTICLES_PER_SOURCE = 4
const EXCERPT_LENGTH = 380
const TEXT_LENGTH = 12000

const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', middot: '·', bull: '•', times: '×', shy: '',
}))

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    if (!key.startsWith('#')) return ENTITIES.get(key) ?? entity
    const code = Number(key.startsWith('#x') || key.startsWith('#X') ? `0x${key.slice(2)}` : key.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

function decodeXmlText(text) {
  return text.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g).map((part, index) => (
    index % 2 === 1 ? part.slice(9, -3) : decodeEntities(part)
  )).join('')
}

function htmlToText(html) {
  const paragraphs = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|section|h[1-6]|pre|blockquote|ul|ol|article)\s*>/gi, '\n\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/?[a-z][\w:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, '')
  return decodeEntities(paragraphs).replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\r?\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Read just the direct fields of RSS items and Atom entries. Comments and CDATA
// are consumed as tokens, so markup inside an article body cannot start an item.
function* readFeedEntries(xml) {
  const tags = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g
  let entry
  let field
  let depth = 0
  for (const match of xml.matchAll(tags)) {
    const [tag, closing, name] = match
    if (!name) continue
    if (!entry) {
      if (!closing && (name === 'item' || name === 'entry') && !tag.endsWith('/>')) {
        entry = { name, fields: new Map(), linkTags: [] }
      }
      continue
    }
    if (closing) {
      if (depth === 0) {
        if (name === entry.name) yield entry
        entry = null
        continue
      }
      depth -= 1
      if (depth === 0 && name === field.name && !entry.fields.has(name)) {
        entry.fields.set(name, decodeXmlText(xml.slice(field.start, match.index)))
      }
      continue
    }
    if (depth === 0) {
      field = { name, start: match.index + tag.length }
      if (name === 'link') entry.linkTags.push(tag)
    }
    if (!tag.endsWith('/>')) depth += 1
  }
}

function linkAttribute(tag, attribute) {
  const attributes = /\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const [, name, doubleQuoted, singleQuoted] of tag.matchAll(attributes)) {
    if (name === attribute) return decodeEntities(doubleQuoted ?? singleQuoted)
  }
  return ''
}

function readArticleUrl(entry, source) {
  let link = entry.fields.get('link')
  if (entry.name === 'entry') {
    const alternateLink = entry.linkTags.find((tag) => {
      const rel = linkAttribute(tag, 'rel')
      return (!rel || rel === 'alternate') && linkAttribute(tag, 'href')
    })
    link = alternateLink ? linkAttribute(alternateLink, 'href') : ''
  }
  if (!link) return ''
  try {
    const url = new URL(link.trim(), source.url)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !source.hosts.includes(url.hostname)) return ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function readArticle(entry, source) {
  const url = readArticleUrl(entry, source)
  const title = htmlToText(entry.fields.get('title') ?? '').replace(/\s+/g, ' ').slice(0, 300)
  if (!url || !title) return null

  const summary = htmlToText(entry.fields.get('description') ?? entry.fields.get('summary') ?? '')
  const body = htmlToText(entry.fields.get('content:encoded') ?? entry.fields.get('content') ?? '')
  const excerpt = (summary || body).replace(/\s+/g, ' ')
  if (!excerpt) return null
  const date = Date.parse(entry.fields.get('pubDate') ?? entry.fields.get('published') ?? entry.fields.get('updated'))
  const article = {
    id: createHash('sha256').update(url).digest('hex'),
    title,
    source: source.name,
    publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : '',
    url,
    excerpt: excerpt.length > EXCERPT_LENGTH ? `${excerpt.slice(0, EXCERPT_LENGTH).trimEnd()}…` : excerpt,
  }
  const text = body.length > summary.length ? body : summary
  if (text.length > EXCERPT_LENGTH) article.text = text.slice(0, TEXT_LENGTH).trimEnd()
  return article
}

function newestFirst(a, b) {
  return b.publishedAt.localeCompare(a.publishedAt)
}

async function loadSource(source, fetchImpl) {
  const response = await fetchImpl(source.url, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Feed HTTP ${response.status}`)
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > MAX_FEED_BYTES) throw new Error('Feed is too large')
    chunks.push(chunk)
  }
  const xml = Buffer.concat(chunks).toString('utf8')
  const articles = new Map()
  for (const entry of readFeedEntries(xml)) {
    const article = readArticle(entry, source)
    if (article && !articles.has(article.id)) articles.set(article.id, article)
  }
  if (!articles.size) throw new Error('No readable articles')
  return [...articles.values()].sort(newestFirst).slice(0, ARTICLES_PER_SOURCE)
}

export async function discoverReadingArticles(category, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof category !== 'string' || !Object.hasOwn(READING_SOURCES, category)) {
    throw new Error('请选择一个阅读分类。')
  }
  const sources = READING_SOURCES[category]
  const results = await Promise.allSettled(sources.map((source) => loadSource(source, fetchImpl)))
  const articles = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  return {
    articles: articles.sort(newestFirst),
    unavailableSources: sources.filter((_, index) => results[index].status === 'rejected').map(({ name }) => name),
  }
}
