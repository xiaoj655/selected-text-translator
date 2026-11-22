// Shared result presentation. Callers own request state, actions, and persistence.
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SENTENCE_ROLES = { subject: 'Subject', verb: 'Verb', object: 'Object', complement: 'Complement' }

export function sentenceStructure(entry) {
  const structure = entry.guide?.structure
  if (entry.mode !== 'guide' || entry.status !== 'done' || entry.guide?.guideType !== 'sentence'
    || !Array.isArray(structure)) return []

  let previousEnd = 0
  for (const span of structure) {
    if (!span || typeof span.role !== 'string' || !Object.hasOwn(SENTENCE_ROLES, span.role)
      || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < previousEnd || span.end <= span.start || span.end > entry.text.length) return []
    previousEnd = span.end
  }
  return structure
}

export function markSentence(node, text, structure) {
  const fragment = document.createDocumentFragment()
  let offset = 0
  for (const { role, start, end } of structure) {
    fragment.append(text.slice(offset, start))
    const mark = el('mark', 'sentence-mark', text.slice(start, end))
    mark.dataset.role = role
    fragment.append(mark)
    offset = end
  }
  fragment.append(text.slice(offset))
  node.replaceChildren(fragment)
}

export function renderSentenceLegend(structure) {
  const roles = new Set(structure.map(({ role }) => role))
  const legend = el('ul', 'sentence-legend')
  legend.setAttribute('aria-label', 'Sentence structure')
  for (const [role, label] of Object.entries(SENTENCE_ROLES)) {
    if (!roles.has(role)) continue
    const item = el('li')
    const swatch = el('span', 'sentence-swatch')
    swatch.dataset.role = role
    item.append(swatch, label)
    legend.append(item)
  }
  return legend
}

export function renderLexical(entry) {
  const lexical = entry.lexical
  if (!lexical) return null
  const box = el('div', 'lexical')
  if (lexical.phonetic) {
    const row = el('div', 'lexical-row')
    row.append(el('span', 'lexical-label', 'Pronunciation'))
    row.append(el('span', 'phonetic-badge', lexical.phonetic))
    box.append(row)
  }
  if (Array.isArray(lexical.definitions) && lexical.definitions.length) {
    const section = el('div', 'lexical-section')
    section.append(el('div', 'lexical-section-title', 'Definitions'))
    const list = el('ul', 'definitions')
    for (const definition of lexical.definitions) {
      const item = el('li', 'sense')
      if (definition.pos) item.append(el('span', 'pos-chip', definition.pos))
      item.append(el('span', 'sense-meaning', definition.meaning || ''))
      if (definition.example) {
        const example = el('div', 'sense-example')
        example.append(el('span', 'example-source', definition.example.source))
        example.append(el('span', 'example-arrow', '→'))
        example.append(el('span', 'example-target', definition.example.target))
        item.append(example)
      }
      list.append(item)
    }
    section.append(list)
    box.append(section)
  }
  if (lexical.contextual_analysis) {
    const note = el('div', 'lexical-context')
    note.append(el('span', 'lexical-label', 'Context'))
    note.append(el('span', '', lexical.contextual_analysis))
    box.append(note)
  }
  return box.childElementCount ? box : null
}

function lexicalRow(label, value) {
  const row = el('div', 'lexical-row')
  row.append(el('span', 'lexical-label', label), el('span', '', value))
  return row
}

export function revealedHints(entry, hints) {
  const n = Number(entry.hintCount)
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 1, hints.length))
}

export function hintNode(hint, index, isNew) {
  const node = el('div', isNew ? 'hint is-new' : 'hint')
  node.append(el('span', 'hint-step', String(index + 1)))
  node.append(el('span', 'hint-text', hint))
  return node
}

export function renderGuide(entry, { onRevealHint, onToggleAnswer, showSentenceLegend = false } = {}) {
  const guide = entry.guide
  if (!guide) return null
  const box = document.createDocumentFragment()
  const tools = el('div', 'guide-tools')
  const structure = showSentenceLegend ? sentenceStructure(entry) : []
  if (structure.length) box.append(renderSentenceLegend(structure))
  if (guide.phonetic) box.append(lexicalRow('Pronunciation', guide.phonetic))
  if (Array.isArray(guide.hints) && guide.hints.length) {
    const hints = el('div', 'hints')
    hints.dataset.hints = 'true'
    const revealed = revealedHints(entry, guide.hints)
    guide.hints.slice(0, revealed).forEach((hint, index) => hints.append(hintNode(hint, index)))
    box.append(hints)
    if (revealed < guide.hints.length) {
      const more = el('button', '', `Next hint (${guide.hints.length - revealed} left)`)
      more.type = 'button'
      more.dataset.hintMore = 'true'
      more.addEventListener('click', () => onRevealHint?.(entry))
      tools.append(more)
    }
  }
  const answer = guide.answer
  if (answer) {
    const reveal = el('button', '', entry.answerRevealed ? 'Hide answer' : 'Reveal answer')
    reveal.type = 'button'
    reveal.addEventListener('click', () => onToggleAnswer?.(entry))
    tools.append(reveal)
  }
  if (tools.childElementCount) box.append(tools)
  if (answer && entry.answerRevealed) {
    const panel = el('div', 'answer')
    if (answer.meaning) {
      const p = el('p')
      p.append(el('strong', '', 'Meaning:'), ` ${answer.meaning}`)
      panel.append(p)
    }
    if (answer.explanation) {
      const p = el('p')
      p.append(el('strong', '', 'Explanation:'), ` ${answer.explanation}`)
      panel.append(p)
    }
    if (answer.example) {
      const p = el('p')
      p.append(el('strong', '', 'Example:'), ` ${answer.example}`)
      panel.append(p)
    }
    if (answer.usage) {
      const p = el('p')
      p.append(el('strong', '', 'Usage:'), ` ${answer.usage}`)
      panel.append(p)
    }
    box.append(panel)
  }
  return box
}

export function renderTranslation(entry, { languageText = el } = {}) {
  const result = document.createDocumentFragment()
  const answer = el('div', 'translation-answer')
  answer.append(languageText('span', 'translation-text', entry.translatedText))
  if (entry.status === 'streaming') answer.append(el('span', 'caret'))
  result.append(answer)
  const lexical = renderLexical(entry)
  if (lexical) {
    const details = el('details', 'lexical-details')
    details.append(el('summary', '', 'Dictionary details'), lexical)
    result.append(details)
  }
  return result
}
