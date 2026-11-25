import { button, el } from './tutor.js'
import { markSentence, renderSentenceAnalysis, renderSentenceLegend, sentenceStructure } from './translation-result.js'

export function readingAnalysisEntry(entry) {
  const analysis = entry.analysis
  return {
    text: entry.sentenceScope.text, mode: 'translate', status: analysis.status === 'done' ? 'done' : 'pending',
    structure: analysis.result?.structure, sentenceAnalysis: analysis.result?.sentenceAnalysis,
  }
}

export function renderReadingSentence(entry, { onRetry }) {
  const analysis = entry.analysis
  const scope = entry.sentenceScope
  const section = el('section', 'reading-sentence-structure')
  section.id = 'reading-sentence-structure'
  section.dataset.status = scope.unavailable ? 'unavailable' : analysis.status
  const multiple = scope.sentences.length > 1
  section.append(el('h4', 'reading-sentence-heading', multiple ? 'Understand these sentences' : 'Understand this sentence'))
  if (scope.unavailable) {
    section.append(el('p', 'reading-sentence-status', scope.unavailable))
    return section
  }
  if (analysis.status !== 'done') {
    const message = analysis.status === 'error' ? analysis.error : 'Analyzing sentence…'
    const status = el('p', 'reading-sentence-status', message)
    status.setAttribute('role', 'status')
    section.append(status)
    if (analysis.status === 'error') {
      section.append(button('Retry sentence analysis', 'reading-sentence-retry', onRetry))
    }
    return section
  }
  section.append(el('p', 'reading-sentence-paraphrase', analysis.result.paraphrase))

  const view = readingAnalysisEntry(entry)
  const structure = sentenceStructure(view)
  const notes = renderSentenceAnalysis(view)
  const clauses = notes?.querySelector('.sentence-explore')
  clauses?.remove()
  if (notes?.childElementCount) section.append(notes)

  const details = clauses || el('details', 'sentence-explore')
  details.id = 'reading-sentence-toggle'
  details.open = analysis.detailExpanded
  const label = clauses || structure.length ? 'Grammar details' : multiple ? 'Original sentences' : 'Original sentence'
  const summary = el('summary', '', label)
  const body = el('div', 'reading-sentence-content')
  if (clauses) clauses.firstElementChild.remove()
  details.prepend(summary, body)
  if (structure.length) body.append(renderSentenceLegend(structure))
  for (const sentence of scope.sentences) {
    const source = scope.text.slice(sentence.analysisStart, sentence.analysisEnd)
    const spans = structure.filter(({ start, end }) => start >= sentence.analysisStart && end <= sentence.analysisEnd)
      .map(({ role, start, end }) => ({ role, start: start - sentence.analysisStart, end: end - sentence.analysisStart }))
    const quote = el('blockquote', 'reading-sentence-source')
    quote.lang = 'en'
    markSentence(quote, source, spans)
    body.append(quote)
  }
  section.append(details)
  return section
}
