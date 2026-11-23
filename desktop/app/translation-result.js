// Shared result presentation. Callers own request state, actions, and persistence.
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SENTENCE_ROLES = { subject: 'Subject', verb: 'Verb', object: 'Object', complement: 'Complement' }

export function sentenceStructure(entry) {
  if (entry.status !== 'done') return []
  const structure = entry.mode === 'guide' && entry.guide?.guideType === 'sentence'
    ? entry.guide.structure : entry.mode === 'translate' ? entry.structure : null
  if (!Array.isArray(structure)) return []

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

function isSourceSpan(span, text, start = 0, end = text.length) {
  return span && Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= start && span.end > span.start && span.end <= end
}

function clauseStructure(clause, text) {
  if (!Array.isArray(clause.structure)) return []
  let previousEnd = clause.start
  for (const part of clause.structure) {
    if (!isSourceSpan(part, text, previousEnd, clause.end) || !Object.hasOwn(SENTENCE_ROLES, part.role)) return []
    previousEnd = part.end
  }
  return clause.structure.map((part) => ({
    role: part.role, start: part.start - clause.start, end: part.end - clause.start,
  }))
}

export function renderSentenceAnalysis(entry) {
  if (entry.status !== 'done' || typeof entry.text !== 'string') return null
  const analysis = entry.mode === 'guide' ? entry.guide?.sentenceAnalysis : entry.sentenceAnalysis
  if (!analysis || typeof analysis !== 'object') return null
  const items = (name, limit) => Array.isArray(analysis[name]) ? analysis[name].filter((item) =>
    isSourceSpan(item, entry.text) && typeof item.explanation === 'string' && item.explanation.trim(),
  ).slice(0, limit) : []
  const connections = items('connections', 3)
  const fragments = items('fragments', 2)
  const clauses = items('clauses', 8)
  if (!connections.length && !fragments.length && !clauses.length) return null

  const box = el('div', 'sentence-analysis')
  for (const connection of connections) {
    const note = el('p', 'sentence-connection')
    note.append(el('q', 'sentence-connection-source', entry.text.slice(connection.start, connection.end)),
      ' ', el('span', '', connection.explanation))
    box.append(note)
  }
  for (const fragment of fragments) {
    const note = el('p', 'sentence-fragment')
    note.append(el('span', 'sentence-fragment-label', 'Incomplete selection: '),
      el('q', '', entry.text.slice(fragment.start, fragment.end)), ' ', el('span', '', fragment.explanation))
    box.append(note)
  }
  if (clauses.length) {
    const details = el('details', 'sentence-explore')
    details.open = entry.analysisExpanded === true
    details.append(el('summary', '', 'Explore sentence'))
    const body = el('div', 'sentence-explore-body')
    const roles = []
    for (const clause of clauses) {
      const section = el('div', 'sentence-clause')
      const quote = el('blockquote', 'sentence-clause-source')
      const source = entry.text.slice(clause.start, clause.end)
      const structure = clauseStructure(clause, entry.text)
      markSentence(quote, source, structure)
      roles.push(...structure)
      section.append(quote, el('p', 'sentence-clause-explanation', clause.explanation))
      body.append(section)
    }
    if (roles.length) body.prepend(renderSentenceLegend(roles))
    details.append(body)
    details.addEventListener('toggle', () => {
      if (details.isConnected) entry.analysisExpanded = details.open
    })
    box.append(details)
  }
  return box
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

export function scrollToLatestHint(result, scroller) {
  const hint = result.querySelector('[data-hints] > :last-child')
  if (!hint) return
  const hintBounds = hint.getBoundingClientRect()
  const top = scroller.getBoundingClientRect().top + scroller.clientTop
  const bottom = top + scroller.clientHeight
  if (hintBounds.top < top || hintBounds.height > scroller.clientHeight) {
    scroller.scrollTop += hintBounds.top - top
  } else if (hintBounds.bottom > bottom) {
    scroller.scrollTop += hintBounds.bottom - bottom
  }
}

export function hintNode(hint, index, isNew) {
  const node = el('div', isNew ? 'hint is-new' : 'hint')
  node.append(el('span', 'hint-step', String(index + 1)))
  node.append(el('span', 'hint-text', hint))
  return node
}

function renderHints(hints) {
  const list = el('div', 'hints')
  list.dataset.hints = 'true'
  hints.forEach((hint, index) => list.append(hintNode(hint, index)))
  return list
}

export function renderGuidePreview(hint) {
  return renderHints([hint])
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
    const revealed = revealedHints(entry, guide.hints)
    box.append(renderHints(guide.hints.slice(0, revealed)))
    if (revealed < guide.hints.length) {
      const more = el('button', '', `Next hint (${guide.hints.length - revealed} left)`)
      more.type = 'button'
      more.dataset.hintMore = 'true'
      more.title = 'Next hint (Space)'
      more.setAttribute('aria-keyshortcuts', 'Space')
      more.addEventListener('click', () => onRevealHint?.(entry))
      tools.append(more)
    }
  }
  const analysis = renderSentenceAnalysis(entry)
  if (analysis) box.append(analysis)
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

export function renderTranslation(entry, { languageText = el, showSentenceLegend = false } = {}) {
  const result = document.createDocumentFragment()
  const answer = el('div', 'translation-answer')
  answer.append(languageText('span', 'translation-text', entry.translatedText))
  if (entry.status === 'streaming') answer.append(el('span', 'caret'))
  result.append(answer)
  const structure = showSentenceLegend ? sentenceStructure(entry) : []
  if (structure.length) result.append(renderSentenceLegend(structure))
  const analysis = renderSentenceAnalysis(entry)
  if (analysis) result.append(analysis)
  const lexical = renderLexical(entry)
  if (lexical) {
    const details = el('details', 'lexical-details')
    details.append(el('summary', '', 'Dictionary details'), lexical)
    result.append(details)
  }
  return result
}
