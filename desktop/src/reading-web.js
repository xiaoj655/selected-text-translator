import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { coachError } from './tutor.js'
import { normalizeReadingContent, plainReadingContent } from './reading-content.js'
import { openReadingResource, publicReadingUrl, readingReferrerPolicy } from './reading-network.js'

const MAX_URL_LENGTH = 4096
const MAX_HTML_BYTES = 2 * 1024 * 1024
const IQS_SCRAPE_URL = 'https://cloud-iqs.aliyuncs.com/readpage/scrape'
const INVALID_URL = 'Enter a public HTTPS article link.'
const NO_ARTICLE = 'Couldn’t find article text on this page. Open it in your browser and paste the text.'

function articleUrl(value, base, allowHttp = false) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) throw coachError(INVALID_URL)
  const link = value.trim()
  const markdownUrl = /^\[[^\]\n]*\]\((https:\/\/[^\s]+)\)$/u.exec(link)?.[1]
  try { return publicReadingUrl(markdownUrl || link.replace(/^<(https:\/\/[^\s]+)>$/u, '$1'), base, { allowHttp }) }
  catch { throw coachError(INVALID_URL) }
}

async function fetchPage(url, allowHttp, openResource) {
  const signal = AbortSignal.timeout(15000)
  const opened = await openResource(url.href, {
    allowHttp, signal, headers: { Accept: 'text/html, application/xhtml+xml', 'User-Agent': 'SelectedTextTranslator/Reader' },
  })
  const { response } = opened
  try {
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
    return { url: opened.url, contentType, bytes: Buffer.concat(chunks), referrerPolicy: response.headers['referrer-policy'] }
  } finally {
    response.destroy()
  }
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

function mediaSource(url, document, header) {
  const policies = [readingReferrerPolicy(header)]
  for (const meta of document?.querySelectorAll('meta[name]') || []) {
    if (meta.getAttribute('name')?.trim().toLowerCase() === 'referrer') {
      policies.push(readingReferrerPolicy(meta.getAttribute('content')))
    }
  }
  // The reader only sends origins, and preserves either publisher opt-out.
  const policy = ['no-referrer', 'same-origin'].find((value) => policies.includes(value)) || policies.findLast(Boolean)
  return { mediaReferrer: `${url.origin}/`, ...(policy && { mediaReferrerPolicy: policy }) }
}

function extractArticle(html, url, referrerPolicy) {
  const { document } = parseHTML(html)
  const source = mediaSource(url, document, referrerPolicy)
  const content = new Readability(document, { maxElemsToParse: 30000, allowedVideoRegex: /https:\/\//iu }).parse()
  const material = normalizeReadingContent(content?.content, { baseUrl: url.href })
  if (material.text.length < 80) throw coachError(NO_ARTICLE)
  const article = {
    title: content.title?.trim().slice(0, 300).toWellFormed() || url.hostname,
    source: url.hostname,
    url: url.href,
    ...source,
    ...material,
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

async function importIqsPage(url, { apiKey, fetchImpl, allowHttp }) {
  const signal = AbortSignal.timeout(60000)
  try {
    const response = await fetchImpl(IQS_SCRAPE_URL, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.href, maxAge: 0, formats: ['html', 'text'], readability: { readabilityMode: 'article' } }),
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
    const metadata = data?.metadata || {}
    const redirectedUrl = data?.redirectedUrl || metadata.redirectedUrl
    const finalUrl = articleUrl(redirectedUrl || metadata.url || url.href, url, allowHttp)
    let material = normalizeReadingContent(data?.html, { baseUrl: finalUrl.href })
    if (!material.text.trim()) material = plainReadingContent(data?.text)
    if (material.text.length < 80) throw coachError(NO_ARTICLE)
    const title = typeof metadata.title === 'string' ? metadata.title.trim().slice(0, 300).toWellFormed() : ''
    const article = {
      title: title || url.hostname,
      source: finalUrl.hostname,
      url: finalUrl.href,
      ...mediaSource(redirectedUrl ? finalUrl : url, typeof data?.html === 'string' ? parseHTML(data.html).document : null),
      ...material,
      kind: 'web_article',
    }
    return { ...article, id: createHash('sha256').update(JSON.stringify(article)).digest('hex') }
  } catch (error) {
    if (error.message?.startsWith('[english-coach] ')) throw error
    if (signal.aborted) throw coachError('Alibaba Cloud took too long to parse the page. Try again or paste the text.')
    throw coachError('Couldn’t connect to Alibaba Cloud webpage parsing. Check your network and try again.')
  }
}

export async function importReadingPage(value, { apiKey = '', fetchImpl = globalThis.fetch, allowHttp = false,
  openResource = openReadingResource } = {}) {
  const inputUrl = articleUrl(value, undefined, allowHttp)
  if (apiKey.trim()) return importIqsPage(inputUrl, { apiKey: apiKey.trim(), fetchImpl, allowHttp })
  try {
    const { url, contentType, bytes, referrerPolicy } = await fetchPage(inputUrl, allowHttp, openResource)
    return extractArticle(decodePage(bytes, contentType), url, referrerPolicy)
  } catch (error) {
    if (error.message?.startsWith('[english-coach] ')) throw error
    if (error.code === 'STT_PRIVATE_ADDRESS') throw coachError(INVALID_URL)
    if (error.name === 'AbortError') throw coachError('The page took too long to load. Try again or paste the text.')
    throw coachError('Couldn’t import this page. Open it in your browser and paste the text.')
  }
}
