import { button, el } from './tutor.js'

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
  dock.append(reopen)
  reopen.hidden = true
  let entry = null
  let marker = null
  let expanded = false
  let collapsed = false
  let placement = ''
  let scheduled = 0

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
      position()
      return
    }
    const sourceTop = () => entry.range.getClientRects()[0]?.top
    const before = sourceTop()
    removeMarker()
    placement = next
    dock.dataset.placement = next === 'inline' ? 'collapsed' : next
    panel.dataset.placement = next
    panel.style.left = panel.style.top = panel.style.width = ''
    panel.hidden = collapsed
    reopen.hidden = !collapsed
    dock.hidden = next === 'inline'
    if (next === 'inline') {
      marker = insertMarker(entry)
      scroller.append(panel)
      position()
    } else {
      dock.append(panel)
    }
    const after = sourceTop()
    if (Number.isFinite(before) && Number.isFinite(after)) scroller.scrollTop += after - before
    schedulePosition()
  }

  scroller.addEventListener('scroll', schedulePosition)
  wide.addEventListener('change', refresh)
  const observer = new ResizeObserver(schedulePosition)
  observer.observe(scroller)
  observer.observe(panel)

  return {
    open(current) {
      entry = current
      collapsed = false
      expanded = current.mode === 'guide'
      refresh()
    },
    close() {
      removeMarker()
      entry = null
      placement = ''
      panel.hidden = reopen.hidden = dock.hidden = true
    },
    reopen: reveal,
    collapse() { collapsed = true; refresh() },
    expand() { expanded = true; refresh() },
    position,
  }
}
