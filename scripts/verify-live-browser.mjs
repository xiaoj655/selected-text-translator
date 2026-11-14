import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const config = process.env.STT_LIVE_CONFIG
  ? JSON.parse(await readFile(process.env.STT_LIVE_CONFIG, 'utf8'))
  : { apiKey: process.env.STT_API_KEY, baseUrl: process.env.STT_BASE_URL }
if (!config.apiKey || !config.baseUrl) throw new Error('Provide STT_API_KEY and STT_BASE_URL, or STT_LIVE_CONFIG.')
const task = process.argv.includes('--translation') ? 'translate' : 'guide'
const isSentence = task === 'guide' && process.argv.includes('--sentence')
const model = task === 'translate' ? process.env.STT_TRANSLATION_MODEL || 'qwen-mt-flash'
  : process.env.STT_LEARNING_MODEL || 'qwen3.8-flash'
const selectedText = task === 'translate' ? 'record' : isSentence
  ? 'Although the proposal looked promising, the board was reluctant to approve it without further evidence.' : 'reluctant'
const sourceText = task === 'translate' ? 'The band will record a new record tomorrow.'
  : isSentence ? `The team presented their plan. ${selectedText}`
    : 'She was reluctant to accept the offer. Moving away meant leaving her friends behind.'
const extensionPath = resolve(import.meta.dirname, '..')
const profilePath = await mkdtemp(join(tmpdir(), 'selected-live-browser-'))
const artifactPath = process.env.STT_ARTIFACT_DIR || join(tmpdir(), 'selected-live-preview')
await mkdir(artifactPath, { recursive: true })
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html lang="en"><head><title>Selected · Live check</title><style>body{margin:90px auto;max-width:700px;color:#263b30;background:#f5f4ef;font:21px/1.8 Georgia,serif}h1{font-size:42px;font-weight:400}</style></head><body><h1>A little closer to understanding.</h1><p id="source">${sourceText}</p></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
let page
try {
  browser = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium', headless: true, viewport: { width: 1150, height: 850 }, timezoneId: 'Asia/Shanghai',
    args: ['--no-sandbox', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker')
  await worker.evaluate(async ({ baseUrl, apiKey, model, task }) => {
    await chrome.storage.sync.set({ base_url: baseUrl, api_key: apiKey,
      model, learning_model: task === 'translate' ? '' : model, reading_mode: task, debug_logging_enabled: false })
  }, { ...config, model, task })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('#selected-reading-assistant').waitFor({ state: 'attached' })
  await page.evaluate((selectedText) => {
    const node = document.getElementById('source').firstChild
    const start = node.textContent.lastIndexOf(selectedText)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + selectedText.length)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
  }, selectedText)
  const start = performance.now()
  await page.locator('.stt-trigger').click()
  await page.waitForFunction((task) => {
    const root = document.getElementById('selected-reading-assistant')?.shadowRoot
    return Boolean(root?.querySelector(task === 'translate' ? '.stt-save, .stt-error' : '.stt-hint, .stt-error'))
  }, task, { timeout: 28000 })
  const errors = await page.locator('.stt-error').allTextContents()
  assert.equal(errors.length, 0, errors.join(' '))
  const elapsedMs = Math.round(performance.now() - start)
  if (task === 'guide') {
    assert.equal(await page.locator('.stt-hint').count(), 1)
    assert.equal(await page.locator('.stt-answer').count(), 0)
    if (await page.locator('.stt-next-hint').count()) {
      await page.locator('.stt-next-hint').click()
      assert.equal(await page.locator('.stt-hint').count(), 2)
    }
    await page.locator('.stt-card').screenshot({
      path: join(artifactPath, isSentence ? 'live-sentence-card.png' : 'live-reading-card.png'),
    })
    await page.locator('.stt-reveal').click()
    if (isSentence) {
      assert.equal(await page.locator('.stt-guide-heading .stt-section-label').textContent(), 'FOLLOW THE SENTENCE')
      assert.equal(await page.locator('.stt-example, .stt-usage, .stt-phonetic').count(), 0)
      assert.equal(await page.locator('.stt-sentence-explanation').getAttribute('open'), null)
      assert.equal(await page.locator('.stt-sentence-explanation .stt-explanation').isVisible(), false)
      await page.locator('.stt-card').screenshot({ path: join(artifactPath, 'live-sentence-answer.png') })
    }
  } else {
    const translation = await page.locator('.stt-card-block--translation').textContent()
    assert.match(translation, /唱片|专辑|音乐录音/u)
    assert.ok(translation.length <= 12)
    assert.doesNotMatch(translation, /stt-selected|乐队|明天/u)
    await page.locator('.stt-card').screenshot({ path: join(artifactPath, 'live-translation-card.png') })
  }
  await page.locator('.stt-save').click()
  await page.getByRole('button', { name: '✓ 已收藏', exact: true }).waitFor()
  const entry = await worker.evaluate(async () => (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries[0])
  assert.equal(entry.text, selectedText)
  assert.ok(entry.meaning)
  if (task === 'translate') assert.equal(entry.contextStart, 27)
  const library = await browser.newPage()
  await library.goto(`chrome-extension://${new URL(worker.url()).host}/src/library.html`)
  await library.locator('.entry-card > summary').click()
  await library.screenshot({ path: join(artifactPath, 'live-library.png'), fullPage: true })
  console.log(JSON.stringify({ ok: true, task, isSentence, model, elapsedMs, text: entry.text, phonetic: entry.phonetic,
    meaning: entry.meaning, savedToVocabulary: true, artifacts: artifactPath }))
} catch (error) {
  if (page) {
    const message = await page.locator('.stt-error').textContent({ timeout: 500 }).catch(() => '')
    console.error(JSON.stringify({ ok: false, task, isSentence, model, error: error.name, message }))
    await page.screenshot({ path: join(artifactPath, 'live-failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(profilePath, { recursive: true, force: true })
}
