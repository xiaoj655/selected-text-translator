import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const extensionPath = resolve(import.meta.dirname, '..')
const profilePath = await mkdtemp(join(tmpdir(), 'selected-browser-'))
const artifactPath = process.env.STT_ARTIFACT_DIR || join(tmpdir(), 'selected-browser-preview')
await mkdir(artifactPath, { recursive: true })
const requests = []
let shouldFailPronunciation = false
let shouldDelayGuide = false
const guide = {
  phonetic: '/rɪˈlʌktənt/',
  hints: [
    'Look at her reaction to the offer. Does she seem ready to say yes?',
    'She is not refusing outright, but something is holding her back. How willing does she feel?',
    'Think of someone who pauses before agreeing because they have doubts.',
  ],
  answer: {
    meaning: 'Here, reluctant means hesitant or unwilling to do something.',
    explanation: 'The offer is available, but she does not feel ready to accept it.',
    example: 'He was reluctant to leave the quiet little town.',
  },
}
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''
    for await (const part of request) body += part
    const payload = JSON.parse(body)
    requests.push(payload)
    const prompt = payload.messages[0].content
    if (payload.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"不情愿的；犹豫的"}}]}')
      return
    }
    if (prompt.includes('Never include definitions') && shouldFailPronunciation) {
      response.writeHead(503)
      response.end('Unavailable')
      return
    }
    if (shouldDelayGuide) await new Promise((resolve) => setTimeout(resolve, 200))
    const selected = JSON.parse(payload.messages.at(-1).content || '{}')
    const recordGuide = {
      phonetic: '/ˈrɛkərd/',
      hints: [
        "Notice the word 'a' just before the selected word.",
        'The band is making something new that people will listen to.',
        'Think of choosing an album in a music shop.',
      ],
      answer: { meaning: 'An album or recording of music.',
        explanation: 'Here, the word names the music the band is going to make, rather than the action of saving sound.',
        example: 'Their new record comes out next week.', usage: 'a new record by + artist' },
    }
    const phonetic = selected.selectedText === 'record' ? '/ˈrɛkərd/' : '/ˈɔfɚ/'
    const result = prompt.includes('Never include definitions') ? { phonetic }
      : selected.selectedText === 'record' ? recordGuide : guide
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
    return
  }
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'qwen-mt-flash' }, { id: 'test-tutor' }] }))
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html lang="en"><head><title>A slower kind of reading</title><style>
    body{margin:0;background:#f5f4ef;color:#343d34;font:18px/1.9 Georgia,serif;min-height:2400px}
    main{max-width:680px;margin:80px auto} .eyebrow{font:11px sans-serif;letter-spacing:3px;color:#829079}
    h1{font-size:42px;font-weight:400;line-height:1.2;margin:20px 0 28px} p{max-width:570px}
    .note{font:13px/1.8 sans-serif;color:#929889;margin-top:40px}
    button {font-size:80px!important;background:red!important} .stt-card{display:none!important}
    </style></head><body><main><div class="eyebrow">THE READING ROOM / 01</div>
    <h1>Some words ask us<br>to stay a little longer.</h1>
    <p id="sentence">She was reluctant to accept the offer. It meant leaving the small town she had called home for so many years.</p>
    <p id="repeated">The band will record a new record tomorrow.</p><p id="passage">Sometimes, understanding is less about finding an answer and more about noticing what is already there.</p>
    <p class="note">Select a word. Listen to its sound.<br>Let the surrounding words show you the way.</p></main></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let context
try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  await worker.evaluate(async (origin) => {
    await chrome.storage.sync.set({ base_url: `${origin}/v1`, api_key: 'browser-test-token',
      model: 'qwen-mt-flash', learning_model: 'test-tutor', reading_mode: 'guide' })
    globalThis.speechCalls = []
    globalThis.speechStops = 0
    chrome.tts.getVoices = async () => [{ voiceName: 'Test English', lang: 'en-US', remote: false }]
    chrome.tts.speak = (text, options, done) => {
      globalThis.speechCalls.push({ text, rate: options.rate })
      globalThis.finishSpeech = () => options.onEvent({ type: 'end' })
      options.onEvent({ type: 'start' })
      done()
    }
    chrome.tts.stop = () => { globalThis.speechStops++ }
  }, origin)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin)
  await page.locator('#selected-reading-assistant').waitFor({ state: 'attached' })
  async function selectText(text, selector = '#sentence', occurrence = 0, targetPage = page) {
    await targetPage.evaluate(({ text, selector, occurrence }) => {
      const node = document.querySelector(selector).firstChild
      let start = node.textContent.indexOf(text)
      for (let i = 0; i < occurrence; i++) start = node.textContent.indexOf(text, start + text.length)
      if (start < 0) throw new Error('Fixture selection not found')
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + text.length)
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
    }, { text, selector, occurrence })
    await targetPage.locator('.stt-trigger').waitFor({ state: 'visible' })
  }
  await selectText('reluctant')
  await page.locator('.stt-trigger').hover()
  await page.locator('.stt-hint').first().waitFor()
  assert.equal(await page.locator('.stt-hint').count(), 1)
  assert.equal(await page.locator('.stt-answer').count(), 0)
  assert.equal(requests.length, 1)
  assert.match(JSON.parse(requests[0].messages[1].content).surroundingContext, /small town/)
  await page.locator('.stt-next-hint').click()
  assert.equal(await page.locator('.stt-hint').count(), 2)
  assert.equal(requests.length, 1)
  await page.screenshot({ path: join(artifactPath, 'reading-guide.png') })
  await page.locator('.stt-card').screenshot({ path: join(artifactPath, 'reading-card.png') })
  const originalWidth = (await page.locator('.stt-card').boundingBox()).width
  const handle = await page.locator('.stt-card-resize-handle').boundingBox()
  await page.mouse.move(handle.x + 3, handle.y + 12)
  await page.mouse.down()
  await page.mouse.move(handle.x + 75, handle.y + 12)
  await page.mouse.up()
  assert.equal(Math.round((await page.locator('.stt-card').boundingBox()).width), Math.round(originalWidth + 72))
  await page.locator('.stt-reveal').click()
  assert.match(await page.locator('.stt-answer').textContent(), /hesitant or unwilling/)
  await page.getByRole('button', { name: '翻译', exact: true }).click()
  await page.locator('.stt-card-block--translation').waitFor()
  assert.equal(requests.length, 2)
  await page.getByRole('button', { name: '引导理解', exact: true }).click()
  assert.equal(await page.locator('.stt-hint').count(), 2)
  assert.equal(await page.locator('.stt-answer').count(), 1)
  assert.equal(requests.length, 2)
  await page.locator('.stt-speak:not(.stt-speak-context)').click()
  await page.getByRole('button', { name: '■ 停止', exact: true }).waitFor()
  assert.equal(await worker.evaluate(() => speechCalls.length), 1)
  await page.locator('.stt-speak:not(.stt-speak-context)').click()
  assert.equal(await worker.evaluate(() => speechStops), 1)
  await page.locator('.stt-speak-context').click()
  assert.equal(await worker.evaluate(() => speechCalls.at(-1).text), 'She was reluctant to accept the offer.')
  await page.locator('.stt-speak-context').click()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.stt-card').count(), 0)
  await page.locator('.stt-trigger').press('Enter')
  await page.locator('.stt-answer').waitFor()
  assert.equal(requests.length, 2)
  await page.getByRole('button', { name: '翻译', exact: true }).click()
  await selectText('offer')
  await page.locator('.stt-trigger').click()
  await page.locator('.stt-card-block--translation').waitFor()
  await page.locator('.stt-phonetic').waitFor()
  assert.equal(await page.locator('.stt-phonetic').textContent(), '/ˈɔfɚ/')
  assert.equal(await page.locator('.stt-card-block--translation').count(), 1)
  shouldFailPronunciation = true
  await selectText('small')
  await page.locator('.stt-trigger').click()
  await page.waitForFunction(() => document.querySelector('#selected-reading-assistant').shadowRoot
    .querySelector('.stt-speech-status')?.textContent.includes('503'))
  assert.equal(await page.locator('.stt-card-block--translation').count(), 1)
  shouldFailPronunciation = false
  await page.getByRole('button', { name: '查看音标', exact: true }).click()
  await page.locator('.stt-phonetic').waitFor()
  const triggerBefore = await page.locator('.stt-trigger').boundingBox()
  await page.evaluate(() => window.scrollBy(0, 60))
  await page.waitForFunction((before) => {
    const trigger = document.querySelector('#selected-reading-assistant').shadowRoot.querySelector('.stt-trigger')
    return trigger && Math.abs(trigger.getBoundingClientRect().top - (before - 60)) < 2
  }, triggerBefore.y)
  await page.evaluate(() => window.scrollTo(0, 1400))
  await page.locator('.stt-card').waitFor({ state: 'detached' })

  await page.evaluate(() => window.scrollTo(0, 0))
  await worker.evaluate(async () => { await chrome.storage.sync.set({ reading_mode: 'guide' }) })
  shouldDelayGuide = true
  await selectText('Sometimes', '#passage')
  await page.locator('.stt-trigger').click()
  await page.locator('.stt-loading').waitFor()
  await page.getByRole('button', { name: 'Close reading card' }).click()
  await page.waitForTimeout(250)
  assert.equal(await page.locator('.stt-card').count(), 0)
  shouldDelayGuide = false
  const second = await context.newPage()
  second.on('pageerror', (error) => errors.push(error.message))
  await second.goto(origin)
  await selectText('reluctant', '#sentence', 0, second)
  await second.locator('.stt-trigger').click()
  await second.locator('.stt-hint').first().waitFor()
  await selectText('reluctant')
  await page.locator('.stt-trigger').click()
  await page.locator('.stt-hint').first().waitFor()
  const callsBeforeModeSwitch = requests.length
  await page.getByRole('button', { name: '翻译', exact: true }).click()
  await page.locator('.stt-card-block--translation').waitFor()
  assert.equal(await second.getByRole('button', { name: '引导理解', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(requests.length, callsBeforeModeSwitch + 1)
  await second.close()
  await selectText('record', '#repeated', 1)
  await page.locator('.stt-trigger').click()
  await page.locator('.stt-card-block--translation').waitFor()
  await page.locator('.stt-phonetic').waitFor()
  await page.getByRole('button', { name: '引导理解', exact: true }).click()
  await page.locator('.stt-hint').first().waitFor()
  const occurrenceData = JSON.parse(requests.at(-1).messages[1].content)
  assert.equal(occurrenceData.contextStart, 27)
  assert.equal(occurrenceData.selectedOccurrence.before, 'The band will record a new ')
  assert.equal(await page.locator('.stt-save').count(), 0)
  await page.locator('.stt-reveal').click()
  await page.locator('.stt-save').click()
  await page.getByRole('button', { name: '✓ 已收藏', exact: true }).waitFor()
  const savedVocabulary = await worker.evaluate(async () => (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries)
  assert.equal(savedVocabulary.length, 1)
  assert.equal(savedVocabulary[0].text, 'record')
  assert.equal(savedVocabulary[0].sourceUrl, `${origin}/`)
  const library = await context.newPage()
  library.on('pageerror', (error) => errors.push(error.message))
  await library.goto(`chrome-extension://${extensionId}/src/library.html`)
  await library.locator('.entry-card').waitFor()
  await library.locator('.entry-card summary').click()
  await library.screenshot({ path: join(artifactPath, 'library.png'), fullPage: true })
  await library.locator('#review-tab').click()
  assert.equal(await library.locator('.review-reveal').count(), 0)
  await worker.evaluate(async () => {
    const saved = (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries
    saved[0].dueAt = Date.now() - 1000
    await chrome.storage.local.set({ vocabulary_entries: saved })
  })
  await library.locator('#all-tab').click()
  await library.locator('#review-tab').click()
  await library.locator('.review-reveal').waitFor()
  assert.equal(await library.locator('.review-answer').count(), 0)
  await library.locator('.review-reveal').click()
  await library.screenshot({ path: join(artifactPath, 'review.png'), fullPage: true })
  await library.getByRole('button', { name: '记住了', exact: false }).click()
  await library.waitForFunction(() => document.getElementById('review-card').textContent.includes('完成'))
  const reviewed = await worker.evaluate(async () => (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries[0])
  assert.equal(reviewed.reviewCount, 1)
  assert.ok(reviewed.dueAt > Date.now())
  const downloadPromise = library.waitForEvent('download')
  await library.locator('#export-vocabulary').click()
  const download = await downloadPromise
  const { readFile } = await import('node:fs/promises')
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.equal(exported.entries.length, 1)
  await library.locator('#all-tab').click()
  await library.locator('.entry-card summary').click()
  await library.getByRole('button', { name: '移除 record', exact: true }).click()
  await library.waitForFunction(() => document.getElementById('all-count').textContent === '0')
  await library.locator('#import-vocabulary-file').setInputFiles({
    name: 'selected-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  })
  await library.waitForFunction(() => document.getElementById('all-count').textContent === '1')
  const restored = await worker.evaluate(async () => (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries[0])
  assert.equal(restored.reviewCount, 1)
  assert.equal('api_key' in exported, false)
  await library.setViewportSize({ width: 420, height: 850 })
  assert.equal(await library.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const settings = await context.newPage()
  settings.on('pageerror', (error) => errors.push(error.message))
  await settings.goto(`chrome-extension://${extensionId}/src/options.html`)
  await settings.locator('#learning_model').waitFor()
  await settings.waitForFunction(() => document.getElementById('learning_model').value === 'test-tutor')
  await settings.locator('#discover-models').click()
  await settings.waitForFunction(() => document.getElementById('connection-status').textContent.includes('连接成功'))
  assert.equal(await settings.locator('#provider-models option').count(), 2)
  assert.equal(await settings.locator('#learning-models option').count(), 1)
  await settings.locator('#speech_voice').selectOption('Test English')
  await settings.locator('#preview-speech').click()
  await settings.waitForFunction(() => document.getElementById('speech-status').textContent.includes('正在播放'))
  await settings.locator('#reading_mode').selectOption('guide')
  await settings.getByRole('button', { name: '保存设置', exact: true }).click()
  await settings.waitForFunction(() => document.getElementById('status').textContent.includes('saved'))
  assert.equal(await worker.evaluate(async () => (await chrome.storage.sync.get('speech_voice')).speech_voice), 'Test English')
  await settings.screenshot({ path: join(artifactPath, 'settings.png'), fullPage: true })
  await settings.setViewportSize({ width: 420, height: 900 })
  assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const popup = await context.newPage()
  await popup.setViewportSize({ width: 380, height: 800 })
  popup.on('pageerror', (error) => errors.push(error.message))
  await popup.goto(`chrome-extension://${extensionId}/src/popup.html`)
  await page.bringToFront()
  await popup.reload()
  await popup.waitForFunction(() => document.getElementById('model').value === 'qwen-mt-flash')
  await popup.waitForFunction(() => document.getElementById('current-url').textContent.startsWith('http://'))
  await popup.screenshot({ path: join(artifactPath, 'popup.png'), fullPage: true })
  await popup.locator('#disable-current').click()
  await popup.waitForFunction(() => document.getElementById('page-status').classList.contains('disabled'))
  await page.locator('.stt-trigger').waitFor({ state: 'detached' })
  await popup.locator('#enable-current').click()
  await popup.waitForFunction(() => document.getElementById('page-status').classList.contains('enabled'))
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  assert.deepEqual(errors, [])
  console.log(`Browser checks passed: guide progression, hidden answers, context, caching, phonetics, speech dispatch, keyboard, scrolling, settings, responsive layout, resizing, failure recovery, cancellation, URL rules, selection offsets, cross-tab isolation, vocabulary save/review/export/import, and model discovery.\nPreviews: ${artifactPath}`)
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(profilePath, { recursive: true, force: true })
}
