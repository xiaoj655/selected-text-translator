import { uiText } from './ui-language.js'

const ANKI_TAG = 'selected-english'
const FIELD_LABELS = Object.freeze([
  ['phonetic', '音标', 'Pronunciation:'],
  ['explanation', '释义', 'Explanation:'],
  ['example', '例句', 'Example:'],
  ['context', '语境', 'Context:'],
  ['usage', '用法', 'Usage:'],
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
  for (const [key, chineseLabel, englishLabel] of FIELD_LABELS) {
    const value = escapeAnkiField(String(entry[key] || '').trim())
    if (value) parts.push(`${uiText(chineseLabel, englishLabel)} ${value}`)
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
