import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createReadingMediaHandler } from '../src/reading-media.js'
import { isPublicReadingAddress, openReadingResource, publicReadingUrl } from '../src/reading-network.js'

const target = 'https://cdn.publisher.com/movie.mp4'
const mediaRequest = (url = target, init) => new Request(`stt-media://asset/?url=${encodeURIComponent(url)}`, init)

function upstream(chunks, headers = {}, statusCode = 200) {
  const response = Readable.from(chunks.map((value) => Buffer.from(value)))
  response.statusCode = statusCode
  response.headers = headers
  return response
}

test('public URL and address checks reject private networks, credentials and unsupported schemes', () => {
  for (const url of ['http://publisher.com/a', 'file:///tmp/a', 'https://127.0.0.1/a', 'https://user:pass@publisher.com/a', 'https://site.local/a']) {
    assert.throws(() => publicReadingUrl(url))
  }
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPublicReadingAddress(ip), false, ip)
  }
  assert.equal(isPublicReadingAddress('8.8.8.8'), true)
  assert.equal(isPublicReadingAddress('2606:4700:4700::1111'), true)
})

test('every resource redirect is checked before opening the next connection', async () => {
  let requested = 0
  await assert.rejects(openReadingResource(target, { requestImpl: async () => {
    requested += 1
    return upstream([], { location: 'https://127.0.0.1/private' }, 302)
  } }))
  assert.equal(requested, 1)
  const opened = await openReadingResource(target, { requestImpl: async (url) =>
    url.pathname === '/movie.mp4' ? upstream([], { location: '/final.mp4' }, 302) : upstream(['video']) })
  assert.equal(opened.url.href, 'https://cdn.publisher.com/final.mp4')
  opened.response.destroy()
})

test('native media is streamed with byte ranges while credentials and upstream headers stay private', async () => {
  const handler = createReadingMediaHandler({ openResource: async (url, { headers }) => {
    assert.equal(url, target)
    assert.equal(headers.Range, 'bytes=2-5')
    assert.equal(headers.Cookie, undefined)
    assert.equal(headers.Authorization, undefined)
    return { response: upstream(['2345'], {
      'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 2-5/100',
      'accept-ranges': 'bytes', 'set-cookie': 'secret=value',
    }, 206) }
  } })
  const response = await handler(mediaRequest(target, { headers: { Range: 'bytes=2-5', Cookie: 'private' } }))
  assert.equal(response.status, 206)
  assert.equal(await response.text(), '2345')
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/100')
  assert.equal(response.headers.get('set-cookie'), null)
})

test('temporary upstream failures are not cached and a fresh request can serve the image', async () => {
  let requests = 0
  const handler = createReadingMediaHandler({ openResource: async () => {
    requests += 1
    if (requests === 1) throw new Error('Connection reset')
    if (requests === 2) return { response: upstream([], {}, 503) }
    return { response: upstream(['image'], { 'content-type': 'image/png' }) }
  } })
  const request = () => mediaRequest('https://cdn.publisher.com/image.png')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handler(request())
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const response = await handler(request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, max-age=300')
  assert.equal(await response.text(), 'image')
})

test('unsafe destinations, active content and oversized media fail without exposing a usable response', async () => {
  const neverOpen = createReadingMediaHandler({ openResource: () => assert.fail('Must reject before network') })
  assert.equal((await neverOpen(mediaRequest('https://127.0.0.1/private'))).status, 502)
  assert.equal((await neverOpen(mediaRequest(target, { headers: { Range: 'bytes=1-2,3-4' } }))).status, 416)
  for (const type of ['text/html', 'application/javascript']) {
    const handler = createReadingMediaHandler({ openResource: async () => ({ response: upstream(['bad'], { 'content-type': type }) }) })
    assert.equal((await handler(mediaRequest())).status, 415)
  }
  const knownSize = createReadingMediaHandler({ maxBytes: 3, openResource: async () => ({ response: upstream(['large'], {
    'content-type': 'image/png', 'content-length': '5',
  }) }) })
  assert.equal((await knownSize(mediaRequest())).status, 413)
  const streaming = createReadingMediaHandler({ maxBytes: 3, openResource: async () => ({ response: upstream(['12', '34'], { 'content-type': 'image/png' }) }) })
  await assert.rejects((await streaming(mediaRequest())).arrayBuffer(), /size limit/u)
})

test('SVG diagrams retain static shapes while removing active elements and external resources', async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" onload="bad()">
    <defs><linearGradient id="gradient"><stop offset="0" stop-color="red"/></linearGradient></defs>
    <rect width="100" height="50" fill="url(#gradient)"/><text x="5" y="20">A diagram</text>
    <script>bad()</script><foreignObject><div>unsafe</div></foreignObject><style>external()</style>
    <image href="https://tracker.com/image"/><use href="https://tracker.com/external#shape"/>
    <path fill="url(https://tracker.com/fill)" d="M0 0 L5 5"/><animate attributeName="href" values="https://tracker.com"/>
    </svg>`
  const handler = createReadingMediaHandler({ openResource: async () => ({ response: upstream([svg], { 'content-type': 'image/svg+xml' }) }) })
  const response = await handler(mediaRequest('https://cdn.publisher.com/diagram.svg'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-security-policy'), /sandbox; default-src 'none'/u)
  const content = await response.text()
  assert.match(content, /viewBox="0 0 100 50"/u)
  assert.match(content, /<linearGradient/u)
  assert.match(content, /fill="url\(#gradient\)"/u)
  assert.match(content, /A diagram/u)
  assert.doesNotMatch(content, /script|onload|foreignObject|<style|<image|<animate|tracker.com|bad\(\)|unsafe|external\(\)/u)
})
