import { uiText } from './ui-language.js'
import { READING_STORAGE_KEYS, readReadingSettings, saveReadingSettings } from './reading-support.js'

const CONTROL_FIELDS = Object.freeze({
  learningModel: READING_STORAGE_KEYS.LEARNING_MODEL,
  mode: READING_STORAGE_KEYS.MODE,
  voiceName: READING_STORAGE_KEYS.VOICE,
  rate: READING_STORAGE_KEYS.RATE,
})

export async function createReadingControls({ autoSave = false } = {}) {
  const controls = Object.fromEntries(Object.entries(CONTROL_FIELDS).map(
    ([key, id]) => [key, document.getElementById(id)],
  ))
  const previewEl = document.getElementById('preview-speech')
  const statusEl = document.getElementById('speech-status')
  if (Object.values(controls).some((el) => !el) || !previewEl || !statusEl) return null
  const saved = await readReadingSettings()
  for (const key of Object.keys(controls)) setControlValue(key, saved[key])
  let previous = readValues()
  let persistQueue = Promise.resolve()

  function ensureVoiceOption(value, label = value) {
    const voiceEl = controls.voiceName
    if (value && !Array.from(voiceEl.options).some((option) => option.value === value)) {
      const optionEl = document.createElement('option')
      optionEl.value = value
      optionEl.textContent = label
      voiceEl.appendChild(optionEl)
    }
  }

  function setControlValue(key, value) {
    if (key === 'voiceName') ensureVoiceOption(value, uiText(`${value} · 已保存`, `${value} · Saved`))
    controls[key].value = String(value ?? '')
    if (key === 'rate' && !controls[key].value) controls[key].value = '0.9'
  }

  function readValues() {
    return {
      learningModel: String(controls.learningModel.value || '').trim(),
      mode: controls.mode.value,
      voiceName: controls.voiceName.value,
      rate: Number(controls.rate.value),
    }
  }

  async function persistCurrentValues() {
    const values = readValues()
    const changedKeys = Object.keys(values).filter((key) => values[key] !== previous[key])
    if (!changedKeys.length) return { ok: true }
    try {
      const result = await saveReadingSettings(values, { changedKeys })
      if (result.ok) {
        for (const key of changedKeys) previous[key] = values[key]
        if (autoSave) statusEl.textContent = uiText('阅读偏好已自动保存。', 'Reading preferences saved.')
      } else {
        statusEl.textContent = result.error
      }
      return result
    } catch {
      statusEl.textContent = uiText('保存失败，请重试。', 'Could not save settings. Try again.')
      return { ok: false }
    }
  }

  function persist() {
    persistQueue = persistQueue.then(persistCurrentValues)
    return persistQueue
  }

  if (autoSave) {
    for (const inputEl of Object.values(controls)) {
      inputEl.addEventListener('change', () => { void persist() })
    }
  }
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    const values = readValues()
    for (const [logicalKey, storageKey] of Object.entries(CONTROL_FIELDS)) {
      if (!(storageKey in changes) || values[logicalKey] !== previous[logicalKey]) continue
      const defaults = { learningModel: '', mode: 'translate', voiceName: '', rate: 0.9 }
      setControlValue(logicalKey, changes[storageKey].newValue ?? defaults[logicalKey])
      previous[logicalKey] = readValues()[logicalKey]
    }
  })
  previewEl.addEventListener('click', async () => {
    previewEl.disabled = true
    statusEl.textContent = uiText('正在准备试听…', 'Preparing voice preview…')
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'PREVIEW_SPEECH',
        payload: {
          speechId: `preview-${Date.now()}`,
          text: 'Take your time. Every word is a new beginning.',
          voiceName: controls.voiceName.value,
          rate: Number(controls.rate.value),
        },
      })
      statusEl.textContent = result?.ok ? uiText('正在播放所选音色。', 'Playing the selected voice.') : result?.message || uiText('无法播放，请检查系统音色。', 'Could not play audio. Check your system voices.')
    } catch {
      statusEl.textContent = uiText('无法播放，请重新加载插件后重试。', 'Could not play audio. Restart the app and try again.')
    } finally {
      previewEl.disabled = false
    }
  })
  void loadVoices()
  return { persist }

  async function loadVoices() {
    let timeoutId
    try {
      const result = await Promise.race([
        chrome.runtime.sendMessage({ type: 'GET_SPEECH_VOICES' }),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve({ ok: false, voices: [] }), 2000)
        }),
      ])
      for (const voice of result?.voices || []) {
        const label = `${voice.voiceName} · ${voice.lang || uiText('自动', 'Auto')}${voice.remote ? uiText(' · 在线', ' · Online') : ''}`
        ensureVoiceOption(voice.voiceName, label)
        const optionEl = Array.from(controls.voiceName.options).find((option) => option.value === voice.voiceName)
        if (optionEl) optionEl.textContent = label
      }
      if (!result?.voices?.length && !statusEl.textContent) {
        statusEl.textContent = uiText('暂未发现可用音色，其他设置可正常使用。', 'No voices found. Other settings are still available.')
      }
    } catch {
      if (!statusEl.textContent) statusEl.textContent = uiText('暂时无法获取音色，其他设置可正常使用。', 'Could not load voices. Other settings are still available.')
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
