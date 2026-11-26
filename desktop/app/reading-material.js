import { el, englishText } from './tutor.js'

const IMAGE_RETRY_DELAY = 1000

function mediaLink(url, label) {
  const link = el('a', 'reading-media-status')
  link.href = url
  link.setAttribute('aria-label', label)
  return link
}

function addImageRecovery(image, articleUrl) {
  const anchor = image.closest('a[href]') || image
  if (!image.src.startsWith('stt-media://asset/')) {
    if (!articleUrl) return
    const link = mediaLink(articleUrl, 'Image unavailable. Open original ↗')
    link.hidden = true
    anchor.after(link)
    image.addEventListener('error', () => { link.hidden = false })
    image.addEventListener('load', () => { link.hidden = true })
    return
  }

  const actions = el('span', 'reading-image-actions')
  const retry = el('button', 'reading-media-status')
  // CSS renders the labels without adding to the article's text offsets.
  retry.type = 'button'
  actions.hidden = true
  actions.append(retry)
  if (articleUrl) actions.append(mediaLink(articleUrl, 'Open original ↗'))
  anchor.after(actions)

  const source = new URL(image.src)
  function retryImage() {
    retry.disabled = true
    retry.setAttribute('aria-label', 'Retrying…')
    // Bypass Chromium's cached image result without changing the publisher URL.
    source.searchParams.set('retry', crypto.randomUUID())
    image.src = source.href
  }

  function showRetry() {
    retry.disabled = false
    retry.setAttribute('aria-label', 'Retry image')
    actions.hidden = false
  }

  let autoRetry = true
  image.addEventListener('error', () => {
    if (!autoRetry) return showRetry()
    autoRetry = false
    setTimeout(() => {
      if (image.isConnected) retryImage()
      else showRetry()
    }, IMAGE_RETRY_DELAY)
  })
  image.addEventListener('load', () => { actions.hidden = true })
  retry.addEventListener('click', retryImage)
}

// HTML is normalized and sanitized in the main process before crossing IPC.
export function createReadingMaterial(article, { openLink, onError } = {}) {
  const material = englishText('div', 'reading-preview', '')
  if (article.html) {
    material.classList.add('reading-rich')
    material.innerHTML = article.html
  } else {
    material.textContent = article.text || article.excerpt || ''
  }

  for (const image of material.querySelectorAll('img')) {
    addImageRecovery(image, article.url)
  }
  for (const video of material.querySelectorAll('video')) {
    video.controls = true
    video.autoplay = false
    video.preload = 'metadata'
    let fallback = video.nextElementSibling?.querySelector('[data-reading-media-fallback]')
    if (!fallback && article.url) {
      fallback = mediaLink(article.url, 'Watch video on the original page ↗')
      video.after(fallback)
    }
    if (!fallback) continue
    const showFallback = () => { fallback.hidden = false }
    fallback.hidden = Boolean(video.getAttribute('src') || video.querySelector('source[src]'))
    video.addEventListener('error', showFallback)
    video.addEventListener('loadedmetadata', () => { fallback.hidden = true })
    for (const source of video.querySelectorAll('source')) source.addEventListener('error', showFallback)
  }
  const followLink = (event) => {
    const link = event.target.closest?.('a[href]')
    if (!link || !material.contains(link)) return
    event.preventDefault()
    if (event.type === 'auxclick' && event.button !== 1) return
    void Promise.resolve().then(() => openLink?.(link.href)).catch(() => onError?.())
  }
  material.addEventListener('click', followLink)
  material.addEventListener('auxclick', followLink)
  return material
}

export function readingFocusText(panel, scroller) {
  const viewport = scroller.getBoundingClientRect()
  const middle = (viewport.top + viewport.bottom) / 2
  const candidates = panel.querySelectorAll('.reading-preview p, .reading-preview li, .reading-preview pre, .reading-preview h1, .reading-preview h2, .reading-preview h3')
  let nearest = null
  for (const node of candidates) {
    if (node.querySelector('[data-reading-media-fallback]')) continue
    const bounds = node.getBoundingClientRect()
    if (bounds.bottom <= viewport.top + 12 || bounds.top >= viewport.bottom) continue
    const text = node.textContent.trim()
    if (!text) continue
    const distance = Math.max(bounds.top - middle, middle - bounds.bottom, 0)
    if (!nearest || distance < nearest.distance) nearest = { node, text, distance }
  }
  if (nearest?.text.length <= 1800) return nearest.text
  const material = panel.querySelector('.reading-preview')
  if (!material) return ''
  // Long blocks and plain pasted passages need the currently visible text.
  const walker = document.createTreeWalker(nearest?.node || material, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()]
    const visible = rects.filter((rect) => rect.bottom > viewport.top + 12 && rect.top < viewport.bottom)
      .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - middle) - Math.abs((b.top + b.bottom) / 2 - middle))[0]
    if (!visible) continue
    const caret = document.caretRangeFromPoint(Math.max(viewport.left + 12, visible.left + 2),
      Math.max(viewport.top + 14, visible.top + visible.height / 2))
    if (!caret || !material.contains(caret.startContainer)) return ''
    const before = range.cloneRange()
    before.selectNodeContents(material)
    before.setEnd(caret.startContainer, caret.startOffset)
    const offset = before.toString().length
    const text = material.textContent
    const start = text.lastIndexOf('\n\n', offset)
    const end = text.indexOf('\n\n', offset)
    const paragraphStart = start < 0 ? 0 : start + 2
    const paragraphEnd = end < 0 ? text.length : end
    if (paragraphEnd - paragraphStart <= 1800) return text.slice(paragraphStart, paragraphEnd).trim()
    return text.slice(Math.max(paragraphStart, offset - 600), Math.min(paragraphEnd, offset + 600)).trim()
  }
  return ''
}
