const KANA = /[\u3040-\u309f\u30a0-\u30ff]/u
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/u

const MARKERS = {
  french: ['bonjour', 'aujourd', 'très', 'heureux', 'heureuse', 'comment', 'allez', 'suis',
    'matin', 'ami', 'amie', 'vous', "c'est", 'livre', 'beau', 'belle'],
  german: ['guten', 'morgen', 'freund', 'heute', 'geht', 'glücklich', 'sehr', 'ich ',
    'bin ', 'und ', 'ist ', 'nicht', 'buch', 'lesen', 'schön'],
  spanish: ['buenos', 'días', 'amigo', 'amiga', 'cómo', 'como', 'estás', 'estoy', 'hoy',
    'feliz', 'muy', 'qué', '¿', '¡', 'mañana', 'libro', 'leer'],
}

const NAMES = { french: 'French', german: 'German', spanish: 'Spanish' }

export function detectLanguage(text) {
  const value = String(text || '')
  if (KANA.test(value)) return 'Japanese'
  if (HANGUL.test(value)) return 'Korean'

  const lower = value.toLowerCase()
  const scores = Object.keys(MARKERS)
    .map((lang) => ({
      lang,
      score: MARKERS[lang].reduce((total, marker) => total + (lower.includes(marker) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)

  const best = scores[0]
  if (!best || best.score < 2 || (scores[1] && scores[1].score === best.score)) return 'unknown'
  return NAMES[best.lang] || 'unknown'
}
