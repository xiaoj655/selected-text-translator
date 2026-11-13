import {
  exportVocabulary,
  importVocabulary,
  listVocabulary,
  removeVocabulary,
  reviewVocabulary,
  saveVocabulary,
  updateVocabulary,
} from './vocabulary-store.js'

const ACTIONS = Object.freeze({
  VOCABULARY_LIST: () => listVocabulary(),
  VOCABULARY_SAVE: (payload) => saveVocabulary(payload),
  VOCABULARY_UPDATE: (payload) => updateVocabulary(payload?.id, payload?.changes, payload?.expected),
  VOCABULARY_REMOVE: (payload) => removeVocabulary(payload?.id),
  VOCABULARY_REVIEW: (payload) => reviewVocabulary(payload?.id, payload?.rating, {
    expectedDueAt: payload?.expectedDueAt, expectedReviewCount: payload?.expectedReviewCount,
  }),
  VOCABULARY_EXPORT: () => exportVocabulary(),
  VOCABULARY_IMPORT: (payload) => importVocabulary(payload?.data),
})

export function handleVocabularyMessage(message, sender, sendResponse) {
  if (message?.type === 'OPEN_LIBRARY') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/library.html') }, () => {
      const error = chrome.runtime.lastError
      sendResponse({ ok: !error })
    })
    return true
  }
  const action = ACTIONS[message?.type]
  if (!action) return false
  void action(message.payload).then(sendResponse).catch(() => {
    sendResponse({ ok: false, message: 'Unable to access your vocabulary book. Please try again.' })
  })
  return true
}
