export const VOCABULARY_EDIT_FIELDS = Object.freeze([
  Object.freeze({ key: 'meaning', label: '在这里的意思', maxLength: 2000, rows: 3, isRequired: true }),
  Object.freeze({ key: 'usage', label: '用法与搭配', maxLength: 500, rows: 2 }),
  Object.freeze({ key: 'example', label: '例句', maxLength: 1000, rows: 3 }),
  Object.freeze({ key: 'explanation', label: '补充解释', maxLength: 2500, rows: 3, isAdvanced: true }),
  Object.freeze({ key: 'phonetic', label: '音标', maxLength: 160, rows: 1, isAdvanced: true }),
])

function getEditableValues(entry) {
  return Object.fromEntries(VOCABULARY_EDIT_FIELDS.map(({ key }) => [key, String(entry?.[key] || '')]))
}

export function createVocabularyDraft(entry) {
  const values = getEditableValues(entry)
  return {
    id: String(entry?.id || ''),
    text: String(entry?.text || ''),
    original: { ...values },
    values,
    latestEntry: entry ? { ...entry } : null,
    hasExternalChanges: false,
    isMissing: !entry,
    isSaving: false,
    isAdvancedOpen: false,
    code: '',
    message: '',
  }
}

export function setVocabularyDraftField(draft, key, value) {
  if (!draft || !VOCABULARY_EDIT_FIELDS.some((field) => field.key === key)) return draft
  return { ...draft, values: { ...draft.values, [key]: String(value || '') } }
}

export function syncVocabularyDraft(draft, entry) {
  if (!draft) return null
  const latestEntry = entry?.id === draft.id ? { ...entry } : null
  const values = getEditableValues(latestEntry)
  return {
    ...draft,
    latestEntry,
    isMissing: !latestEntry,
    hasExternalChanges: !!latestEntry && VOCABULARY_EDIT_FIELDS.some(({ key }) => {
      return values[key] !== draft.original[key]
    }),
  }
}

export function getVocabularyDraftUpdate(draft) {
  if (!draft?.id) return { ok: false, message: '无法识别这条表达，请重新打开表达本。' }
  const changes = {}
  const expected = {}
  for (const field of VOCABULARY_EDIT_FIELDS) {
    const rawValue = String(draft.values[field.key] || '')
    const value = rawValue.trim()
    if (field.isRequired && !value) return { ok: false, field: field.key, message: '请保留这条表达的释义。' }
    if (rawValue.length > field.maxLength) {
      return { ok: false, field: field.key, message: `${field.label}请控制在 ${field.maxLength} 字以内。` }
    }
    if (value !== draft.original[field.key]) {
      changes[field.key] = value
      expected[field.key] = draft.original[field.key]
    }
  }
  return { ok: true, hasChanges: Object.keys(changes).length > 0, payload: { id: draft.id, changes, expected } }
}

export function serializeVocabularyDraft(draft) {
  if (!draft) return ''
  return [draft.text, ...VOCABULARY_EDIT_FIELDS.map(({ key, label }) => `${label}\n${draft.values[key]}`)].join('\n\n')
}
