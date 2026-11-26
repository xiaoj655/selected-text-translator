import { ENGLISH_EXPLANATION_TARGET } from '../vendor/src/translation-contracts.js'

const ERROR_MESSAGES = new Map([
  ['No translated text returned by endpoint.', 'The model returned no translation. Try again or choose another model.'],
  ['Unable to read translated text from stream response.', 'Could not read the streamed translation. Try again.'],
  ['qwen-mt non-stream response did not include translated content.', 'The translation service returned no translation.'],
  ['qwen-mt non-stream response is not valid JSON.', 'Could not read the response from the translation service.'],
  ['qwen-mt response did not include a stream body.', 'The translation service did not send a stream.'],
])

export function localizeErrorMessage(payload) {
  const message = String(payload?.message || '')
  if (payload?.status === 'missing-configuration') {
    if (/learning model/i.test(message)) {
      return payload.kind === 'article-explanation' || payload.targetLanguage === ENGLISH_EXPLANATION_TARGET
        ? message : 'Choose a learning model in Settings to use guided mode.'
    }
    return 'Enter your API URL, key, and model in Settings.'
  }
  if (!message) return 'Request failed. Try again.'
  if (/timed? ?out/i.test(message)) return 'The request timed out. Check your network connection and try again.'
  return ERROR_MESSAGES.get(message) || message
}
