import { button, el } from './tutor.js'

const WIDTH_KEY = 'desktop_reading_lookup_width'
const MIN_WIDTH = 280
const MAX_WIDTH = 720
const MIN_READING_WIDTH = 440

// Keep the first visible line in place while the prose wraps to a new width.
function readingAnchor(scroller) {
  if (scroller.scrollTop <= 0) return null
  const viewportTop = scroller.getBoundingClientRect().top
  const top = viewportTop + 1
  for (const material of scroller.querySelectorAll('.reading-preview')) {
    const bounds = material.getBoundingClientRect()
    if (bounds.top > top || bounds.bottom <= top) continue
    const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      range.selectNodeContents(text)
      if (range.getBoundingClientRect().bottom <= top) continue
      let start = 0
      let end = text.length
      while (start < end) {
        const middle = Math.floor((start + end) / 2)
        range.setStart(text, middle)
        range.collapse(true)
        if (range.getBoundingClientRect().bottom <= top) start = middle + 1
        else end = middle
      }
      range.setStart(text, start)
      range.collapse(true)
      return { range, offset: range.getBoundingClientRect().top - viewportTop }
    }
  }
  return null
}

function restoreAnchor(scroller, anchor) {
  if (anchor && scroller.contains(anchor.range.startContainer)) {
    const offset = anchor.range.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += offset - anchor.offset
  }
}

