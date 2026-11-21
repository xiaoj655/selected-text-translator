import { execFile, spawn } from 'node:child_process'
import { dashScopeSpeechKey, synthesizeDashScopeSpeech } from './dashscope-tts.js'

const CLOUD_SPEECH_TIMEOUT_MS = 10000
const CLOUD_SPEECH_MAX_LENGTH = 600

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

export function createTts({
  platform = process.platform, logger = () => {}, readCloudSettings, play,
  synthesize = synthesizeDashScopeSpeech, spawnImpl = spawn,
}) {
  let current = null

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

  function finish(task, type) {
    if (current !== task) return
    current = null
    task.onEvent({ type })
  }

  function stop(type = 'cancelled') {
    const task = current
    if (!task) return
    current = null
    task.controller.abort()
    try {
      task.child?.kill()
    } catch { }
    task.onEvent({ type })
  }

  function speakSystem(task, text, options) {
    if (current !== task) return
    const { command, args } = buildSpeechCommand({
      platform, text, rate: options.rate, lang: options.lang, voiceName: options.voiceName,
    })
    try {
      task.child = spawnImpl(command, args, { windowsHide: true, stdio: 'ignore' })
      task.child.on('spawn', () => {
        if (current === task) task.onEvent({ type: 'start' })
      })
      task.child.on('error', () => finish(task, 'error'))
      task.child.on('close', (code) => finish(task, code === 0 ? 'end' : 'error'))
    } catch {
      finish(task, 'error')
    }
  }

  async function speakPreferred(task, text, options) {
    if (!readCloudSettings || !play || !options.lang?.startsWith('en-')) {
      speakSystem(task, text, options)
      return
    }
    let settings
    try {
      settings = await readCloudSettings()
    } catch {
      logger('speech settings unavailable')
    }
    if (current !== task) return
    if (settings?.desktop_tts_cloud !== true) {
      speakSystem(task, text, options)
      return
    }

    const apiKey = dashScopeSpeechKey(settings)
    let fallbackMessage = ''
    if (!apiKey) fallbackMessage = '请在朗读设置填写百炼 API Key。正在使用系统语音。'
    else if (text.length > CLOUD_SPEECH_MAX_LENGTH) fallbackMessage = '这段文字超过 600 字符，正在使用系统语音。'
    else {
      const signal = task.controller.signal
      let hasStarted = false
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(CLOUD_SPEECH_TIMEOUT_MS)])
        const audio = await synthesize(text, { apiKey, signal: requestSignal })
        if (current !== task) return
        requestSignal.throwIfAborted()
        await play(audio, {
          rate: options.rate,
          signal,
          onStart() {
            if (current !== task) return
            hasStarted = true
            task.onEvent({ type: 'start' })
          },
        })
        finish(task, 'end')
        return
      } catch {
        if (current !== task) return
        logger('cloud speech unavailable')
        if (hasStarted) {
          finish(task, 'error')
          return
        }
        fallbackMessage = '阿里云朗读暂时不可用，正在使用系统语音。'
      }
    }
    task.onEvent({ type: 'fallback', message: fallbackMessage })
    speakSystem(task, text, options)
  }

  function speak(text, options = {}, done) {
    stop('interrupted')
    const task = {
      controller: new AbortController(),
      child: null,
      onEvent: typeof options.onEvent === 'function' ? options.onEvent : () => {},
    }
    current = task
    if (typeof done === 'function') done()
    void speakPreferred(task, text, options)
  }

  return { getVoices, speak, stop }
}
