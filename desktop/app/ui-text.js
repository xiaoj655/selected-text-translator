export const ACTION_LABELS = Object.freeze({
  copyResult: 'Copy result',
  copySource: 'Copy source text',
  explainInEnglish: 'Explain in English',
  speak: '▷ Read aloud',
  stopSpeak: '■ Stop reading',
  cancel: 'Cancel request',
  regenerate: 'Regenerate',
  copyDone: '✓ Copied',
})

const COPY_DONE_CLASS = 'is-done'
const COPY_FEEDBACK_MS = 1400
const copyTimers = new WeakMap()

export function resetCopyDone(button, label = ACTION_LABELS.copyResult) {
  clearTimeout(copyTimers.get(button))
  copyTimers.delete(button)
  button.textContent = label
  button.classList.remove(COPY_DONE_CLASS)
}

export function showCopyDone(button) {
  if (!button || button.classList.contains(COPY_DONE_CLASS)) return
  const original = button.textContent
  button.textContent = ACTION_LABELS.copyDone
  button.classList.add(COPY_DONE_CLASS)
  copyTimers.set(button, setTimeout(() => resetCopyDone(button, original), COPY_FEEDBACK_MS))
}
