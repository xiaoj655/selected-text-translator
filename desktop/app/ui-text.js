export const ACTION_LABELS = Object.freeze({
  copyResult: 'Copy result',
  copySource: 'Copy source text',
  speak: '▷ Read aloud',
  stopSpeak: '■ Stop reading',
  cancel: 'Cancel request',
  regenerate: 'Regenerate',
  copyDone: '✓ Copied',
})

const COPY_DONE_CLASS = 'is-done'
const COPY_FEEDBACK_MS = 1400

export function showCopyDone(button) {
  if (!button || button.classList.contains(COPY_DONE_CLASS)) return
  const original = button.textContent
  button.textContent = ACTION_LABELS.copyDone
  button.classList.add(COPY_DONE_CLASS)
  setTimeout(() => {
    button.textContent = original
    button.classList.remove(COPY_DONE_CLASS)
  }, COPY_FEEDBACK_MS)
}
