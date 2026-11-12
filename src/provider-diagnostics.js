export function getModelsEndpoint(baseUrl) {
  const url = new URL(String(baseUrl || '').trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址需要使用 HTTP 或 HTTPS。')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/models'
  url.search = ''
  url.hash = ''
  return url.href
}

export async function discoverProviderModels({ baseUrl, apiKey } = {}) {
  if (!String(apiKey || '').trim()) return { ok: false, message: '请先填写 API Key。' }
  try {
    const response = await fetch(getModelsEndpoint(baseUrl), {
      headers: { Authorization: `Bearer ${String(apiKey).trim()}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      const messages = {
        401: '密钥无效，或没有访问此服务的权限。',
        403: '此密钥没有访问此服务的权限。',
        404: '此接口没有模型列表，可直接填写模型名称后使用。',
        429: '请求过于频繁，请稍后再试。',
      }
      return { ok: false, message: messages[response.status] || `连接失败（${response.status}），请稍后再试。` }
    }
    const json = await response.json()
    if (!Array.isArray(json?.data)) return { ok: false, message: '接口未返回可识别的模型列表。' }
    const models = [...new Set(json.data.map((item) => item?.id)
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160))].sort()
    return { ok: true, models: models.slice(0, 1000) }
  } catch {
    return { ok: false, message: '无法连接。请检查 API 地址和网络，或稍后重试。' }
  }
}

export function handleProviderDiagnostics(message, sender, sendResponse) {
  if (message?.type !== 'DISCOVER_PROVIDER_MODELS') return false
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return false
  void discoverProviderModels(message.payload).then(sendResponse)
  return true
}
