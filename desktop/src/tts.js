import { execFile, spawn } from 'node:child_process'

export function createTts({ platform = process.platform, logger = () => {} }) {
  let child = null

  function getVoices() {
    return new Promise((resolve) => {
      let settled = false
      const finish = (names) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(names.map((voiceName) => ({ voiceName, lang: 'en-US', remote: false })))
      }
      const timer = setTimeout(() => finish([]), 800)

      if (platform === 'darwin') {
        execFile('say', ['-v', '?'], { timeout: 700 }, (error, stdout) => {
          if (error) return finish([])
          finish(String(stdout).split('\n').map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean))
        })
      } else if (platform === 'win32') {
        execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }',
        ], { timeout: 700 }, (error, stdout) => {
          if (error) return finish([])
          finish(String(stdout).split('\n').map((line) => line.trim()).filter(Boolean))
        })
      } else {
        finish([])
      }
    })
  }

  function stop() {
    if (!child) return
    const current = child
    child = null
    try {
      current.kill()
    } catch {
      // already gone
    }
  }

  function speak(text, options = {}, done) {
    stop()
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
    const rawRate = Number(options.rate)
    const rate = Number.isFinite(rawRate) ? Math.min(1.5, Math.max(0.5, rawRate)) : 0.9
    let command
    let args

    if (platform === 'darwin') {
      command = 'say'
      args = ['-r', String(Math.round(rate * 180))]
      if (options.voiceName) args.push('-v', String(options.voiceName))
      args.push('--', String(text))
    } else if (platform === 'win32') {
      command = 'powershell.exe'
      const escaped = String(text).replace(/'/gu, "''")
      args = [
        '-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${Math.round((rate - 1) * 10)}; $s.Speak('${escaped}')`,
      ]
    } else {
      command = 'spd-say'
      args = [String(text)]
    }

    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => {
        onEvent({ type: 'error' })
        child = null
      })
      child.on('close', (code) => {
        if (!child) return
        child = null
        onEvent({ type: code === 0 ? 'end' : 'error' })
      })
      if (typeof done === 'function') done()
    } catch (error) {
      logger('speech failed', error)
      onEvent({ type: 'error' })
      if (typeof done === 'function') done()
    }
  }

  return { getVoices, speak, stop }
}
