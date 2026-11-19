const LANGUAGES = [
  ['Chinese', '简体中文'], ['English', '英语'], ['Japanese', '日语'], ['Korean', '韩语'],
  ['French', '法语'], ['German', '德语'], ['Spanish', '西班牙语'], ['Russian', '俄语'],
]
const MAX_SOURCE_LENGTH = 12000
const $ = (id) => document.getElementById(id)
const api = window.translationPreview

const sourceEl = $('source-text')
const sourceLanguageEl = $('source-language')
const targetLanguageEl = $('target-language')
const targetEl = $('target-text')
const statusEl = $('status')
const translateEl = $('translate-button')
const copyEl = $('copy-button')
const retryEl = $('retry-button')
const configureEl = $('configure-button')
const dialogEl = $('settings-dialog')
const settingsErrorEl = $('settings-error')
const apiKeyEl = $('api-key')

let activeRequestId = null
let completedText = ''
let openingSettings = false

for (const [selectEl, autoLabel] of [[sourceLanguageEl, '自动检测'], [targetLanguageEl, '自动（中英）']]) {
  selectEl.add(new Option(autoLabel, 'auto'))
  for (const [language, label] of LANGUAGES) selectEl.add(new Option(label, language))
}
if (!navigator.platform.startsWith('Mac')) $('shortcut').textContent = 'Ctrl+↵'

function setStatus(text, kind = '') {
  statusEl.textContent = text
  statusEl.dataset.kind = kind
}

function showResult(text) {
  targetEl.textContent = text
  targetEl.hidden = !text
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
  translateEl.disabled = !sourceEl.value.trim()
}

function fail(message, showSettings = false) {
  activeRequestId = null
  showResult('')
  setStatus(message, 'error')
  translateEl.disabled = !sourceEl.value.trim()
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
  if (!text || activeRequestId) return
  resetResult()
  if (text.length > MAX_SOURCE_LENGTH) {
    setStatus('原文超过 12,000 个字符。请分段翻译。', 'error')
    return
  }
  const requestId = crypto.randomUUID()
  activeRequestId = requestId
  translateEl.disabled = true
  setStatus('正在翻译…')
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
  translateEl.disabled = false
})

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
    })
    if (!result?.ok) throw new Error('Incomplete settings')
    dialogEl.close()
    resetResult()
    if (result.isSessionOnly) setStatus('系统无法安全保存密钥。此配置仅在本次运行中有效。')
    sourceEl.focus()
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
  if (dialogEl.open || event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  void translate()
})
translateEl.addEventListener('click', translate)
retryEl.addEventListener('click', () => {
  sourceEl.focus()
  void translate()
})
copyEl.addEventListener('click', copyTranslation)
$('settings-button').addEventListener('click', openSettings)
configureEl.addEventListener('click', openSettings)
$('settings-form').addEventListener('submit', saveSettings)
$('close-settings').addEventListener('click', () => dialogEl.close())
dialogEl.addEventListener('cancel', (event) => {
  if ($('save-settings').disabled) event.preventDefault()
})
dialogEl.addEventListener('close', () => { apiKeyEl.value = '' })
