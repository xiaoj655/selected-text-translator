import { uiText } from './ui-language.js'
export function getModelsEndpoint(baseUrl) {
  const url = new URL(String(baseUrl || '').trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(uiText('API 地址需要使用 HTTP 或 HTTPS。', 'The API URL must use HTTP or HTTPS.'))
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/models'
  url.search = ''
  url.hash = ''
  return url.href
}

export async function discoverProviderModels({ baseUrl, apiKey } = {}, fetchProvider = fetch) {
  if (!String(apiKey || '').trim()) return { ok: false, message: uiText('请先填写 API Key。', 'Enter an API key first.') }
  try {
    const response = await fetchProvider(getModelsEndpoint(baseUrl), {
      headers: { Authorization: `Bearer ${String(apiKey).trim()}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      const messages = {
        401: uiText('密钥无效，或没有访问此服务的权限。', 'The API key is invalid or does not have access to this service.'),
        403: uiText('此密钥没有访问此服务的权限。', 'This API key does not have access to the service.'),
        404: uiText('此接口没有模型列表，可直接填写模型名称后使用。', 'This endpoint has no model list. You can enter the model name manually.'),
        429: uiText('请求过于频繁，请稍后再试。', 'Too many requests. Try again in a moment.'),
      }
      return { ok: false, message: messages[response.status] || uiText(`连接失败（${response.status}），请稍后再试。`, `Connection failed (${response.status}). Try again.`) }
    }
    const json = await response.json()
    if (!Array.isArray(json?.data)) return { ok: false, message: uiText('接口未返回可识别的模型列表。', 'The endpoint did not return a recognizable model list.') }
    const models = [...new Set(json.data.map((item) => item?.id)
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160))].sort()
    return { ok: true, models: models.slice(0, 1000) }
  } catch {
    return { ok: false, message: uiText('无法连接。请检查 API 地址和网络，或稍后重试。', 'Could not connect. Check the API URL and your network connection, then try again.') }
  }
}

export function handleProviderDiagnostics(message, sender, sendResponse) {
  if (message?.type !== 'DISCOVER_PROVIDER_MODELS') return false
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return false
  void discoverProviderModels(message.payload, chrome.providerFetch?.('provider-models')).then(sendResponse)
  return true
}
