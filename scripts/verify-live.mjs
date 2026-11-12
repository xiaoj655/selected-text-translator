import { readFile, writeFile } from 'node:fs/promises'
import { buildReadingRequest, parseReadingResponse } from '../src/reading-support.js'

const config = process.env.STT_LIVE_CONFIG
  ? JSON.parse(await readFile(process.env.STT_LIVE_CONFIG, 'utf8'))
  : { apiKey: process.env.STT_API_KEY, baseUrl: process.env.STT_BASE_URL }
const model = process.env.STT_LEARNING_MODEL || 'qwen3.8-flash'
if (!config.apiKey || !config.baseUrl) throw new Error('Set STT_API_KEY and STT_BASE_URL, or STT_LIVE_CONFIG.')
const repeated = 'The band will record a new record tomorrow.'
const cases = [
  { name: 'word-verb', text: 'record', context: repeated, contextStart: 14, contextEnd: 20 },
  { name: 'word-noun', text: 'record', context: repeated, contextStart: 27, contextEnd: 33 },
  { name: 'phrase', text: 'break the ice', context: 'The room was silent, so Maya told a funny story to break the ice.' },
  { name: 'passage', text: 'Little did she know that the quiet stranger would change her life.',
    context: 'She barely noticed the man sitting by the window. Little did she know that the quiet stranger would change her life.' },
]
const results = []
for (const sample of cases) {
  const startedAt = performance.now()
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildReadingRequest({ model, ...sample })), signal: AbortSignal.timeout(25000),
    })
    const json = await response.json()
    if (!response.ok) {
      results.push({ name: sample.name, status: response.status, ok: false })
      continue
    }
    const result = parseReadingResponse(json.choices?.[0]?.message?.content, 'guide', { text: sample.text })
    results.push({ name: sample.name, ok: true, elapsedMs: Math.round(performance.now() - startedAt),
      tokens: json.usage?.total_tokens, result })
  } catch (error) {
    results.push({ name: sample.name, ok: false, error: error.name })
  }
}
const report = { model, date: new Date().toISOString(), results }
if (process.env.STT_LIVE_REPORT) await writeFile(process.env.STT_LIVE_REPORT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (results.some((result) => !result.ok)) process.exitCode = 1
