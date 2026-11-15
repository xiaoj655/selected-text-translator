(() => {
  const sourceEl = document.getElementById('stt-source')

  window.sttDesktop.onSelection((payload) => {
    const text = String(payload?.text || '')
    sourceEl.textContent = text
    if (!text) {
      window.sttDesktop.hide()
      return
    }

    const range = document.createRange()
    range.selectNodeContents(sourceEl)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    setTimeout(() => window.sttDesktop.requestOpen(), 30)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.sttDesktop.hide()
  }, true)

  document.addEventListener('mousedown', (event) => {
    if (event.target === document.body || event.target === sourceEl) window.sttDesktop.hide()
  }, true)
})()
