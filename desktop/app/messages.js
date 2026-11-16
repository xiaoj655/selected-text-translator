const ERROR_MESSAGES = new Map([
  ['No translated text returned by endpoint.', '模型没有返回译文,请重试或换个模型。'],
  ['Unable to read translated text from stream response.', '无法从流式响应中读取译文,请重试。'],
  ['qwen-mt non-stream response did not include translated content.', '翻译接口没有返回译文内容。'],
  ['qwen-mt non-stream response is not valid JSON.', '翻译接口返回了无法解析的数据。'],
  ['qwen-mt response did not include a stream body.', '翻译接口没有返回流式数据。'],
  ['Select between 1 and 12,000 characters to continue.', '请选择 1 到 12,000 个字符后再试。'],
])

export function localizeErrorMessage(payload) {
  const message = String(payload?.message || '')
  if (payload?.status === 'missing-configuration') {
    if (/learning model/i.test(message)) return '引导理解需要一个通用学习模型,请先在「设置」里选择。'
    return '还没有配置模型服务,请先在「设置」里填写 API 地址、密钥和模型。'
  }
  if (!message) return '请求失败,请重试。'
  if (/timed? ?out/i.test(message)) return '请求超时,请检查网络后重试。'
  return ERROR_MESSAGES.get(message) || message
}
