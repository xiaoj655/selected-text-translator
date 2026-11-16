export const ACTION_LABELS = Object.freeze({
  copyResult: '复制结果',
  copySource: '复制原文',
  speak: '▷ 朗读原文',
  stopSpeak: '■ 停止朗读',
  cancel: '取消请求',
  regenerate: '重新生成',
  copyDone: '✓ 已复制',
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
