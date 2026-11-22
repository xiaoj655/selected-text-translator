import { createHash } from 'node:crypto'
import { lookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readability } from '@mozilla/readability'
import ipaddr from 'ipaddr.js'
import { parseHTML } from 'linkedom'
import { coachError } from './tutor.js'

const MAX_URL_LENGTH = 4096
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_TEXT_LENGTH = 12000
const IQS_SCRAPE_URL = 'https://cloud-iqs.aliyuncs.com/readpage/scrape'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const INVALID_URL = 'Enter a public HTTPS article link.'
const NO_ARTICLE = 'Couldn’t find article text on this page. Open it in your browser and paste the text.'

function articleUrl(value, base) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) throw coachError(INVALID_URL)
  const link = value.trim()
  const markdownUrl = /^\[[^\]\n]*\]\((https:\/\/[^\s]+)\)$/u.exec(link)?.[1]
  const url = URL.parse(markdownUrl || link.replace(/^<(https:\/\/[^\s]+)>$/u, '$1'), base)
  const host = url?.hostname.replace(/\.$/u, '')
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
    || !host.includes('.') || isIP(host) || /\.(?:localhost|local|internal|test|invalid|example)$/u.test(host)
    || host.endsWith('.home.arpa') || url.href.length > MAX_URL_LENGTH) throw coachError(INVALID_URL)
  url.hash = ''
  return url
}

function publicLookup(host, options, callback) {
  // Return the checked addresses directly to the socket, avoiding a second DNS lookup.
  lookup(host, { family: options.family, all: true, hints: options.hints }, (error, addresses) => {
    if (error) return callback(error)
    const publicAddresses = addresses.filter(({ address }) => {
      const ip = ipaddr.process(address)
      return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || ip.match(ipaddr.IPv6.parse('2000::'), 3))
    })
    if (!publicAddresses.length) return callback(Object.assign(new Error(INVALID_URL), { code: 'STT_PRIVATE_ADDRESS' }))
    const first = publicAddresses[0]
    if (options.all) return callback(null, publicAddresses)
    return callback(null, first.address, first.family)
  })
}

function requestPage(url, signal) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      agent: false,
      lookup: publicLookup,
      signal,
      headers: { Accept: 'text/html, application/xhtml+xml', 'User-Agent': 'SelectedTextTranslator/Reader' },
    }, resolve)
    request.once('error', reject)
  })
}

async function fetchPage(url) {
  const signal = AbortSignal.timeout(15000)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response
    try {
      response = await requestPage(url, signal)
      if (REDIRECT_STATUS.has(response.statusCode) && response.headers.location) {
        url = articleUrl(response.headers.location, url)
        continue
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw coachError(`Couldn’t open the page (HTTP ${response.statusCode}). Try another link or paste the text.`)
      }
      const contentType = response.headers['content-type'] || ''
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType)) throw coachError(NO_ARTICLE)
      const chunks = []
      let bytes = 0
      for await (const chunk of response) {
        bytes += chunk.length
        if (bytes > MAX_HTML_BYTES) throw coachError('This page is too large to import. Paste the article text instead.')
        chunks.push(chunk)
      }
      return { url, contentType, bytes: Buffer.concat(chunks) }
    } finally {
      response?.destroy()
    }
  }
  throw coachError('This link redirects too many times. Try the final article link.')
}

