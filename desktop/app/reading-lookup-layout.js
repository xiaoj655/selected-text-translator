import { button, el } from './tutor.js'

const WIDTH_KEY = 'desktop_reading_lookup_width'
const MIN_WIDTH = 280
const MAX_WIDTH = 720
const MIN_READING_WIDTH = 440

// Keep the first visible line in place while the prose wraps to a new width.
function readingAnchor(scroller) {
  if (scroller.scrollTop <= 0) return null
  const top = scroller.getBoundingClientRect().top + 1
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
      return { range, top: range.getBoundingClientRect().top }
    }
  }
  return null
}

// The empty marker reserves space in the prose. The controls stay outside the
// text node tree so copying and context offsets only see the original article.
function insertMarker(entry) {
  const walker = document.createTreeWalker(entry.material, NodeFilter.SHOW_TEXT)
  let remaining = entry.sentenceEnd
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (remaining <= node.length) {
      const marker = el('span', 'reading-lookup-space')
      marker.setAttribute('aria-hidden', 'true')
      if (remaining === 0) node.before(marker)
      else if (remaining === node.length) node.after(marker)
      else node.splitText(remaining).before(marker)
      return marker
    }
    remaining -= node.length
  }
  return null
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
    collapsed = false
    refresh()
    if (placement === 'inline') {
      const source = entry.range.getClientRects()[0]
      const viewport = scroller.getBoundingClientRect()
      if (source && (source.top < viewport.top || source.bottom > viewport.bottom)) {
        scroller.scrollTop += source.top - viewport.top - 16
        position()
      }
    }
  }
  dock.append(resize, reopen)
  reopen.hidden = true
  let entry = null
  let marker = null
  let expanded = false
  let collapsed = false
  let placement = ''
  let scheduled = 0
  let preferredWidth = null
  let widthTouched = false
  let drag = null

  function widthLimits() {
    return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, shell.clientWidth - MIN_READING_WIDTH)) }
  }

  function applyWidth(value = preferredWidth, anchor) {
    if (placement !== 'side') return
    const { min, max } = widthLimits()
    const wanted = value ?? Math.max(310, Math.min(384, innerWidth * 0.29))
    const width = Math.round(Math.max(min, Math.min(max, wanted)))
    resize.setAttribute('aria-valuemin', String(min))
    resize.setAttribute('aria-valuemax', String(max))
    resize.setAttribute('aria-valuenow', String(width))
    if (Math.abs(dock.getBoundingClientRect().width - width) < 0.5) return
    const held = anchor === undefined ? readingAnchor(scroller) : anchor
    dock.style.setProperty('--reading-lookup-width', `${width}px`)
    if (held && scroller.contains(held.range.startContainer)) {
      scroller.scrollTop += held.range.getBoundingClientRect().top - held.top
    }
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
    drag = { pointerId: event.pointerId, x: event.clientX, width: dock.getBoundingClientRect().width,
      anchor: readingAnchor(scroller), moved: false }
    resize.setPointerCapture(event.pointerId)
    shell.classList.add('is-resizing-lookup')
  })
  resize.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const { min, max } = widthLimits()
    preferredWidth = Math.round(Math.max(min, Math.min(max, drag.width + drag.x - event.clientX)))
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

  function position() {
    if (!entry || placement !== 'inline' || !marker?.isConnected) return
    const rect = marker.getBoundingClientRect()
    const bounds = scroller.getBoundingClientRect()
    panel.style.left = `${rect.left - bounds.left - scroller.clientLeft}px`
    panel.style.width = `${rect.width}px`
    panel.style.top = `${rect.top - bounds.top - scroller.clientTop + scroller.scrollTop}px`
    marker.style.height = `${panel.offsetHeight}px`
    const inView = rect.top < bounds.bottom && rect.top + panel.offsetHeight > bounds.top
    reopen.hidden = inView
    dock.hidden = inView
  }

  function schedulePosition() {
    if (!scheduled) scheduled = requestAnimationFrame(() => {
      scheduled = 0
      applyWidth()
      position()
    })
  }

  function removeMarker() {
    if (!marker) return
    marker.remove()
    marker = null
  }

  function refresh() {
    if (!entry) return
    const next = collapsed ? 'collapsed' : wide.matches ? 'side' : expanded ? 'bottom' : 'inline'
    if (placement === next) {
      applyWidth()
      position()
      return
    }
    endResize()
    const sourceTop = () => entry.range.getClientRects()[0]?.top
    const before = sourceTop()
    removeMarker()
    placement = next
    dock.dataset.placement = next === 'inline' ? 'collapsed' : next
    panel.dataset.placement = next
    panel.style.left = panel.style.top = panel.style.width = ''
    panel.hidden = collapsed
    resize.hidden = next !== 'side'
    reopen.hidden = !collapsed
    dock.hidden = next === 'inline'
    if (next === 'inline') {
      marker = insertMarker(entry)
      scroller.append(panel)
      position()
    } else {
      dock.append(panel)
    }
    applyWidth(preferredWidth, null)
    const after = sourceTop()
    if (Number.isFinite(before) && Number.isFinite(after)) scroller.scrollTop += after - before
    schedulePosition()
  }

  scroller.addEventListener('scroll', schedulePosition)
  wide.addEventListener('change', refresh)
  const observer = new ResizeObserver(schedulePosition)
  observer.observe(scroller)
  observer.observe(panel)
  observer.observe(shell)

  return {
    open(current) {
      entry = current
      collapsed = false
      expanded = current.mode === 'guide'
      refresh()
    },
    close() {
      const anchor = entry ? readingAnchor(scroller) : null
      endResize()
      removeMarker()
      entry = null
      placement = ''
      panel.hidden = reopen.hidden = resize.hidden = dock.hidden = true
      if (anchor && scroller.contains(anchor.range.startContainer)) {
        scroller.scrollTop += anchor.range.getBoundingClientRect().top - anchor.top
      }
    },
    reopen: reveal,
    collapse() { collapsed = true; refresh() },
    expand() { expanded = true; refresh() },
    position,
  }
}
