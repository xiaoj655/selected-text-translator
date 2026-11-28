import { createHash } from 'node:crypto'
import catalog from '../vendor/src/reading-source-catalog.json' with { type: 'json' }
import desktopSources from './reading-source-catalog.json' with { type: 'json' }
import { normalizeReadingContent } from './reading-content.js'
import { openReadingResource, publicReadingUrl } from './reading-network.js'

export const READING_SOURCES = Object.groupBy([...catalog.builtIn, ...desktopSources], ({ group }) => group)

const MAX_FEED_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 8000
const ARTICLES_PER_SOURCE = 8
const EXCERPT_LENGTH = 380
const FEED_STORAGE_KEY = 'desktop_reading_custom_feeds'
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml'
const INVALID_FEED_URL = 'Enter a public HTTP or HTTPS feed URL.'
const DUPLICATE_FEED = 'This feed is already added.'
const INVALID_FEED = 'This URL did not return an RSS or Atom feed.'
const FEED_TAGS = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g

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
  let entry
  let field
  let depth = 0
  for (const match of xml.matchAll(FEED_TAGS)) {
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

function readFeedMetadata(xml) {
  const parents = []
  let format
  let hasChannel = false
  let hasEntries = false
  let titleStart
  let title = ''
  for (const match of xml.matchAll(FEED_TAGS)) {
    const [tag, closing, name] = match
    if (!name) continue
    if (!format) {
      if (closing || (name !== 'rss' && name !== 'feed')) break
      if (name === 'feed' && tag.endsWith('/>')) return { title, hasEntries }
      format = name
    }
    const entryDepth = format === 'feed' ? 1 : 2
    if (closing) {
      if (parents.pop() !== name) break
      if (parents.length === entryDepth && name === 'title' && titleStart !== undefined) {
        title = htmlToText(decodeXmlText(xml.slice(titleStart, match.index)))
        titleStart = undefined
      }
      if (!parents.length && (format === 'feed' || hasChannel)) {
        return { title: title.replace(/\s+/g, ' ').slice(0, 160).toWellFormed(), hasEntries }
      }
    } else {
      if (format === 'rss' && parents.length === 1 && name === 'channel') hasChannel = true
      const inFeed = parents.length === entryDepth && (format === 'feed' || parents[1] === 'channel')
      if (inFeed && name === (format === 'feed' ? 'entry' : 'item')) hasEntries = true
      if (!tag.endsWith('/>')) {
        if (inFeed && name === 'title' && !title) titleStart = match.index + tag.length
        parents.push(name)
      }
    }
  }
  throw new Error(INVALID_FEED)
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
    if (!source.hosts) return publicReadingUrl(link, source.url, { allowHttp: source.allowHttp }).href
    const url = new URL(link.trim(), source.url)
    if (source.upgradeArticleLinks && url.protocol === 'http:') url.protocol = 'https:'
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !source.hosts.includes(url.hostname)) return ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function readArticle(entry, source, builtIn) {
  const url = readArticleUrl(entry, source)
  const title = htmlToText(entry.fields.get('title') ?? '').replace(/\s+/g, ' ').slice(0, 300)
  if (!url || !title) return null

  const summaryHtml = entry.fields.get('description') ?? entry.fields.get('summary') ?? ''
  const bodyHtml = entry.fields.get('content:encoded') ?? entry.fields.get('content') ?? ''
  const summary = htmlToText(summaryHtml).replace(/\s+/g, ' ')
  const body = htmlToText(bodyHtml).replace(/\s+/g, ' ')
  let excerpt = summary || body
  if (!excerpt && builtIn) return null
  const options = { baseUrl: url }
  const bodyContent = body.length > summary.length ? normalizeReadingContent(bodyHtml, options) : null
  const useBody = bodyContent && bodyContent.text.replace(/\s+/g, ' ').trim().length > summary.length
  let material = useBody ? bodyContent : normalizeReadingContent(summaryHtml, options)
  if (!material.text.trim()) {
    if (builtIn) return null
    material = { text: '', html: '' }
    excerpt = ''
  }
  const date = Date.parse(entry.fields.get('pubDate') ?? entry.fields.get('published') ?? entry.fields.get('updated'))
  const hash = createHash('sha256').update(url).digest('hex')
  return {
    id: builtIn ? hash : `custom-feed-${hash}`,
    title,
    source: source.name,
    publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : '',
    url,
    excerpt: excerpt.length > EXCERPT_LENGTH ? `${excerpt.slice(0, EXCERPT_LENGTH).trimEnd()}…` : excerpt,
    feedHasBody: Boolean(useBody || source.summaryContainsBody),
    ...material,
  }
}

function newestFirst(a, b) {
  return b.publishedAt.localeCompare(a.publishedAt)
}

function latestArticle(previous, article) {
  return !previous || newestFirst(article, previous) < 0 ? article : previous
}

async function readFeedBytes(body) {
  const chunks = []
  let bytes = 0
  for await (const chunk of body) {
    bytes += chunk.byteLength
    if (bytes > MAX_FEED_BYTES) throw new Error('This feed is too large. Try another feed URL.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function readFeedArticles(xml, source, { builtIn = false } = {}) {
  const articles = new Map()
  for (const entry of readFeedEntries(xml)) {
    try {
      const article = readArticle(entry, source, builtIn)
      if (article && !articles.has(article.id)) articles.set(article.id, article)
    } catch {
      // A broken article need not make the publisher's entire feed unavailable.
    }
  }
  return [...articles.values()].sort(newestFirst).slice(0, ARTICLES_PER_SOURCE)
}

async function loadSource(source, fetchImpl) {
  const response = await fetchImpl(source.url, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: FEED_ACCEPT },
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Feed HTTP ${response.status}`)
  }
  const articles = readFeedArticles((await readFeedBytes(response.body)).toString('utf8'), source, { builtIn: true })
  if (!articles.length) throw new Error('No readable articles')
  return articles
}

function customFeedUrl(value) {
  try {
    return publicReadingUrl(value, undefined, { allowHttp: true })
  } catch {
    throw new Error(INVALID_FEED_URL)
  }
}

function decodeFeed(bytes, contentType) {
  const charset = /charset\s*=\s*["']?([\w-]+)/iu.exec(contentType)?.[1]
    || /^\s*<\?xml\b[^?]*\bencoding\s*=\s*["']([\w-]+)/iu.exec(bytes.subarray(0, 256).toString('latin1'))?.[1]
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

function customFeedId(url) {
  return createHash('sha256').update(url).digest('hex')
}

async function readCustomSources(localStore) {
  const stored = await localStore?.get(FEED_STORAGE_KEY)
  const sources = new Map()
  const entries = stored?.[FEED_STORAGE_KEY]
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      try {
        const { href: url, hostname } = customFeedUrl(entry?.url)
        const id = customFeedId(url)
        const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 160).toWellFormed() : ''
        sources.set(id, { id, url, name: name || hostname })
      } catch {
        // Keep usable subscriptions when a local record cannot be read.
      }
    }
  }
  return [...sources.values()]
}

async function loadCustomFeed(feedUrl, openResource, savedName) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  let resource
  try {
    resource = await openResource(feedUrl, {
      signal,
      headers: { Accept: FEED_ACCEPT, 'Accept-Encoding': 'identity', 'User-Agent': 'SelectedTextTranslator/Reader' },
    })
    const { response } = resource
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Could not load this feed (HTTP ${response.statusCode}). Check the URL and try again.`)
    }
    const xml = decodeFeed(await readFeedBytes(response), response.headers['content-type'] || '')
    const { title, hasEntries } = readFeedMetadata(xml)
    const url = resource.url.href
    const name = savedName || title || resource.url.hostname
    const articles = readFeedArticles(xml, { url, name, allowHttp: true })
    if (hasEntries && !articles.length) throw new Error('This feed has no readable article links. Try another feed URL.')
    return { url, name, articles }
  } catch (error) {
    if (error.code === 'STT_PRIVATE_ADDRESS' || error.message === 'Invalid public HTTPS URL') throw new Error(INVALID_FEED_URL)
    if (signal.aborted) throw new Error('This feed took too long to load. Try again.')
    if (error.message === 'Too many redirects') throw new Error('This feed redirected too many times. Try its direct URL.')
    if (error.code || !resource) throw new Error('Could not load this feed. Check the URL and try again.')
    throw error
  } finally {
    resource?.response.destroy()
  }
}

