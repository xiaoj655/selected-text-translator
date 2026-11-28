import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseHTML } from 'linkedom'
import { openReadingResource, publicReadingUrl, readingReferrerPolicy } from './reading-network.js'
import { sanitizeReadingSvg } from './reading-svg.js'

const MAX_MEDIA_BYTES = 256 * 1024 * 1024
const MAX_SVG_BYTES = 2 * 1024 * 1024
const SVG_TYPE = /^image\/svg\+xml(?:\s*;|$)/iu
const MEDIA_TYPES = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/(?:mp4|webm|ogg|quicktime|x-m4v)|audio\/(?:mpeg|mp4|ogg|wav|x-wav|webm|flac))(?:\s*;|$)/iu
const RANGE = /^bytes=(?:\d+-\d*|-\d+)$/u
const contextKey = randomBytes(32)

function restrictReferrerPolicy(current, next) {
  if (current === 'no-referrer' || next === 'no-referrer') return 'no-referrer'
  if (current === 'same-origin' || next === 'same-origin') return 'same-origin'
  return ''
}

function signContext(url, context) {
  return createHmac('sha256', contextKey).update(url).update('\0').update(context).digest()
}

function readContext(value, url) {
  if (!value || value.length > 1024) return null
  const [context, encodedSignature, extra] = value.split('.')
  if (!context || !encodedSignature || extra !== undefined) return null
  const signature = Buffer.from(encodedSignature, 'base64url')
  const expected = signContext(url.href, context)
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null
  const [origin, policy] = JSON.parse(Buffer.from(context, 'base64url').toString())
  return { origin, policy }
}

export function bindReadingMedia(article, legacyReferrer = '') {
  if (!article?.html?.includes('stt-media://asset/')) return article
  const referrer = article.mediaReferrer ?? legacyReferrer
  if (!referrer || article.mediaReferrerPolicy === 'no-referrer') return article
  let source
  try { source = publicReadingUrl(referrer, undefined, { allowHttp: true }) } catch { return article }

  // Bind the source to each asset in the sanitized markup when sending it to the window.
  const { document } = parseHTML('<html><body></body></html>')
  document.body.innerHTML = article.html
  for (const image of document.body.querySelectorAll('img[src]')) {
    const policy = restrictReferrerPolicy(article.mediaReferrerPolicy, readingReferrerPolicy(image.getAttribute('referrerpolicy')))
    if (policy === 'no-referrer') continue
    const asset = URL.parse(image.getAttribute('src'))
    if (asset?.protocol !== 'stt-media:' || asset.hostname !== 'asset' || asset.pathname !== '/') continue
    let target
    try { target = publicReadingUrl(asset.searchParams.get('url')) } catch { continue }
    const context = Buffer.from(JSON.stringify([source.origin, policy])).toString('base64url')
    asset.searchParams.set('context', `${context}.${signContext(target.href, context).toString('base64url')}`)
    image.src = asset.href
  }
  return { ...article, html: document.body.innerHTML }
}

function permitsReferrer(url, origin, policy) {
  return url.protocol === 'https:' && policy !== 'no-referrer' && (policy !== 'same-origin' || url.origin === origin)
}

function mediaError(status) {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })
}

export function createReadingMediaHandler({ openResource = openReadingResource, maxBytes = MAX_MEDIA_BYTES } = {}) {
  return async function handleReadingMediaRequest(request) {
    let response
    try {
      const resource = new URL(request.url)
      if (resource.protocol !== 'stt-media:' || resource.hostname !== 'asset' || resource.pathname !== '/'
        || resource.username || resource.password || resource.port || !['GET', 'HEAD'].includes(request.method)) {
        return mediaError(400)
      }
      const url = publicReadingUrl(resource.searchParams.get('url'))
      const range = request.headers.get('range')
      if (range && !RANGE.test(range)) return mediaError(416)
      const headers = { Accept: 'image/*, video/*, audio/*', 'User-Agent': 'SelectedTextTranslator/Reader' }
      if (range) headers.Range = range
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)])
      const context = readContext(resource.searchParams.get('context'), url)
      let policy = context?.policy
      const observePolicy = (headers) => { policy = restrictReferrerPolicy(policy, readingReferrerPolicy(headers['referrer-policy'])) }
      const onRedirect = context ? observePolicy : undefined
      const opened = await openResource(url.href, { signal, headers, onRedirect })
      response = opened.response
      if (response.statusCode === 403 && context && opened.url && !signal.aborted) {
        observePolicy(response.headers)
        const { origin } = context
        if (permitsReferrer(opened.url, origin, policy)) {
          response.destroy()
          let includeReferrer = true
          const retry = await openResource(opened.url.href, {
            signal, headers, onRedirect,
            headersForUrl(destination, headers) {
              includeReferrer &&= destination.origin === opened.url.origin && permitsReferrer(destination, origin, policy)
              return includeReferrer ? { ...headers, Referer: `${origin}/` } : headers
            },
          })
          response = retry.response
        }
      }
      if (![200, 206, 416].includes(response.statusCode)) {
        response.destroy()
        return mediaError(502)
      }
      const contentType = response.headers['content-type'] || ''
      const isSvg = SVG_TYPE.test(contentType)
      if (response.statusCode !== 416 && !MEDIA_TYPES.test(contentType) && !isSvg) {
        response.destroy()
        return mediaError(415)
      }
      const length = Number(response.headers['content-length'])
      if (Number.isFinite(length) && length > (isSvg ? Math.min(MAX_SVG_BYTES, maxBytes) : maxBytes)) {
        response.destroy()
        return mediaError(413)
      }
      const resultHeaders = new Headers({
        'Cache-Control': response.statusCode === 416 ? 'no-store' : 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      })
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = response.headers[name]
        if (typeof value === 'string') resultHeaders.set(name, value)
      }
      if (request.method === 'HEAD' || response.statusCode === 416) {
        response.destroy()
        return new Response(null, { status: response.statusCode, headers: resultHeaders })
      }
      if (isSvg) {
        if (response.statusCode !== 200) {
          response.destroy()
          return mediaError(415)
        }
        const chunks = []
        let bytes = 0
        for await (const chunk of response) {
          bytes += chunk.byteLength
          if (bytes > Math.min(MAX_SVG_BYTES, maxBytes)) throw new Error('SVG image exceeds size limit')
          chunks.push(chunk)
        }
        const svg = sanitizeReadingSvg(Buffer.concat(chunks).toString('utf8'))
        resultHeaders.set('Content-Type', 'image/svg+xml; charset=utf-8')
        resultHeaders.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'none'")
        resultHeaders.delete('content-length')
        resultHeaders.delete('content-range')
        resultHeaders.delete('accept-ranges')
        return new Response(svg, { headers: resultHeaders })
      }
      const iterator = response[Symbol.asyncIterator]()
      let bytes = 0
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await iterator.next()
            if (next.done) { controller.close(); return }
            bytes += next.value.byteLength
            if (bytes > maxBytes) throw new Error('Media exceeds size limit')
            controller.enqueue(new Uint8Array(next.value))
          } catch (error) {
            response.destroy()
            controller.error(error)
          }
        },
        cancel() { response.destroy() },
      })
      return new Response(body, { status: response.statusCode, headers: resultHeaders })
    } catch {
      response?.destroy()
      return mediaError(502)
    }
  }
}

export const handleReadingMediaRequest = createReadingMediaHandler()
