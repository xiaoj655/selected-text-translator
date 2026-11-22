import { button, el } from './tutor.js'
import { markSentence, renderSentenceAnalysis, renderSentenceLegend, sentenceStructure } from './translation-result.js'

export function readingAnalysisEntry(entry) {
  const analysis = entry.analysis
  return {
    text: entry.sentenceScope.text, mode: 'translate', status: analysis.status === 'done' ? 'done' : 'pending',
    structure: analysis.result?.structure, sentenceAnalysis: analysis.result?.sentenceAnalysis,
    analysisExpanded: analysis.detailExpanded,
  }
}

export function renderReadingSentence(entry, { onToggle, onRetry }) {
  const analysis = entry.analysis
  const scope = entry.sentenceScope
  const section = el('section', 'reading-sentence-structure')
  section.id = 'reading-sentence-structure'
  section.dataset.status = scope.unavailable ? 'unavailable' : analysis.status
  let body = section
  if (entry.singleWord) {
    const details = el('details', 'reading-sentence-details')
    details.id = 'reading-sentence-toggle'
    details.open = analysis.expanded
    details.append(el('summary', '', 'Sentence structure'))
    body = el('div', 'reading-sentence-content')
    details.append(body)
    details.addEventListener('toggle', () => {
      if (details.isConnected && details.open !== analysis.expanded) onToggle(details.open)
    })
    section.append(details)
  } else {
    section.append(el('h4', 'reading-sentence-heading', 'Sentence structure'))
  }
  if (entry.singleWord && !analysis.expanded) return section
  if (scope.unavailable) {
    body.append(el('p', 'reading-sentence-status', scope.unavailable))
    return section
  }
  if (analysis.status !== 'done') {
    const message = analysis.status === 'error' ? analysis.error : 'Analyzing sentence…'
    const status = el('p', 'reading-sentence-status', message)
    status.setAttribute('role', 'status')
    body.append(status)
    if (analysis.status === 'error') {
      body.append(button('Retry sentence analysis', 'reading-sentence-retry', onRetry))
    }
    return section
  }
  const view = readingAnalysisEntry(entry)
  const structure = sentenceStructure(view)
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
  const detail = renderSentenceAnalysis(view)
  if (detail) {
    detail.querySelector('.sentence-explore')?.addEventListener('toggle', (event) => {
      if (event.target.isConnected) analysis.detailExpanded = event.target.open
    })
    body.append(detail)
  }
  if (!structure.length) {
    body.append(el('p', 'reading-sentence-status', 'No complete main clause was identified. You can retry the analysis.'))
    body.append(button('Retry sentence analysis', 'reading-sentence-retry', onRetry))
  }
  return section
}