function decodePage(bytes, contentType) {
  const charset = /charset\s*=\s*["']?([\w-]+)/iu.exec(contentType)?.[1]
    || /<meta\b[^>]*\bcharset\s*=\s*["']?([\w-]+)/iu.exec(bytes.subarray(0, 1024).toString('latin1'))?.[1]
    || 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

function extractArticle(html, url) {
  const { document } = parseHTML(html)
  const content = new Readability(document, {
    maxElemsToParse: 30000,
    serializer(node) {
      const walker = document.createTreeWalker(node, 4) // SHOW_TEXT
      while (walker.nextNode()) {
        const text = walker.currentNode
        if (!text.parentElement?.closest('pre')) text.data = text.data.replace(/\s+/gu, ' ')
      }
      for (const element of node.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, br, div, section, figure, tr')) {
        element.after('\n\n')
      }
      return node.textContent
    },
  }).parse()
  const text = content?.content?.replace(/[^\S\r\n]+/gu, ' ').replace(/ *\r?\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n').trim()
  if (!text || text.length < 80) throw coachError(NO_ARTICLE)
  const article = {
    title: content.title?.trim().slice(0, 300).toWellFormed() || url.hostname,
    source: url.hostname,
    url: url.href,
    text: text.slice(0, MAX_TEXT_LENGTH).trimEnd().toWellFormed(),
    textTruncated: text.length > MAX_TEXT_LENGTH,
    kind: 'web_article',
  }
  return { ...article, id: createHash('sha256').update(JSON.stringify(article)).digest('hex') }
}

function iqsError(status, code) {
  if (status === 401 || code === 'InvalidAccessKeyId.NotFound') {
    return coachError('Alibaba Cloud rejected the IQS API key. Check it in Settings → Reading → Web import.')
  }
  if (code === 'Retrieval.NotActivate' || code === 'Retrieval.NotAuthorised') {
    return coachError('Enable webpage parsing and check the API key permissions in the Alibaba Cloud console.')
  }
  if (code === 'ReadPage.SecurityRestrict') {
    return coachError('Alibaba Cloud could not access this page under the site’s access rules. Paste the article text instead.')
  }
  if (status === 429) return coachError('Alibaba Cloud is receiving too many requests. Wait a moment and try again.')
  if (code === 'ReadPage.RequestTimeout') return coachError('Alibaba Cloud timed out while opening the page. Try again or paste the text.')
  return coachError(`Alibaba Cloud webpage parsing failed (HTTP ${status}). Check your IQS key and service status, then try again.`)
}

async function importIqsPage(url, { apiKey, fetchImpl }) {
  const signal = AbortSignal.timeout(60000)
  try {
    const response = await fetchImpl(IQS_SCRAPE_URL, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.href, maxAge: 0, formats: ['text'], readability: { readabilityMode: 'article' } }),
    })
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body || []) {
      bytes += chunk.byteLength
      if (bytes > MAX_HTML_BYTES) throw coachError('The webpage parsing response is too large. Paste the article text instead.')
      chunks.push(chunk)
    }
    let result
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      if (!response.ok) throw iqsError(response.status)
      throw coachError('Alibaba Cloud returned an unreadable response. Try again.')
    }
    if (!response.ok || result?.errorCode) throw iqsError(response.status, result?.errorCode)
    const data = result?.data
    if (data?.statusCode < 200 || data?.statusCode >= 300 || data?.errorMessage) {
      throw coachError('Alibaba Cloud couldn’t open the target page. Try another link or paste the article text.')
    }
    const text = typeof data?.text === 'string' ? data.text.replace(/\r\n?/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim() : ''
    if (text.length < 80) throw coachError(NO_ARTICLE)
    const metadata = data.metadata || {}
    const title = typeof metadata.title === 'string' ? metadata.title.trim().slice(0, 300).toWellFormed() : ''
    const article = {
      title: title || url.hostname,
      source: url.hostname,
      url: url.href,
      text: text.slice(0, MAX_TEXT_LENGTH).trimEnd().toWellFormed(),
      textTruncated: text.length > MAX_TEXT_LENGTH,
      kind: 'web_article',
    }
    return { ...article, id: createHash('sha256').update(JSON.stringify(article)).digest('hex') }
  } catch (error) {
    if (error.message?.startsWith('[english-coach] ')) throw error
    if (signal.aborted) throw coachError('Alibaba Cloud took too long to parse the page. Try again or paste the text.')
    throw coachError('Couldn’t connect to Alibaba Cloud webpage parsing. Check your network and try again.')
  }
}

export async function importReadingPage(value, { apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const inputUrl = articleUrl(value)
  if (apiKey.trim()) return importIqsPage(inputUrl, { apiKey: apiKey.trim(), fetchImpl })
  try {
    const { url, contentType, bytes } = await fetchPage(inputUrl)
    return extractArticle(decodePage(bytes, contentType), url)
  } catch (error) {
    if (error.message?.startsWith('[english-coach] ')) throw error
    if (error.code === 'STT_PRIVATE_ADDRESS') throw coachError(INVALID_URL)
    if (error.name === 'AbortError') throw coachError('The page took too long to load. Try again or paste the text.')
    throw coachError('Couldn’t import this page. Open it in your browser and paste the text.')
  }
}
