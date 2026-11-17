const KANA = /[\u3040-\u309f\u30a0-\u30ff]/u
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/u
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u
const LATIN = /[a-z]/iu

const MARKERS = {
  french: ['bonjour', 'aujourd', 'très', 'heureux', 'heureuse', 'comment', 'allez', 'suis',
    'matin', 'ami', 'amie', 'vous', "c'est", 'livre', 'beau', 'belle', 'merci', 'je '],
  german: ['guten', 'morgen', 'freund', 'heute', 'geht', 'glücklich', 'sehr', 'ich ',
    'bin ', 'und ', 'ist ', 'nicht', 'buch', 'lesen', 'schön', 'der ', 'die ', 'das '],
  spanish: ['buenos', 'días', 'amigo', 'amiga', 'cómo', 'como', 'estás', 'estoy', 'hoy',
    'feliz', 'muy', 'qué', '¿', '¡', 'mañana', 'libro', 'leer', 'el ', 'la '],
}

const LABELS = {
  chinese: '中文',
  english: '英语',
  japanese: '日语',
  korean: '韩语',
  french: '法语',
  german: '德语',
  spanish: '西班牙语',
}

export function detectSourceLanguage(text) {
  const value = String(text || '')
  if (KANA.test(value)) return 'japanese'
  if (HANGUL.test(value)) return 'korean'
  if (HAN.test(value)) return 'chinese'
  if (!LATIN.test(value)) return ''

  const lower = value.toLowerCase()
  const scores = Object.keys(MARKERS)
    .map((lang) => ({
      lang,
      score: MARKERS[lang].reduce((total, marker) => total + (lower.includes(marker) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)

  const best = scores[0]
  if (best && best.score >= 2 && (!scores[1] || scores[1].score < best.score)) return best.lang
  return 'english'
}

export function sourceLanguageLabel(lang) {
  return LABELS[lang] || ''
}
