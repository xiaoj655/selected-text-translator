import { lookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

export function publicReadingUrl(value, base) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid public HTTPS URL')
  const url = URL.parse(value.trim(), base)
  const host = url?.hostname.replace(/\.$/u, '')
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
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
    const request = https.get(url, { agent: false, lookup: publicLookup, signal, headers }, resolve)
    request.once('error', reject)
  })
}

export async function openReadingResource(value, { signal, headers = {}, requestImpl = requestResource } = {}) {
  let url = publicReadingUrl(String(value))
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await requestImpl(url, { signal, headers })
    if (!REDIRECT_STATUS.has(response.statusCode) || !response.headers.location) return { url, response }
    response.destroy()
    url = publicReadingUrl(response.headers.location, url)
  }
  throw new Error('Too many redirects')
}
