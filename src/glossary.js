export const MAX_GLOSSARY_ENTRIES = 50

export function normalizeTerm(term) {
  return String(term || '').trim()
}

export function sanitizeGlossary(entries) {
  if (!Array.isArray(entries)) return []
  const seen = new Set()
  const result = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const source = normalizeTerm(entry.source)
    const target = normalizeTerm(entry.target)
    if (!source || !target) continue
    const key = source.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ source, target })
    if (result.length >= MAX_GLOSSARY_ENTRIES) break
  }
  return result
}

export function buildGlossaryInstruction(entries) {
  const clean = sanitizeGlossary(entries)
  if (!clean.length) return ''
  const rules = clean.map(({ source, target }) => `"${source}" must always be translated as "${target}"`).join('; ')
  return `Apply these terminology rules exactly: ${rules}.`
}
