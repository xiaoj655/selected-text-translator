import sanitizeHtml from 'sanitize-html'
import { parseHTML } from 'linkedom'
import { parseFragment, serialize } from 'parse5'
import { publicReadingUrl } from './reading-network.js'
import { sanitizeReadingSvg } from './reading-svg.js'

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,div,section,article,blockquote,pre,ul,ol,li,dl,dt,dd,figure,figcaption,table,tr,caption,details,summary,hr'
const ALLOWED_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'article', 'blockquote',
  'pre', 'code', 'kbd', 'samp', 'var', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'a', 'strong',
  'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sup', 'sub', 'small', 'mark', 'abbr', 'span', 'br',
  'hr', 'img', 'video', 'source', 'details', 'summary']

function safeUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try { return publicReadingUrl(value, baseUrl).href } catch { return '' }
}

function mediaUrl(value, baseUrl) {
  const url = safeUrl(value, baseUrl)
  return url ? `stt-media://asset/?url=${encodeURIComponent(url)}` : ''
}

function documentBody(html) {
  const { document } = parseHTML('<html><body></body></html>')
  document.body.innerHTML = html
  return document.body
}

function textNodes(root) {
  const nodes = []
  const walker = root.ownerDocument.createTreeWalker(root, 4)
  while (walker.nextNode()) nodes.push(walker.currentNode)
  return nodes
}

function normalizeWhitespace(root) {
  const nodes = textNodes(root)
  const output = new Map(nodes.map((node) => [node, '']))
  let pendingNode
  let pendingNewlines = 0
  let pendingTab = false
  let hasText = false
  let trailingNewlines = 0
  let endsInWhitespace = false
  function flush() {
    if (pendingNode && hasText) {
      const separator = pendingNewlines ? '\n'.repeat(Math.max(0, pendingNewlines - trailingNewlines))
        : endsInWhitespace ? '' : pendingTab ? '\t' : ' '
      output.set(pendingNode, output.get(pendingNode) + separator)
    }
    pendingNode = undefined
    pendingNewlines = 0
    pendingTab = false
  }
  for (const node of nodes) {
    if (node.parentElement?.closest('pre')) {
      flush()
      output.set(node, node.data)
      hasText ||= Boolean(node.data)
      trailingNewlines = /\n*$/u.exec(node.data)[0].length
      endsInWhitespace = /\s$/u.test(node.data)
      continue
    }
    for (const part of node.data.split(/(\s+)/u)) {
      if (!part) continue
      if (/^\s+$/u.test(part)) {
        pendingNode ||= node
        pendingNewlines = Math.min(2, pendingNewlines + (part.match(/\n/gu)?.length || 0))
        pendingTab ||= part.includes('\t')
      } else {
        flush()
        output.set(node, output.get(node) + part)
        hasText = true
        trailingNewlines = 0
        endsInWhitespace = false
      }
    }
  }
  // Unflushed whitespace at the end is discarded; preformatted text is intact.
  for (const node of nodes) node.data = output.get(node)
}

function fallback(document, baseUrl, kind = 'video') {
  const link = document.createElement('a')
  link.href = baseUrl
  link.setAttribute('data-reading-media-fallback', kind)
  link.textContent = kind === 'video' ? 'Watch video on the original page ↗' : 'View diagram on the original page ↗'
  const paragraph = document.createElement('p')
  paragraph.append(link)
  return paragraph
}

