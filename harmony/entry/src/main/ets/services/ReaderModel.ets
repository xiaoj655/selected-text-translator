import { url } from '@kit.ArkTS'
import { BusinessError } from '@kit.BasicServicesKit'
import { rcp } from '@kit.RemoteCommunicationKit'
import { ReaderSelection } from '../reader/ReaderDomain'
import { buildReaderModelRequest, parseReaderModelResponse, ReaderExplanation } from './ReaderModelContract'
import { READER_SYSTEM_PROMPT } from './ReaderPrompt'

export { ReaderExplanation } from './ReaderModelContract'

export interface ReaderModelSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export interface ReaderLookupOperation {
  result: Promise<ReaderExplanation>
  cancel(): void
}

const MAX_SELECTION_LENGTH = 12000
const MAX_RESPONSE_BYTES = 512000
const CHAT_COMPLETIONS = '/chat/completions'

export function defaultReaderModelSettings(): ReaderModelSettings {
  return {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-flash',
    apiKey: ''
  }
}

export function validateReaderModelSettings(settings: ReaderModelSettings, requireKey: boolean = true): ReaderModelSettings {
  const parsedUrl = parseModelUrl(settings.baseUrl.trim())
  const model = settings.model.trim()
  const apiKey = settings.apiKey.trim()
  if (model.length === 0) {
    throw new Error('请输入用于解释单词和句子的模型名称。')
  }
  if (model.toLowerCase().includes('qwen-mt')) {
    throw new Error('请填写支持聊天补全的通用模型，例如 qwen3.8-flash。')
  }
  if (requireKey && apiKey.length === 0) {
    throw new Error('请先在设置中填写 API Key。')
  }
  if (apiKey.length > 0 && !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('API Key 中含有空格或无效字符。')
  }
  return { baseUrl: parsedUrl.href.replace(/\/+$/, ''), apiKey, model }
}

function parseModelUrl(value: string): url.URL {
  let parsedUrl: url.URL | undefined
  if (/^https:\/\/[^/?#\s\\@]+(?:\/[^?#\s\\]*)?$/i.test(value)) {
    try {
      parsedUrl = url.URL.parseURL(value)
    } catch {
      // Let all invalid URLs report the same message without including the entered value.
    }
  }
  if (parsedUrl === undefined || parsedUrl.protocol !== 'https:' || !parsedUrl.hostname || parsedUrl.username) {
    throw new Error('请输入 HTTPS API 地址，地址中不能含有账号、查询参数或片段。')
  }
  return parsedUrl
}

function httpStatusError(code: number): Error {
  if (code >= 300 && code < 400) {
    return new Error('API 地址返回了重定向。请在设置中填写最终的 HTTPS API 地址。')
  }
  if (code === 401 || code === 403) {
    return new Error('模型服务拒绝访问。请检查 API Key 和模型授权。')
  }
  if (code === 404) {
    return new Error('找不到接口或模型。请检查 API 地址和模型名称。')
  }
  if (code === 429) {
    return new Error('模型服务请求过多或额度不足。请稍后重试。')
  }
  return new Error(`模型服务请求失败（HTTP ${code}）。请检查设置或稍后重试。`)
}

class ModelLookup implements ReaderLookupOperation {
  readonly result: Promise<ReaderExplanation>
  private session?: rcp.Session

  constructor(settings: ReaderModelSettings, selection: ReaderSelection) {
    this.result = this.run(settings, selection)
  }

  cancel(): void {
    this.session?.cancel()
  }

  private async run(settings: ReaderModelSettings, selection: ReaderSelection): Promise<ReaderExplanation> {
    const config = validateReaderModelSettings(settings)
    if (selection.text.length > MAX_SELECTION_LENGTH) {
      throw new Error('这句话太长，无法一次查询。试试点词模式。')
    }
    const apiUrl = config.baseUrl.endsWith(CHAT_COMPLETIONS) ? config.baseUrl : `${config.baseUrl}${CHAT_COMPLETIONS}`
    const hostname = parseModelUrl(apiUrl).hostname
    const bailian = hostname === 'dashscope.aliyuncs.com' || hostname === 'dashscope-intl.aliyuncs.com' ||
      hostname === 'dashscope-us.aliyuncs.com'
    let response: rcp.Response
    try {
      const session = rcp.createSession({
        requestConfiguration: {
          transfer: { autoRedirect: false, timeout: { connectMs: 10000, transferMs: 35000 } },
          security: { remoteValidation: 'system' }
        }
      })
      this.session = session
      const request = new rcp.Request(apiUrl, 'POST', {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json'
      }, buildReaderModelRequest(config.model, selection, READER_SYSTEM_PROMPT, bailian))
      response = await session.fetch(request)
    } catch (error) {
      const code = (error as BusinessError).code
      if (code === 1007900992) {
        throw new Error('查询已取消。')
      }
      if (code === 1007900028) {
        throw new Error('模型请求超时。请稍后重试。')
      }
      throw new Error('无法连接模型服务。请检查网络和 API 地址。')
    } finally {
      this.session?.close()
      this.session = undefined
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw httpStatusError(response.statusCode)
    }
    if (response.body === undefined || response.body.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('模型响应为空或过长。请重试。')
    }
    return parseReaderModelResponse(response.toString() ?? '', selection.kind === 'word')
  }
}

export function startReaderLookup(settings: ReaderModelSettings, selection: ReaderSelection): ReaderLookupOperation {
  return new ModelLookup(settings, selection)
}

export function lookupReaderSelection(settings: ReaderModelSettings, selection: ReaderSelection): Promise<ReaderExplanation> {
  return startReaderLookup(settings, selection).result
}
