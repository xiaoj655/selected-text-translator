import type { ReaderSelection } from '../reader/ReaderDomain'

const CONTEXT_LIMIT = 2400
const OCCURRENCE_LIMIT = 120

export interface ReaderExplanation {
  meaning: string
  phonetic: string
  contextualAnalysis: string
}

interface SelectedOccurrence {
  before: string
  text: string
  after: string
}

interface ArticleMeaningInput {
  selectedText: string
  selectionType: string
  targetLanguage: string
  surroundingContext?: string
  contextStart?: number
  contextEnd?: number
  selectedOccurrence?: SelectedOccurrence
}

interface ModelMessage {
  role: string
  content: string
}

interface ModelResponseFormat {
  type: string
}

interface ModelRequest {
  model: string
  stream: boolean
  messages: ModelMessage[]
  response_format: ModelResponseFormat
  enable_thinking?: boolean
}

interface ModelChoice {
  message?: ModelMessage
}

interface ModelResponse {
  choices?: ModelChoice[]
}

function buildMeaningInput(selection: ReaderSelection): ArticleMeaningInput {
  const input: ArticleMeaningInput = {
    selectedText: selection.text,
    selectionType: selection.kind,
    targetLanguage: 'English'
  }
  const relativeStart = selection.start - selection.sentenceStart
  const relativeEnd = selection.end - selection.sentenceStart
  const contextStart = Math.max(0, relativeStart - Math.floor(Math.max(0, CONTEXT_LIMIT - selection.text.length) / 2))
  const contextEnd = Math.min(selection.sentence.length, contextStart + CONTEXT_LIMIT)
  if (selection.kind === 'word' && relativeStart >= contextStart && relativeEnd > relativeStart &&
    relativeEnd <= contextEnd && selection.sentence.slice(relativeStart, relativeEnd) === selection.text) {
    input.surroundingContext = selection.sentence.slice(contextStart, contextEnd)
    input.contextStart = relativeStart - contextStart
    input.contextEnd = relativeEnd - contextStart
    input.selectedOccurrence = {
      before: selection.sentence.slice(Math.max(contextStart, relativeStart - OCCURRENCE_LIMIT), relativeStart),
      text: selection.text,
      after: selection.sentence.slice(relativeEnd, Math.min(contextEnd, relativeEnd + OCCURRENCE_LIMIT))
    }
  }
  return input
}

export function buildReaderModelRequest(model: string, selection: ReaderSelection, systemPrompt: string,
  bailian: boolean): string {
  const request: ModelRequest = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(buildMeaningInput(selection)) }
    ],
    response_format: { type: 'json_object' }
  }
  if (bailian && model.toLowerCase().startsWith('qwen')) {
    request.enable_thinking = false
  }
  return JSON.stringify(request)
}

export function parseReaderModelResponse(body: string, word: boolean): ReaderExplanation {
  try {
    const response = JSON.parse(body) as ModelResponse
    const content = response?.choices?.[0]?.message?.content
    if (typeof content === 'string') {
      const json = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
      const explanation = JSON.parse(json) as ReaderExplanation
      if (typeof explanation?.meaning === 'string' && explanation.meaning.trim().length > 0) {
        return {
          meaning: explanation.meaning.trim(),
          phonetic: word && typeof explanation.phonetic === 'string' ? explanation.phonetic.trim() : '',
          contextualAnalysis: word && typeof explanation.contextualAnalysis === 'string' ?
            explanation.contextualAnalysis.trim() : ''
        }
      }
    }
  } catch {
    // A malformed service response may contain sensitive data, so report a fixed message.
  }
  throw new Error('模型没有返回可用的释义。请重试或检查设置中的模型。')
}