export function createReadingLookupLayout({ panel, scroller, dock }) {
  const wide = matchMedia('(min-width: 920px)')
  const shell = scroller.parentElement
  const resize = el('div', 'reading-lookup-resize')
  resize.id = 'reading-lookup-resize'
  resize.title = 'Drag to resize. Double-click to reset.'
  resize.setAttribute('role', 'separator')
  resize.setAttribute('aria-label', 'Resize translation sidebar')
  resize.setAttribute('aria-orientation', 'vertical')
  resize.tabIndex = 0
  resize.hidden = true
  const reopen = button('Show lookup', 'reading-lookup-reopen', reveal, 'reading-lookup-reopen')
  function reveal() {
    place(wide.matches ? 'side' : 'bottom')
  }
  dock.append(resize, reopen)
  reopen.hidden = true
  let placement = ''
  let anchorFrame = 0
  let currentAnchor = null
  let shellWidth = shell.clientWidth
  let shellHeight = shell.clientHeight
  let preferredWidth = null
  let widthTouched = false
  let drag = null

  function rememberAnchor() {
    currentAnchor = placement ? readingAnchor(scroller) : null
  }

  function widthLimits() {
    return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, shell.clientWidth - MIN_READING_WIDTH)) }
  }

  function applyWidth(value = preferredWidth, anchor) {
    if (placement !== 'side') return
    const { min, max } = widthLimits()
    const wanted = value ?? Math.max(310, Math.min(460, shell.clientWidth * 0.30))
    const width = Math.round(Math.max(min, Math.min(max, wanted)))
    resize.setAttribute('aria-valuemin', String(min))
    resize.setAttribute('aria-valuemax', String(max))
    resize.setAttribute('aria-valuenow', String(width))
    if (Math.abs(dock.getBoundingClientRect().width - width) < 0.5) return
    const held = anchor === undefined ? readingAnchor(scroller) : anchor
    shell.style.setProperty('--reading-lookup-width', `${width}px`)
    restoreAnchor(scroller, held)
    rememberAnchor()
  }

  function saveWidth() {
    void chrome.storage.local.set({ [WIDTH_KEY]: preferredWidth }).catch(() => {})
  }

  function endResize() {
    if (!drag) return
    const current = drag
    drag = null
    shell.classList.remove('is-resizing-lookup')
    if (resize.hasPointerCapture(current.pointerId)) resize.releasePointerCapture(current.pointerId)
    if (current.moved) saveWidth()
  }

  resize.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || placement !== 'side') return
    event.preventDefault()
    const shellBounds = shell.getBoundingClientRect()
    const style = getComputedStyle(shell)
    const articleWidth = style.getPropertyValue('--article-width').trim()
    const readingLimit = articleWidth.endsWith('%') ? shellBounds.width
      : parseFloat(articleWidth) + parseFloat(style.getPropertyValue('--reading-column-gutter'))
    const offset = dock.getBoundingClientRect().left - event.clientX - shellBounds.left
    drag = { pointerId: event.pointerId, offset, shellWidth: shellBounds.width, readingLimit,
      anchor: readingAnchor(scroller), moved: false }
    resize.setPointerCapture(event.pointerId)
    shell.classList.add('is-resizing-lookup')
  })
  resize.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const { min, max } = widthLimits()
    const divider = event.clientX + drag.offset
    // Once the article reaches its maximum width, both outside margins grow as the dock shrinks.
    const wanted = Math.min(drag.shellWidth - divider, drag.shellWidth + drag.readingLimit - 2 * divider)
    preferredWidth = Math.round(Math.max(min, Math.min(max, wanted)))
    widthTouched = drag.moved = true
    applyWidth(preferredWidth, drag.anchor)
  })
  resize.addEventListener('pointerup', endResize)
  resize.addEventListener('pointercancel', endResize)
  resize.addEventListener('lostpointercapture', endResize)
  resize.addEventListener('dblclick', (event) => {
    event.preventDefault()
    endResize()
    widthTouched = true
    preferredWidth = null
    applyWidth()
    void chrome.storage.local.remove(WIDTH_KEY).catch(() => {})
  })
  resize.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') { resize.dispatchEvent(new MouseEvent('dblclick')); return }
    const { min, max } = widthLimits()
    const delta = (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 16)
    preferredWidth = Math.round(Math.max(min, Math.min(max, dock.getBoundingClientRect().width + delta)))
    widthTouched = true
    applyWidth()
    saveWidth()
  })
  void chrome.storage.local.get(WIDTH_KEY).then((values) => {
    const saved = values?.[WIDTH_KEY]
    if (widthTouched || !Number.isFinite(saved) || saved < MIN_WIDTH || saved > MAX_WIDTH) return
    preferredWidth = saved
    applyWidth()
  }).catch(() => {})

  function place(next, anchor) {
    if (placement === next) return
    const held = anchor === undefined ? readingAnchor(scroller) : anchor
    endResize()
    placement = next
    shellWidth = shell.clientWidth
    shellHeight = shell.clientHeight
    dock.dataset.placement = panel.dataset.placement = next
    dock.hidden = !next
    panel.hidden = !next || next === 'collapsed'
    resize.hidden = next !== 'side'
    reopen.hidden = next !== 'collapsed'
    applyWidth(preferredWidth, null)
    restoreAnchor(scroller, held)
    rememberAnchor()
  }

  scroller.addEventListener('scroll', () => {
    if (!placement || anchorFrame) return
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = 0
      // Let ResizeObserver restore the last anchor before recording the new one.
      if (shellWidth === shell.clientWidth && shellHeight === shell.clientHeight) rememberAnchor()
    })
  })
  const observer = new ResizeObserver(() => {
    const width = shell.clientWidth
    const height = shell.clientHeight
    if (width === shellWidth && height === shellHeight) return
    shellWidth = width
    shellHeight = height
    if (!placement || !width) return
    const anchor = currentAnchor
    const next = placement === 'collapsed' ? placement : wide.matches ? 'side' : 'bottom'
    if (next !== placement) place(next, anchor)
    else {
      applyWidth(preferredWidth, null)
      restoreAnchor(scroller, anchor)
      rememberAnchor()
    }
  })
  observer.observe(shell)

  return {
    open(current) {
      if (wide.matches || placement === 'bottom') {
        reveal()
        return
      }
      const source = current.range.getClientRects()[0]
      const viewport = scroller.getBoundingClientRect()
      const wasVisible = source && source.bottom > viewport.top && source.top < viewport.bottom
      reveal()
      if (!wasVisible) return
      const line = current.range.getClientRects()[0]
      const bottom = scroller.getBoundingClientRect().bottom
      if (line && line.bottom > bottom) {
        scroller.scrollTop += line.bottom - bottom + 12
        rememberAnchor()
      }
    },
    close() { place('') },
    reopen: reveal,
    collapse() { place('collapsed') },
  }
}
