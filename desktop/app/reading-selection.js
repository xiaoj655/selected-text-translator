// Keep the original text and UTF-16 offsets used by the shared translation API.
function materialFor(node, root) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  const material = element?.closest('.reading-preview[data-reading-selectable]')
  return material && root.contains(material) ? material : null
}

export function readingSelection(root) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const material = materialFor(range.startContainer, root)
  if (!material || material !== materialFor(range.endContainer, root)) return null
  return selectionFromRange(material, range)
}

export function readingWordAt(root, x, y) {
  const range = document.caretRangeFromPoint(x, y)
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null
  const material = materialFor(range.startContainer, root)
  if (!material) return null
  const node = range.startContainer
  const offset = range.startOffset
  for (const match of node.textContent.matchAll(/\p{L}[\p{L}\p{N}]*(?:['’\-‐‑][\p{L}\p{N}]+)*/gu)) {
    if (offset < match.index || offset > match.index + match[0].length) continue
    const word = document.createRange()
    word.setStart(node, match.index)
    word.setEnd(node, match.index + match[0].length)
    // A caret in whitespace can resolve to the end of the preceding word.
    if (![...word.getClientRects()].some((rect) => x >= rect.left - 1 && x <= rect.right + 1
      && y >= rect.top && y <= rect.bottom)) continue
    return selectionFromRange(material, word)
  }
  return null
}

function selectionFromRange(material, originalRange) {
  const raw = originalRange.toString()
  const text = raw.trim()
  if (!text || text.length > 12000) return null
  const before = document.createRange()
  before.selectNodeContents(material)
  before.setEnd(originalRange.startContainer, originalRange.startOffset)
  const start = before.toString().length + raw.length - raw.trimStart().length
  const end = start + text.length
  const fullText = material.textContent
  if (fullText.slice(start, end) !== text) return null
  // Centre a bounded context on the exact occurrence, including words near the
  // end of long pasted articles. Do not truncate the article from its beginning.
  let windowStart = Math.max(0, start - Math.floor(Math.max(0, 2400 - text.length) / 2))
  windowStart = Math.min(windowStart, Math.max(0, fullText.length - 2400))
  if (/[\uDC00-\uDFFF]/u.test(fullText[windowStart] || '')) windowStart += 1
  let windowEnd = Math.min(fullText.length, windowStart + 2400)
  if (/[\uD800-\uDBFF]/u.test(fullText[windowEnd - 1] || '')) windowEnd -= 1
  const hasContext = text.length <= 2400 && end <= windowEnd
  const range = originalRange.cloneRange()
  return {
    material, range, text,
    context: hasContext ? fullText.slice(windowStart, windowEnd) : '',
    contextStart: hasContext ? start - windowStart : null,
    contextEnd: hasContext ? end - windowStart : null,
  }
}