export async function discoverReadingArticles(category, { fetchImpl = globalThis.fetch, sourceCache = new Map() } = {}) {
  if (typeof category !== 'string' || !Object.hasOwn(READING_SOURCES, category)) {
    throw new Error('Choose an article category.')
  }
  const sources = READING_SOURCES[category]
  const results = await Promise.allSettled(sources.map((source) => loadSource(source, fetchImpl)))
  const unavailableSources = []
  const staleSources = []
  for (const [index, source] of sources.entries()) {
    const result = results[index]
    if (result.status === 'fulfilled') {
      sourceCache.set(source.url, result.value)
    } else {
      unavailableSources.push(source.name)
      if (sourceCache.has(source.url)) staleSources.push(source.name)
    }
  }
  const articles = sources.flatMap(({ url }) => sourceCache.get(url) ?? [])
  return { articles: articles.sort(newestFirst), unavailableSources, staleSources }
}

export function createReadingDiscovery({ fetchImpl, storage, openResource = openReadingResource } = {}) {
  const sourceCache = new Map()
  const pending = new Map()
  const customCache = new Map()
  let customArticles = new Map()
  let customSources
  let pendingMutation = Promise.resolve()

  function getCustomSources() {
    customSources ??= readCustomSources(storage?.local)
    return customSources
  }

  async function saveCustomSources(sources) {
    try {
      await storage?.local.set({ [FEED_STORAGE_KEY]: sources })
    } catch {
      throw new Error('Could not save your RSS subscriptions. Try again.')
    }
    customSources = Promise.resolve(sources)
  }

  function mutateCustomSources(mutate) {
    const request = pendingMutation.then(async () => mutate(await getCustomSources()))
    pendingMutation = request.catch(() => {})
    return request
  }

  function customResult(sources) {
    const articles = new Map()
    const unavailableSources = []
    const staleSources = []
    const sourceErrors = {}
    for (const source of sources) {
      const cached = customCache.get(source.id)
      if (cached?.error) {
        unavailableSources.push(source.name)
        sourceErrors[source.id] = cached.error
        if (cached.articles?.length) staleSources.push(source.name)
      }
      for (const article of cached?.articles || []) {
        articles.set(article.id, latestArticle(articles.get(article.id), article))
      }
    }
    customArticles = articles
    return { sources, articles: [...articles.values()].sort(newestFirst), unavailableSources, staleSources, sourceErrors }
  }

  async function discoverCustom() {
    const sources = await getCustomSources()
    const results = await Promise.allSettled(sources.map(({ url, name }) => loadCustomFeed(url, openResource, name)))
    const current = await getCustomSources()
    for (const [index, source] of sources.entries()) {
      // A refresh may finish after this subscription was removed or re-added.
      if (!current.includes(source)) continue
      const result = results[index]
      if (result.status === 'fulfilled') {
        customCache.set(source.id, { articles: result.value.articles })
      } else {
        customCache.set(source.id, { ...customCache.get(source.id), error: result.reason.message })
      }
    }
    return customResult(current)
  }

  return {
    async discover(category) {
      if (!pending.has(category)) {
        const request = category === 'custom' ? discoverCustom() : discoverReadingArticles(category, { fetchImpl, sourceCache })
        pending.set(category, request.finally(() => pending.delete(category)))
      }
      return pending.get(category)
    },
    async addFeed(value) {
      const requestedUrl = customFeedUrl(value).href
      const existing = await getCustomSources()
      if (existing.some(({ url }) => url === requestedUrl)) throw new Error(DUPLICATE_FEED)
      const { url, name, articles } = await loadCustomFeed(requestedUrl, openResource)
      return mutateCustomSources(async (sources) => {
        if (sources.some((source) => source.url === url)) throw new Error(DUPLICATE_FEED)
        const id = customFeedId(url)
        const next = [...sources, { id, name, url }]
        await saveCustomSources(next)
        customCache.set(id, { articles })
        return customResult(next)
      })
    },
    async removeFeed(id) {
      return mutateCustomSources(async (sources) => {
        const next = sources.filter((source) => source.id !== id)
        if (next.length !== sources.length) {
          await saveCustomSources(next)
          customCache.delete(id)
        }
        return customResult(next)
      })
    },
    getArticle(id) {
      for (const articles of sourceCache.values()) {
        const match = articles.find((article) => article.id === id)
        if (match) return match
      }
      return customArticles.get(id)
    },
  }
}
