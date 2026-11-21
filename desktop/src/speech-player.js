import { fileURLToPath } from 'node:url'

const PRELOAD_PATH = fileURLToPath(new URL('./speech-preload.cjs', import.meta.url))
const PLAYER_DOCUMENT = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src blob:">`)

export function createSpeechPlayer({ BrowserWindow }) {
  let cancelActive = null

  async function play(wavBuffer, { rate = 1, signal, onStart = () => {} } = {}) {
    signal?.throwIfAborted()
    cancelActive?.()
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    })
    const contents = win.webContents
    let cancel
    try {
      await new Promise((resolve, reject) => {
        cancel = () => {
          reject(signal?.reason ?? new DOMException('Speech playback was cancelled.', 'AbortError'))
          if (!win.isDestroyed()) win.destroy()
        }
        cancelActive = cancel
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) return cancel()

        contents.ipc.on('stt:speech-player-state', (_event, status) => {
          if (status === 'start') {
            try {
              onStart()
            } catch (error) {
              reject(error)
            }
          } else if (status === 'end') {
            resolve()
          } else if (status === 'error') {
            reject(new Error('Unable to play speech audio.'))
          }
        })
        contents.once('preload-error', () => reject(new Error('Unable to initialize the speech player.')))
        contents.once('render-process-gone', () => reject(new Error('The speech player stopped unexpectedly.')))
        win.once('closed', () => reject(new Error('The speech player was closed.')))
        void win.loadURL(PLAYER_DOCUMENT).then(() => {
          if (!win.isDestroyed()) contents.send('stt:speech-player-play', wavBuffer, rate)
        }).catch(reject)
      })
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (cancelActive === cancel) cancelActive = null
      if (!win.isDestroyed()) win.destroy()
    }
  }

  return { play }
}
