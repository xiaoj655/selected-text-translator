import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildQwenMtRequest } from '../../src/translation-contracts.js'
import { extractQwenScopedTranslation } from '../../src/qwen-context.js'
import { detectLanguage } from './e2e/language-detect.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const reportDir = join(desktopDir, 'artifacts', 'e2e', 'report')

const config = process.env.STT_LIVE_CONFIG
  ? JSON.parse(readFileSync(process.env.STT_LIVE_CONFIG, 'utf8'))
  : { apiKey: process.env.STT_API_KEY, baseUrl: process.env.STT_BASE_URL }
if (!config.apiKey || !config.baseUrl) {
  console.log('[verify:live-languages] skipped: set STT_API_KEY/STT_BASE_URL or STT_LIVE_CONFIG')
  process.exit(0)
}

const model = process.env.STT_TRANSLATION_MODEL || 'qwen-mt-flash'
const SOURCE_LANG = process.env.STT_LIVE_SOURCE_LANG || 'en'
const SOURCE = process.env.STT_LIVE_SOURCE_TEXT
  || 'Good morning, my friend. How are you today? I am very happy to see you.'
const LANGUAGES = ['Japanese', 'Korean', 'French', 'German', 'Spanish']
const MAX_TOKENS = 120

const preview = (text) => String(text || '').slice(0, 60)

async function translate(targetLanguage) {
  const request = buildQwenMtRequest({ model, text: SOURCE, targetLanguage })
  request.stream = false
  request.max_tokens = MAX_TOKENS
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(25000),
  })
  if (!response.ok) return { ok: false, status: response.status }
  const json = await response.json()
  const content = json.choices?.[0]?.message?.content
  const translation = extractQwenScopedTranslation(content, null).trim()
  if (!translation) return { ok: false, error: 'empty translation' }
  const detected = detectLanguage(translation)
  return {
    ok: detected === targetLanguage,
    detected,
    translationLength: translation.length,
    preview: preview(translation),
    tokens: json.usage?.total_tokens,
  }
}

export async function runLiveLanguageVerification() {
  mkdirSync(reportDir, { recursive: true })
  const results = []
  for (const targetLanguage of LANGUAGES) {
    const startedAt = Date.now()
    try {
      const outcome = await translate(targetLanguage)
      results.push({ targetLanguage, ...outcome, elapsedMs: Date.now() - startedAt })
      const label = outcome.ok ? 'ok' : 'FAIL'
      const detail = outcome.error || `detected=${outcome.detected || 'n/a'}${outcome.preview ? ` :: ${outcome.preview}` : ''}`
      console.log(`[verify:live-languages] ${label} ${targetLanguage} -> ${detail}`)
    } catch (error) {
      results.push({ targetLanguage, ok: false, error: String(error?.message || error) })
      console.error(`[verify:live-languages] FAIL ${targetLanguage}: ${error?.message || error}`)
    }
  }
  const report = {
    date: new Date().toISOString(),
    model,
    sourceLang: SOURCE_LANG,
    source: SOURCE,
    requestCapPerLanguage: 1,
    maxTokens: MAX_TOKENS,
    results,
  }
  writeFileSync(join(reportDir, `live-languages-${SOURCE_LANG}.json`), JSON.stringify(report, null, 2))
  const failed = results.filter((item) => !item.ok)
  console.log(`[verify:live-languages] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

await runLiveLanguageVerification()
