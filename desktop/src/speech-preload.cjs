const { ipcRenderer } = require('electron')

ipcRenderer.once('stt:speech-player-play', async (_event, wav, rate) => {
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
  const audio = new Audio(url)
  let isFinished = false

  function finish(status) {
    if (isFinished) return
    isFinished = true
    URL.revokeObjectURL(url)
    ipcRenderer.send('stt:speech-player-state', status)
  }

  audio.addEventListener('ended', () => finish('end'), { once: true })
  audio.addEventListener('error', () => finish('error'), { once: true })
  try {
    audio.playbackRate = rate
    await audio.play()
    if (!isFinished) ipcRenderer.send('stt:speech-player-state', 'start')
  } catch {
    finish('error')
  }
})
