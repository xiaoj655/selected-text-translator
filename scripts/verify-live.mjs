import { readFile, writeFile } from 'node:fs/promises'
import { buildReadingRequest, parseReadingResponse } from '../src/reading-support.js'
import { createQwenTranslationScope, extractQwenScopedTranslation } from '../src/qwen-context.js'
import { buildGenericRequest, buildQwenMtRequest, extractGenericResponse, isQwenMtModel, isSingleWordInput }
  from '../src/translation-contracts.js'

const config = process.env.STT_LIVE_CONFIG
  ? JSON.parse(await readFile(process.env.STT_LIVE_CONFIG, 'utf8'))
  : { apiKey: process.env.STT_API_KEY, baseUrl: process.env.STT_BASE_URL }
const task = process.argv.includes('--translation') ? 'translate' : 'guide'
const model = (task === 'translate' && process.env.STT_TRANSLATION_MODEL)
  || process.env.STT_LEARNING_MODEL || 'qwen3.8-flash'
if (!config.apiKey || !config.baseUrl) throw new Error('Set STT_API_KEY and STT_BASE_URL, or STT_LIVE_CONFIG.')
const repeated = 'The band will record a new record tomorrow.'
const readingCases = [
  { name: 'word-verb', text: 'record', context: repeated, contextStart: 14, contextEnd: 20 },
  { name: 'word-noun', text: 'record', context: repeated, contextStart: 27, contextEnd: 33 },
  { name: 'phrase', text: 'break the ice', context: 'The room was silent, so Maya told a funny story to break the ice.' },
  { name: 'passage', text: 'Little did she know that the quiet stranger would change her life.',
    context: 'She barely noticed the man sitting by the window. Little did she know that the quiet stranger would change her life.' },
]
const cases = task === 'translate' ? [
  ...readingCases.slice(0, 3),
  { name: 'phrasal-verb', text: 'take in',
    context: 'The lecture was so dense that I could not take in all the details.' },
  { name: 'mixed-context-english', text: 'bank', context: 'She sat on the bank of the river. 她看着河水。' },
  { name: 'mixed-context-chinese', text: '唱片', context: 'Their new record comes out next week. 我期待这张唱片。' },
] : readingCases
const results = []
for (const sample of cases) {
  const startedAt = performance.now()
  try {
    const requestBody = task === 'guide' ? buildReadingRequest({ model, ...sample })
      : isQwenMtModel(model) ? buildQwenMtRequest({ model, ...sample }) : buildGenericRequest({ model, ...sample })
    requestBody.stream = false
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody), signal: AbortSignal.timeout(25000),
    })
    const json = await response.json()
    if (!response.ok) {
      results.push({ name: sample.name, status: response.status, ok: false })
      continue
    }
    const content = json.choices?.[0]?.message?.content
    const result = task === 'guide' ? parseReadingResponse(content, 'guide', { text: sample.text })
      : isQwenMtModel(model) ? { translation: extractQwenScopedTranslation(content, createQwenTranslationScope(sample)) }
        : extractGenericResponse(content, { allowLexicalFields: isSingleWordInput(sample.text) })
    if (task === 'translate' && !result.translation) throw new Error('Missing translation')
    results.push({ name: sample.name, ok: true, elapsedMs: Math.round(performance.now() - startedAt),
      tokens: json.usage?.total_tokens, result })
  } catch (error) {
    results.push({ name: sample.name, ok: false, error: error.name })
  }
}
const report = { task, model, date: new Date().toISOString(), results }
if (process.env.STT_LIVE_REPORT) await writeFile(process.env.STT_LIVE_REPORT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (results.some((result) => !result.ok)) process.exitCode = 1
