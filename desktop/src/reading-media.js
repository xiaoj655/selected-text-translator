import { openReadingResource, publicReadingUrl } from './reading-network.js'
import { sanitizeReadingSvg } from './reading-svg.js'

const MAX_MEDIA_BYTES = 256 * 1024 * 1024
const MAX_SVG_BYTES = 2 * 1024 * 1024
const SVG_TYPE = /^image\/svg\+xml(?:\s*;|$)/iu
const MEDIA_TYPES = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/(?:mp4|webm|ogg|quicktime|x-m4v)|audio\/(?:mpeg|mp4|ogg|wav|x-wav|webm|flac))(?:\s*;|$)/iu
const RANGE = /^bytes=(?:\d+-\d*|-\d+)$/u

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
      const opened = await openResource(url.href, { signal, headers })
      response = opened.response
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
