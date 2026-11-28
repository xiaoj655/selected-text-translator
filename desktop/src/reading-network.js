import http from 'node:http'
import { lookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const REFERRER_POLICIES = new Set(['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
  'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'])

export function readingReferrerPolicy(value) {
  if (Array.isArray(value)) value = value.join(',')
  if (typeof value !== 'string') return ''
  return value.split(',').map((policy) => policy.trim().toLowerCase())
    .findLast((policy) => REFERRER_POLICIES.has(policy)) || ''
}

export function publicReadingUrl(value, base, { allowHttp = false } = {}) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid public HTTPS URL')
  const url = URL.parse(value.trim(), base)
  const host = url?.hostname.replace(/\.$/u, '')
  const validProtocol = url && (url.protocol === 'https:' || (allowHttp && url.protocol === 'http:'))
  if (!validProtocol || url.username || url.password || url.port
    || !host.includes('.') || isIP(host) || /\.(?:localhost|local|internal|test|invalid|example)$/u.test(host)
    || host.endsWith('.home.arpa') || url.href.length > 4096) throw new Error('Invalid public HTTPS URL')
  url.hash = ''
  return url
}

export function isPublicReadingAddress(address) {
  try {
    const ip = ipaddr.process(address)
    return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || ip.match(ipaddr.IPv6.parse('2000::'), 3))
  } catch {
    return false
  }
}

export function publicLookup(host, options, callback) {
  // The socket receives the checked address, with no second DNS resolution.
  lookup(host, { family: options.family, all: true, hints: options.hints }, (error, addresses) => {
    if (error) return callback(error)
    const publicAddresses = addresses.filter(({ address }) => isPublicReadingAddress(address))
    if (!publicAddresses.length) return callback(Object.assign(new Error('Private network address'), { code: 'STT_PRIVATE_ADDRESS' }))
    if (options.all) return callback(null, publicAddresses)
    return callback(null, publicAddresses[0].address, publicAddresses[0].family)
  })
}

function requestResource(url, { signal, headers }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'http:' ? http : https
    const request = client.get(url, { agent: false, lookup: publicLookup, signal, headers }, resolve)
    request.once('error', reject)
  })
}

export async function openReadingResource(value, {
  signal, headers = {}, headersForUrl, onRedirect, requestImpl = requestResource, allowHttp = false,
} = {}) {
  let url = publicReadingUrl(String(value), undefined, { allowHttp })
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await requestImpl(url, { signal, headers: headersForUrl?.(url, headers) ?? headers })
    if (!REDIRECT_STATUS.has(response.statusCode) || !response.headers.location) return { url, response }
    response.destroy()
    onRedirect?.(response.headers)
    url = publicReadingUrl(response.headers.location, url, { allowHttp })
  }
  throw new Error('Too many redirects')
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value[0] : value]))
}

function wrapResponse(response, cleanup) {
  response.once('end', cleanup)
  response.once('close', cleanup)
  response.once('error', cleanup)
  return {
    statusCode: response.statusCode,
    headers: normalizeHeaders(response.headers),
    destroy: response.destroy.bind(response),
    [Symbol.asyncIterator]: () => response[Symbol.asyncIterator](),
  }
}

function electronRequest(netModule) {
  return (url, { signal, headers }) => new Promise((resolve, reject) => {
    let settled = false
    const request = netModule.request({
      url: url.href,
      method: 'GET',
      redirect: 'manual',
      useSessionCookies: false,
      headers,
    })
    const abort = () => request.abort()
    const cleanup = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    request.on('response', (response) => {
      settled = true
      resolve(wrapResponse(response, cleanup))
    })
    request.on('redirect', (statusCode, _method, _redirectUrl, responseHeaders) => {
      if (settled) return
      settled = true
      cleanup()
      request.abort()
      resolve({ statusCode, headers: normalizeHeaders(responseHeaders), destroy() {} })
    })
    request.on('error', (error) => {
      if (!settled) {
        cleanup()
        reject(error)
      }
    })
    request.end()
  })
}

export function createElectronReadingResource(netModule) {
  const requestImpl = electronRequest(netModule)
  return (value, options) => openReadingResource(value, { ...options, requestImpl, allowHttp: true })
}
