import { uiText } from './ui-language.js'
export function bindConnectionControls() {
  const buttonEl = document.getElementById('discover-models')
  const statusEl = document.getElementById('connection-status')
  const providerEl = document.getElementById('provider-models')
  const learningEl = document.getElementById('learning-models')
  const baseUrlEl = document.getElementById('base_url')
  const apiKeyEl = document.getElementById('api_key')
  if (!buttonEl || !statusEl || !providerEl || !learningEl || !baseUrlEl || !apiKeyEl) return
  buttonEl.addEventListener('click', async () => {
    buttonEl.disabled = true
    statusEl.textContent = uiText('正在连接并读取可用模型…', 'Connecting and looking up models…')
    const baseUrl = baseUrlEl.value.trim()
    const apiKey = apiKeyEl.value.trim()
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DISCOVER_PROVIDER_MODELS', payload: { baseUrl, apiKey },
      })
      if (baseUrlEl.value.trim() !== baseUrl || apiKeyEl.value.trim() !== apiKey) {
        statusEl.textContent = uiText('连接配置已改变，请重新获取。', 'Connection details changed. Try the connection test again.')
        return
      }
      if (!response?.ok) {
        statusEl.textContent = response?.message || uiText('无法连接，请重试。', 'Could not connect. Try again.')
        return
      }
      providerEl.replaceChildren()
      learningEl.replaceChildren()
      const models = response.models.filter((model) => !/image|audio|realtime|embedding|rerank|\basr\b|\btts\b/i.test(model))
      for (const model of models) {
        const optionEl = document.createElement('option')
        optionEl.value = model
        providerEl.appendChild(optionEl)
        if (!model.toLowerCase().includes('qwen-mt')) learningEl.appendChild(optionEl.cloneNode())
      }
      statusEl.textContent = uiText(`连接成功。找到 ${models.length} 个文本模型，输入模型名称即可筛选。`, `Connected. ${models.length} text models found. Type a model name to filter.`)
    } catch {
      statusEl.textContent = uiText('连接失败，请重新加载插件后重试。', 'Connection test failed. Restart the app and try again.')
    } finally {
      buttonEl.disabled = false
    }
  })
}
