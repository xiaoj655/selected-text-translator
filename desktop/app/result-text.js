export function resultText(entry) {
  if (entry?.mode === 'guide') return entry.guide?.answer?.meaning || ''
  return entry?.translatedText || ''
}

function lexicalLines(lexical) {
  if (!lexical) return []
  const lines = []
  if (lexical.phonetic) lines.push(`Pronunciation: ${lexical.phonetic}`)
  if (Array.isArray(lexical.definitions) && lexical.definitions.length) {
    lines.push('Definitions')
    for (const definition of lexical.definitions) {
      const parts = []
      if (definition.pos) parts.push(`[${definition.pos}]`)
      parts.push(definition.meaning || '')
      if (definition.example) parts.push(`(${definition.example.source} → ${definition.example.target})`)
      lines.push(`  ${parts.join(' ').trim()}`)
    }
  }
  if (lexical.contextual_analysis) lines.push(`Context: ${lexical.contextual_analysis}`)
  return lines
}

function guideLines(entry, guide) {
  const lines = []
  if (guide.phonetic) lines.push(`Pronunciation: ${guide.phonetic}`)
  if (Array.isArray(guide.hints) && guide.hints.length) {
    const raw = Number(entry.hintCount)
    const revealed = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 1, guide.hints.length))
    guide.hints.slice(0, revealed).forEach((hint, index) => lines.push(`${index + 1}. ${hint}`))
  }
  const answer = guide.answer
  if (answer && entry.answerRevealed) {
    if (answer.meaning) lines.push(`Meaning: ${answer.meaning}`)
    if (answer.explanation) lines.push(`Explanation: ${answer.explanation}`)
    if (answer.example) lines.push(`Example: ${answer.example}`)
    if (answer.usage) lines.push(`Usage: ${answer.usage}`)
  }
  return lines
}

export function resultPlainText(entry) {
  if (!entry || ['error', 'pending', 'loading', 'streaming'].includes(entry.status)) return ''
  const guide = entry.mode === 'guide' ? entry.guide : null
  if (guide) return guideLines(entry, guide).join('\n')
  const parts = []
  const main = resultText(entry)
  if (main) parts.push(main)
  const lexical = lexicalLines(entry.lexical)
  if (lexical.length) {
    if (parts.length) parts.push('')
    parts.push(...lexical)
  }
  return parts.join('\n')
}
