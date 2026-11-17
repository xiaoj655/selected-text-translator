const ANKI_TAG = 'selected-english'
const FIELD_LABELS = Object.freeze([
  ['phonetic', '音标'],
  ['explanation', '释义'],
  ['example', '例句'],
  ['context', '语境'],
  ['usage', '用法'],
])

function escapeAnkiField(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\r\n?|\n/gu, '<br>')
    .replace(/\t/gu, ' ')
}

function formatAnkiRow(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
  const text = escapeAnkiField(String(entry.text || '').trim())
  const meaning = escapeAnkiField(String(entry.meaning || '').trim())
  if (!text || !meaning) return ''
  const parts = [meaning]
  for (const [key, label] of FIELD_LABELS) {
    const value = escapeAnkiField(String(entry[key] || '').trim())
    if (value) parts.push(`${label} ${value}`)
  }
  return [text, parts.join('<br>'), ANKI_TAG].join('\t')
}

export function buildAnkiTsv(entries) {
  if (!Array.isArray(entries)) return ''
  return entries.map(formatAnkiRow).filter(Boolean).join('\n')
}

export function countAnkiRows(tsv) {
  return tsv ? tsv.split('\n').length : 0
}