export function normalizeReadingContent(html, { baseUrl } = {}) {
  const base = safeUrl(baseUrl, undefined)
  // Some feeds wrap content in a full HTML document and append a footer after
  // it. Parse it as a fragment before passing it to the inert DOM.
  const body = documentBody(serialize(parseFragment(typeof html === 'string' ? html : '')))
  const generatedImages = new Set()
  // Preprocess in an inert Node DOM. Only this module creates renderer markers.
  for (const element of body.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith('data-reading-')) element.removeAttribute(attribute.name)
    }
  }
  for (const embed of body.querySelectorAll('iframe,object,embed')) {
    if (base) embed.replaceWith(fallback(body.ownerDocument, base))
    else embed.remove()
  }
  for (const image of body.querySelectorAll('img')) {
    const candidates = [image.getAttribute('data-src'), image.getAttribute('data-original'), image.getAttribute('data-lazy-src'),
      image.getAttribute('src'), image.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s/u)[0]]
    const src = candidates.map((candidate) => mediaUrl(candidate, base)).find(Boolean)
    if (src) {
      image.setAttribute('src', src)
      image.setAttribute('loading', 'lazy')
      image.setAttribute('decoding', 'async')
    } else {
      image.replaceWith(body.ownerDocument.createTextNode(image.getAttribute('alt') || 'Image unavailable'))
    }
  }
  // Only SVG images produced here may use data URLs. Original img data sources
  // went through the public-HTTPS validation above and cannot enter this set.
  for (const svg of body.querySelectorAll('svg')) {
    if (!body.contains(svg)) continue
    try {
      const original = svg.outerHTML
      if (Buffer.byteLength(original) > 2 * 1024 * 1024) throw new Error('Diagram is too large')
      const staticSvg = sanitizeReadingSvg(serialize(parseFragment(original)))
      const image = body.ownerDocument.createElement('img')
      const src = `data:image/svg+xml;base64,${Buffer.from(staticSvg).toString('base64')}`
      generatedImages.add(src)
      image.src = src
      image.alt = (svg.querySelector('title')?.textContent || svg.querySelector('desc')?.textContent || 'Diagram').trim().slice(0, 1000)
      image.setAttribute('loading', 'lazy')
      image.setAttribute('decoding', 'async')
      svg.replaceWith(image)
    } catch {
      if (base) svg.replaceWith(fallback(body.ownerDocument, base, 'image'))
      else svg.replaceWith(body.ownerDocument.createTextNode('Diagram unavailable. Open the original page to view it.'))
    }
  }
  for (const video of body.querySelectorAll('video')) {
    const src = mediaUrl(video.getAttribute('src'), base)
    if (src) video.setAttribute('src', src)
    else video.removeAttribute('src')
    const poster = mediaUrl(video.getAttribute('poster'), base)
    if (poster) video.setAttribute('poster', poster)
    else video.removeAttribute('poster')
    video.setAttribute('controls', '')
    video.setAttribute('preload', 'metadata')
    video.setAttribute('data-reading-video', '')
    for (const source of video.querySelectorAll('source')) {
      const sourceUrl = mediaUrl(source.getAttribute('src'), base)
      if (sourceUrl) source.setAttribute('src', sourceUrl)
      else source.remove()
    }
    if (base) video.after(fallback(body.ownerDocument, base))
  }
  for (const source of body.querySelectorAll('source')) {
    if (!source.parentElement?.closest('video')) source.remove()
  }
  const clean = sanitizeHtml(body.innerHTML, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'data-reading-media-fallback'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding', 'referrerpolicy'],
      video: ['src', 'poster', 'controls', 'preload', 'data-reading-video'],
      source: ['src', 'type'], th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'],
      col: ['span'], ol: ['start', 'reversed', 'type'], li: ['value'], abbr: ['title'],
    },
    allowedSchemes: ['https', 'stt-media'],
    allowedSchemesByTag: { a: ['https'], img: ['stt-media', 'data'], video: ['stt-media'], source: ['stt-media'] },
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'svg', 'math', 'template'],
    transformTags: {
      a(tagName, attributes) {
        const href = safeUrl(attributes.href, base)
        return { tagName, attribs: { ...attributes, href, rel: 'noreferrer noopener' } }
      },
      img(tagName, attributes) {
        if (attributes.src?.startsWith('data:') && !generatedImages.has(attributes.src)) delete attributes.src
        return { tagName, attribs: attributes }
      },
    },
    nestingLimit: 100,
  })
  // Canonicalize with the HTML5 tree builder before indexing. In particular,
  // malformed tables otherwise move text when Chromium reparses the HTML.
  const normalized = documentBody(serialize(parseFragment(clean)))
  for (const node of textNodes(normalized)) {
    if (!node.parentElement?.closest('pre')) node.data = node.data.replace(/\s+/gu, ' ')
  }
  for (const element of normalized.querySelectorAll(BLOCKS)) {
    element.before('\n\n')
    element.after('\n\n')
  }
  for (const element of normalized.querySelectorAll('br')) element.after('\n')
  for (const cell of normalized.querySelectorAll('th,td')) {
    if (cell.nextElementSibling) cell.after('\t')
  }
  normalizeWhitespace(normalized)
  return { html: normalized.innerHTML.toWellFormed(), text: normalized.textContent.toWellFormed() }
}

export function plainReadingContent(text) {
  const body = documentBody('')
  const paragraph = body.ownerDocument.createElement('p')
  paragraph.setAttribute('data-reading-plain', '')
  paragraph.textContent = typeof text === 'string' ? text.replace(/\r\n?/gu, '\n').trim().toWellFormed() : ''
  body.append(paragraph)
  return { html: body.innerHTML, text: paragraph.textContent }
}
