import { execFile, spawn } from 'node:child_process'

const VOICE_BY_LANG = Object.freeze({
  'zh-CN': { darwin: 'Ting-Ting', win32: 'Microsoft Huihui Desktop' },
  'en-US': { darwin: 'Samantha', win32: 'Microsoft David Desktop' },
  'ja-JP': { darwin: 'Kyoko', win32: 'Microsoft Haruka Desktop' },
  'ko-KR': { darwin: 'Narry', win32: 'Microsoft Heami Desktop' },
  'fr-FR': { darwin: 'Thomas', win32: 'Microsoft Hortense Desktop' },
  'de-DE': { darwin: 'Anna', win32: 'Microsoft Stefan Desktop' },
  'es-ES': { darwin: 'Monica', win32: 'Microsoft Elvira Desktop' },
})

export function buildSpeechCommand({ platform = process.platform, text = '', rate = 0.9, lang = '', voiceName = '' } = {}) {
  const safeRate = Number.isFinite(Number(rate)) ? Math.min(1.5, Math.max(0.5, Number(rate))) : 0.9
  const voice = String(voiceName || '')
  const language = String(lang || '')

  if (platform === 'darwin') {
    const preferred = VOICE_BY_LANG[language]?.darwin
    const chosen = voice || preferred || ''
    const args = ['-r', String(Math.round(safeRate * 180))]
    if (chosen) args.push('-v', chosen)
    args.push('--', String(text))
    return { command: 'say', args }
  }

  if (platform === 'win32') {
    const preferred = VOICE_BY_LANG[language]?.win32
    const chosen = voice || preferred || ''
    const culture = language ? `$s.Culture = New-Object System.Globalization.CultureInfo('${language}'); ` : ''
    const voiceLine = chosen ? `$s.SelectVoice('${chosen.replace(/'/gu, "''")}'); ` : ''
    const escaped = String(text).replace(/'/gu, "''")
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${Math.round((safeRate - 1) * 10)}; ${culture}${voiceLine}$s.Speak('${escaped}')`
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }

  const args = []
  if (language) args.push('-l', language.split('-')[0])
  args.push(String(text))
  return { command: 'spd-say', args }
}

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
    const { command, args } = buildSpeechCommand({
      platform, text, rate: options.rate, lang: options.lang, voiceName: options.voiceName,
    })

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
