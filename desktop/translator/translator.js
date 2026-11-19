import { createTeacherView } from './teacher-view.js'

const LANGUAGES = [
  ['Chinese', '简体中文'], ['English', '英语'], ['Japanese', '日语'], ['Korean', '韩语'],
  ['French', '法语'], ['German', '德语'], ['Spanish', '西班牙语'], ['Russian', '俄语'],
]
const MAX_SOURCE_LENGTH = 12000
const $ = (id) => document.getElementById(id)
const api = window.desktopTranslator

const translationPageEl = $('translation-page')
const teacherPageEl = $('teacher-page')
const translationModeEl = $('translation-mode')
const teacherModeEl = $('teacher-mode')
const sourceEl = $('source-text')
const sourceLanguageEl = $('source-language')
const targetLanguageEl = $('target-language')
const targetEl = $('target-text')
const placeholderEl = $('target-placeholder')
const statusEl = $('status')
const countEl = $('source-count')
const clearEl = $('clear-button')
const translateEl = $('translate-button')
const copyEl = $('copy-button')
const stopEl = $('stop-button')
const retryEl = $('retry-button')
const configureEl = $('configure-button')
const dialogEl = $('settings-dialog')
const settingsErrorEl = $('settings-error')
const apiKeyEl = $('api-key')
const learningModelEl = $('learning-model')
const teacherView = createTeacherView({ api, openSettings })

let activeRequestId = null
let completedText = ''
let openingSettings = false

for (const [selectEl, autoLabel] of [[sourceLanguageEl, '自动检测'], [targetLanguageEl, '自动（中英）']]) {
  selectEl.add(new Option(autoLabel, 'auto'))
  for (const [language, label] of LANGUAGES) selectEl.add(new Option(label, language))
}
if (!navigator.platform.startsWith('Mac')) $('shortcut').textContent = 'Ctrl+↵'

function setMode(isLearning) {
  translationPageEl.hidden = isLearning
  teacherPageEl.hidden = !isLearning
  translationModeEl.setAttribute('aria-pressed', String(!isLearning))
  teacherModeEl.setAttribute('aria-pressed', String(isLearning))
  if (isLearning) teacherView.show()
  else sourceEl.focus()
}

function setStatus(text, kind = '') {
  statusEl.textContent = text
  statusEl.dataset.kind = kind
  placeholderEl.hidden = Boolean(text) || !targetEl.hidden
}

function showResult(text) {
  targetEl.textContent = text
  targetEl.hidden = !text
  placeholderEl.hidden = !targetEl.hidden || Boolean(statusEl.textContent)
}

function updateSourceControls() {
  const length = sourceEl.value.trim().length
  const isOverLimit = length > MAX_SOURCE_LENGTH
  const count = length.toLocaleString('zh-CN')
  const limit = MAX_SOURCE_LENGTH.toLocaleString('zh-CN')
  countEl.hidden = !length
  countEl.textContent = isOverLimit ? `${count} 字符，超出 ${limit} 上限` : `${count} / ${limit} 字符`
  countEl.dataset.kind = isOverLimit ? 'error' : ''
  sourceEl.setAttribute('aria-invalid', String(isOverLimit))
  clearEl.disabled = !sourceEl.value
  translateEl.disabled = !length || isOverLimit || Boolean(activeRequestId)
  stopEl.hidden = !activeRequestId
}

function resetResult() {
  if (activeRequestId) {
    api.cancel(activeRequestId).catch(() => {})
    activeRequestId = null
  }
  completedText = ''
  setStatus('')
  showResult('')
  copyEl.disabled = true
  copyEl.textContent = '复制译文'
  retryEl.hidden = true
  configureEl.hidden = true
  updateSourceControls()
}

function fail(message, showSettings = false) {
  activeRequestId = null
  showResult('')
  setStatus(message, 'error')
  updateSourceControls()
  retryEl.hidden = showSettings
  configureEl.hidden = !showSettings
}

function formatError(message) {
  const code = message.match(/Request failed \((\d+)\)/)?.[1]
  const hints = {
    400: '模型拒绝了请求。请检查模型是否支持此翻译接口。',
    401: '服务拒绝了请求（401）。请在模型设置里检查 API Key（密钥）。',
    403: '没有调用这个模型的权限（403）。请检查模型权限。',
    404: '翻译接口不存在（404）。请检查 API 地址和模型。',
    429: '请求太频繁。稍等片刻后重试。',
  }
  if (code) return hints[code] || `翻译服务返回错误（${code}）。请重试。`
  if (/timed out/i.test(message)) return '翻译超时。请检查网络后重试。'
  if (/fetch failed|network/i.test(message)) return '无法连接翻译服务。请检查网络和 API 地址后重试。'
  if (/translated text|translated content/i.test(message)) return '模型没有返回可用的译文。请重试或换个模型。'
  return '无法读取译文。请重试，或在模型设置里检查当前模型。'
}

async function translate() {
  const text = sourceEl.value.trim()
  if (!text || text.length > MAX_SOURCE_LENGTH || activeRequestId) return
  resetResult()
  const requestId = crypto.randomUUID()
  activeRequestId = requestId
  updateSourceControls()
  setStatus('正在翻译…', 'working')
  try {
    const response = await api.translate({
      requestId, text, sourceLanguage: sourceLanguageEl.value, targetLanguage: targetLanguageEl.value,
    })
    if (!response?.accepted && activeRequestId === requestId) fail('无法开始翻译。请重试。')
  } catch {
    if (activeRequestId === requestId) fail('无法开始翻译。请重试。')
  }
}

api.onResult(({ requestId, status, translatedText, message }) => {
  if (requestId !== activeRequestId) return
  if (status === 'stream') showResult(translatedText)
  if (status === 'missing-configuration') fail('先配置模型服务，再翻译这段文字。', true)
  if (status === 'error') fail(formatError(String(message || '')))
  if (status !== 'success') return

  activeRequestId = null
  completedText = translatedText
  showResult(completedText)
  setStatus('')
  copyEl.disabled = false
  updateSourceControls()
})

function stopTranslation() {
  if (!activeRequestId) return
  resetResult()
  setStatus('已停止翻译')
  sourceEl.focus()
}

async function copyTranslation() {
  const text = completedText
  if (!text) return
  try {
    await api.copy(text)
    if (completedText === text) copyEl.textContent = '已复制'
  } catch {
    if (completedText === text) setStatus('复制失败，可以手动选中译文复制。', 'error')
  }
}

async function openSettings() {
  if (openingSettings || dialogEl.open) return
  openingSettings = true
  try {
    const settings = await api.settings()
    $('base-url').value = settings.baseUrl
    $('model').value = settings.model
    learningModelEl.value = settings.learningModel
    apiKeyEl.value = ''
    apiKeyEl.required = !settings.hasKey
    apiKeyEl.placeholder = settings.hasKey ? '已保存，留空沿用' : ''
    settingsErrorEl.hidden = true
    dialogEl.showModal()
  } catch {
    setStatus('无法读取模型设置。请重试。', 'error')
  } finally {
    openingSettings = false
  }
}

async function saveSettings(event) {
  event.preventDefault()
  const saveEl = $('save-settings')
  if (saveEl.disabled) return
  settingsErrorEl.hidden = true
  saveEl.disabled = true
  $('close-settings').disabled = true
  try {
    const result = await api.saveSettings({
      baseUrl: $('base-url').value.trim(), apiKey: apiKeyEl.value.trim(), model: $('model').value.trim(),
      learningModel: learningModelEl.value.trim(),
    })
    if (result?.code === 'learning-model') {
      settingsErrorEl.textContent = '学习模型需要支持对话和引导，请填写通用模型。'
      settingsErrorEl.hidden = false
      learningModelEl.focus()
      return
    }
    if (!result?.ok) throw new Error('Incomplete settings')
    dialogEl.close()
    if (result.didTranslationSettingsChange) resetResult()
    if (result.isSessionOnly && !activeRequestId) setStatus('系统无法安全保存密钥。此配置仅在本次运行中有效。')
    if (!translationPageEl.hidden) sourceEl.focus()
  } catch {
    settingsErrorEl.textContent = '无法保存。请检查 API 地址、密钥和模型。'
    settingsErrorEl.hidden = false
  } finally {
    saveEl.disabled = false
    $('close-settings').disabled = false
  }
}

sourceEl.addEventListener('input', resetResult)
sourceLanguageEl.addEventListener('change', resetResult)
targetLanguageEl.addEventListener('change', resetResult)
document.addEventListener('keydown', (event) => {
  if (translationPageEl.hidden || dialogEl.open || event.isComposing) return
  if (event.key === 'Escape' && activeRequestId) {
    event.preventDefault()
    stopTranslation()
    return
  }
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  void translate()
})
clearEl.addEventListener('click', () => {
  sourceEl.value = ''
  resetResult()
  sourceEl.focus()
})
translateEl.addEventListener('click', translate)
stopEl.addEventListener('click', stopTranslation)
retryEl.addEventListener('click', () => {
  sourceEl.focus()
  void translate()
})
copyEl.addEventListener('click', copyTranslation)
translationModeEl.addEventListener('click', () => setMode(false))
teacherModeEl.addEventListener('click', () => setMode(true))
$('settings-button').addEventListener('click', openSettings)
configureEl.addEventListener('click', openSettings)
$('settings-form').addEventListener('submit', saveSettings)
$('close-settings').addEventListener('click', () => dialogEl.close())
dialogEl.addEventListener('cancel', (event) => {
  if ($('save-settings').disabled) event.preventDefault()
})
dialogEl.addEventListener('close', () => { apiKeyEl.value = '' })
