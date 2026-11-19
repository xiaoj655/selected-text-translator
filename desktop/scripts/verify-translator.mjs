import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { createMockApi } from './e2e/mock-api.mjs'

const require = createRequire(import.meta.url)
const desktopDir = fileURLToPath(new URL('../', import.meta.url))
const shortcut = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
const shouldUseSystemClipboard = process.env.STT_DESKTOP_REAL_CLIPBOARD === '1'
const mockKey = 'local-mock-key'

const originals = {
  first: 'The museum opens at ten.\nOn rainy days, the courtyard stays closed.',
  edited: 'The edited source.',
  retry: 'This request needs a retry.',
  stale: 'An older pending request.',
  latest: 'Only this translation should stay.',
  stopped: 'A translation that can be stopped.',
  reopened: 'A translation after relaunch.',
  generic: 'A translation through a general-purpose model.',
}

function translationFor(text) {
  return text === originals.first ? '博物馆十点开放。\n下雨时，庭院不对外开放。' : `译:${text}`
}

function launchTranslator(profile) {
  return electron.launch({
    executablePath: process.env.STT_ELECTRON_EXECUTABLE || require('electron'),
    args: process.platform === 'linux' ? [desktopDir, '--no-sandbox'] : [desktopDir],
    env: { ...process.env, STT_DESKTOP_TEST_PROFILE: profile },
    timeout: 30000,
  })
}

function waitForResult(page, text) {
  return page.waitForFunction((expected) => {
    const result = document.getElementById('target-text')
    return (result.value ?? result.textContent).trim() === expected
      && !document.getElementById('copy-button').disabled
  }, translationFor(text))
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return
    await delay(25)
  }
  assert.fail(message)
}

function respondWithJson(mock, content) {
  mock.setHandler(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
  })
}

const teacherModel = 'english-tutor-model'
const lookup = 'fallback'
const lesson = {
  passage: 'The service will use its fallback endpoint if the main server does not answer.',
  question: 'When does the service use the fallback endpoint?',
  hints: ['use its fallback endpoint', '如果主服务器一直不响应，会发生什么？'],
  referenceAnswer: 'It uses the fallback endpoint when the main server does not respond.',
}
const feedback = {
  verdict: 'partial',
  feedback: '你找到了备用地址。再补充主服务器不响应这个条件。',
  focus: '条件关系',
}
const guideSource = 'The courtyard will stay closed unless the weather improves.'
const guide = {
  guideType: 'sentence',
  hints: ['First find what stays closed.', 'Look for the one condition that changes it.'],
  answer: {
    meaning: 'The courtyard stays closed when the weather does not get better.',
    explanation: 'The word “unless” introduces the exception.',
  },
}

async function verifyPractice(page, mock) {
  respondWithJson(mock, lesson)
  const requestCount = mock.requests.length
  assert.equal(await page.locator('#translation-page').isVisible(), false)
  await page.locator('#practice-start').click()
  await page.getByText(lesson.question, { exact: true }).waitFor()
  assert.equal(await page.locator('#practice-passage').textContent(), lesson.passage)
  assert.equal(mock.requests.length, requestCount + 1)
  assert.equal(mock.requests.at(-1).model, teacherModel)
  const { lookups, previous } = JSON.parse(mock.requests.at(-1).text)
  assert.deepEqual(lookups.find(({ text }) => text === lookup), { text: lookup, count: 1 })
  assert.ok(!lookups.some(({ text }) => [originals.first, originals.generic].includes(text)),
    'practice should not include full translation inputs')
  assert.equal(previous, null)

  const hintsEl = page.locator('#practice-hints')
  assert.equal(await hintsEl.isVisible(), false)
  await page.locator('#practice-hint').click()
  await hintsEl.getByText(`在原文找到 “${lesson.hints[0]}”，再看它前后的内容。`, { exact: true }).waitFor()
  assert.equal(await hintsEl.getByText(lesson.hints[1], { exact: true }).count(), 0)
  assert.equal(mock.requests.length, requestCount + 1, 'showing a hint is local')

  respondWithJson(mock, feedback)
  const answer = 'It uses its fallback endpoint.'
  await page.locator('#practice-answer').fill(answer)
  await page.locator('#practice-submit').click()
  await page.getByText(feedback.feedback, { exact: true }).waitFor()
  assert.match(await page.locator('#practice-focus').textContent(), /条件关系/u)
  assert.equal(mock.requests.length, requestCount + 2)
  assert.equal(mock.requests.at(-1).model, teacherModel)
  assert.deepEqual(JSON.parse(mock.requests.at(-1).text), {
    passage: lesson.passage, question: lesson.question, referenceAnswer: lesson.referenceAnswer, answer, hintsUsed: 1,
  })

  await page.locator('#translation-mode').click()
  assert.equal(await page.locator('#source-text').inputValue(), lookup)
  await waitForResult(page, lookup)
  await page.locator('#teacher-mode').click()
  assert.equal(await page.locator('#practice-feedback').isVisible(), true)
  assert.equal(mock.requests.length, requestCount + 2, 'returning to teacher mode should keep the lesson')

  const nextLesson = { ...lesson, question: 'What has to happen before the main service can finish?' }
  respondWithJson(mock, nextLesson)
  await page.locator('#practice-next').click()
  await page.getByText(nextLesson.question, { exact: true }).waitFor()
  assert.equal(mock.requests.length, requestCount + 3)
  assert.deepEqual(JSON.parse(mock.requests.at(-1).text).previous, {
    verdict: feedback.verdict, focus: feedback.focus, hintsUsed: 1,
  })
  return answer
}

async function verifyGuide(page, mock) {
  await page.locator('#guide-tab').click()
  respondWithJson(mock, guide)
  await page.locator('#guide-text').fill(guideSource)
  await page.locator('#guide-start').click()
  const hintsEl = page.locator('#guide-hints')
  await hintsEl.getByText(guide.hints[0], { exact: true }).waitFor()
  assert.equal(mock.requests.at(-1).model, teacherModel)
  assert.equal(JSON.parse(mock.requests.at(-1).text).selectedText, guideSource)
  assert.equal(await hintsEl.getByText(guide.hints[1], { exact: true }).count(), 0)
  assert.equal(await page.locator('#guide-answer').isVisible(), false)
  const requestCount = mock.requests.length
  await page.locator('#guide-more').click()
  await hintsEl.getByText(guide.hints[1], { exact: true }).waitFor()
  await page.locator('#guide-reveal').click()
  await page.getByText(guide.answer.meaning, { exact: true }).waitFor()
  assert.equal(await page.locator('#guide-explanation').textContent(), guide.answer.explanation)
  assert.equal(mock.requests.length, requestCount, 'revealing hints and the explanation is local')
}

const profile = mkdtempSync(join(tmpdir(), 'stt-translator-e2e-'))
const syncFile = join(profile, 'sync.json')
const previousSettings = { desktop_hotkey: 'Alt+Shift+E' }
const previousFiles = {
  'history.json': JSON.stringify([{ id: 'old-translation', text: 'Existing history' }]),
  'local.json': JSON.stringify({ vocabulary_entries: [{ id: 'old-entry', text: 'Existing vocabulary' }] }),
}
writeFileSync(syncFile, JSON.stringify(previousSettings))
for (const [name, contents] of Object.entries(previousFiles)) writeFileSync(join(profile, name), contents)
const mock = createMockApi({ translationFor })
let app

try {
  const url = await mock.listen()
  app = await launchTranslator(profile)
  const page = await app.firstWindow()
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile)
  const browserWindow = await app.browserWindow(page)
  page.setDefaultTimeout(6000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const sourceEl = page.locator('#source-text')
  const settingsEl = page.locator('#settings-dialog')
  const targetEl = page.locator('#target-text')
  const statusEl = page.locator('#status')
  const translateEl = page.locator('#translate-button')
  const copyEl = page.locator('#copy-button')

  await page.waitForFunction(() => document.activeElement?.id === 'source-text')
  await sourceEl.fill(originals.first)
  await sourceEl.press(shortcut)
  await page.locator('#configure-button').waitFor({ state: 'visible' })
  assert.equal(await sourceEl.inputValue(), originals.first)
  assert.equal(mock.requests.length, 0)
  await page.locator('#settings-button').click()
  await settingsEl.waitFor({ state: 'visible' })
  await page.locator('#base-url').fill(url)
  await page.locator('#api-key').fill(mockKey)
  await page.locator('#model').fill('qwen-mt-flash')
  await page.locator('#save-settings').click()
  await settingsEl.waitFor({ state: 'hidden' })
  const savedSettings = readFileSync(syncFile, 'utf8')
  const hasPersistedKey = Boolean(JSON.parse(savedSettings).api_key)
  assert.equal(JSON.parse(savedSettings).desktop_hotkey, previousSettings.desktop_hotkey)
  assert.ok(!savedSettings.includes(mockKey), 'the API key must not be persisted as plaintext')
  if (!hasPersistedKey) {
    assert.match(await page.locator('#status').textContent(), /仅在本次运行中有效/u)
  }
  console.log('[desktop] opens with focus in the editor and saves model settings')

  await sourceEl.fill('')
  await sourceEl.focus()
  if (shouldUseSystemClipboard) {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originals.first)
    await browserWindow.evaluate((window) => window.webContents.paste())
  } else {
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = (text) => { globalThis.translatorTestClipboard = text }
    })
    await sourceEl.evaluate((el, text) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', text)
      const shouldPaste = el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
      if (shouldPaste) document.execCommand('insertText', false, text)
    }, originals.first)
  }
  await page.waitForFunction((text) => document.getElementById('source-text').value === text, originals.first)
  await delay(650)
  assert.equal(mock.requests.length, 0, 'pasting should not send the source')
  await sourceEl.press(shortcut)
  await waitForResult(page, originals.first)
  assert.equal(await sourceEl.inputValue(), originals.first)
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].text, originals.first)
  assert.equal(mock.requests[0].stream, true)
  if (process.env.STT_DESKTOP_SCREENSHOT) await page.screenshot({ path: process.env.STT_DESKTOP_SCREENSHOT })
  await page.locator('#copy-button').click()
  await waitFor(async () => await app.evaluate(({ clipboard }, real) => {
    return real ? clipboard.readText() : globalThis.translatorTestClipboard
  }, shouldUseSystemClipboard) === translationFor(originals.first), 'copy should pass the translation to the clipboard')
  console.log('[desktop] manual submit, streamed translation, source preservation, and copy')

  let targetLanguage
  let sourceLanguage
  mock.setHandler(async (request) => {
    sourceLanguage = request.body.translation_options?.source_lang
    targetLanguage = request.body.translation_options?.target_lang
    await request.defaultResponse(request)
  })
  await page.locator('#source-language').selectOption('English')
  await page.locator('#target-language').selectOption('Chinese')
  await sourceEl.fill(originals.edited)
  await delay(650)
  assert.equal(mock.requests.length, 1, 'editing should not send the source')
  await page.locator('#translate-button').click()
  await waitForResult(page, originals.edited)
  assert.equal(mock.requests.length, 2)
  assert.equal(sourceLanguage, 'English')
  assert.equal(targetLanguage, 'Chinese')

  mock.setHandler(({ res }) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await sourceEl.fill(originals.retry)
  await sourceEl.press(shortcut)
  await page.locator('#retry-button').waitFor({ state: 'visible' })
  assert.match(await page.locator('#status').textContent(), /401|密钥|授权/u)
  assert.equal(await sourceEl.inputValue(), originals.retry)
  mock.resetHandler()
  await page.locator('#retry-button').click()
  await waitForResult(page, originals.retry)
  assert.equal(mock.requests.length, 4)
  console.log('[desktop] edits are manual and a failed request can be retried in place')

  let resolveOlderRequest
  const olderRequestFinished = new Promise((resolve) => { resolveOlderRequest = resolve })
  let respondToOlderRequest
  const olderRequestGate = new Promise((resolve) => { respondToOlderRequest = resolve })
  let didReceiveOlderRequest = false
  mock.setHandler(async (request) => {
    if (request.body.messages.at(-1).content === originals.stale) {
      didReceiveOlderRequest = true
      await olderRequestGate
      try {
        await request.defaultResponse(request)
      } finally {
        resolveOlderRequest()
      }
      return
    }
    await request.defaultResponse(request)
  })
  try {
    await sourceEl.fill(originals.stale)
    await sourceEl.press(shortcut)
    await waitFor(() => didReceiveOlderRequest, 'the older request should have reached the server')
    await sourceEl.fill(originals.latest)
    await sourceEl.press(shortcut)
    await waitForResult(page, originals.latest)
    assert.equal(mock.requests.length, 6)
  } finally {
    respondToOlderRequest()
  }
  await olderRequestFinished
  await waitForResult(page, originals.latest)
  assert.equal(await sourceEl.inputValue(), originals.latest)
  console.log('[desktop] the latest submission wins when an earlier response comes back late')

  const stopEl = page.locator('#stop-button')
  const partialTranslation = '还没翻完'
  const partialChunk = JSON.stringify({ choices: [{ delta: { content: partialTranslation } }] })
  for (const stop of [() => stopEl.click(), () => sourceEl.press('Escape')]) {
    let response
    let isStreamClosed = false
    mock.setHandler(({ res }) => {
      response = res
      res.once('close', () => { isStreamClosed = true })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${partialChunk}\n\n`)
    })
    await sourceEl.fill(originals.stopped)
    await sourceEl.press(shortcut)
    await stopEl.waitFor({ state: 'visible' })
    await page.getByText(partialTranslation, { exact: true }).waitFor()
    await stop()
    await stopEl.waitFor({ state: 'hidden' })
    await waitFor(() => isStreamClosed, 'stopping should close the stream')
    response.end(`data: ${partialChunk}\n\ndata: [DONE]\n\n`)
    assert.equal(await statusEl.textContent(), '已停止翻译')
    assert.equal(await sourceEl.inputValue(), originals.stopped)
    assert.equal(await targetEl.textContent(), '')
    assert.ok(await copyEl.isDisabled())
    assert.ok(await translateEl.isEnabled())
  }
  mock.resetHandler()
  await sourceEl.press(shortcut)
  await waitForResult(page, originals.stopped)
  assert.equal(mock.requests.length, 9)
  console.log('[desktop] stop button and Escape cancel a visible stream and allow resubmission')

  await page.locator('#clear-button').click()
  assert.equal(await sourceEl.inputValue(), '')
  assert.equal(await targetEl.textContent(), '')
  assert.ok(await copyEl.isDisabled())
  await page.waitForFunction(() => document.activeElement?.id === 'source-text')
  assert.equal(mock.requests.length, 9)

  const countEl = page.locator('#source-count')
  await sourceEl.fill('a'.repeat(12001))
  assert.match(await countEl.textContent(), /\b12,?001\b/u)
  assert.equal(await countEl.getAttribute('data-kind'), 'error')
  assert.ok(await translateEl.isDisabled())
  await sourceEl.press(shortcut)
  await sourceEl.fill('  Hi  \n')
  assert.match(await countEl.textContent(), /\b2\b/u)
  assert.notEqual(await countEl.getAttribute('data-kind'), 'error')
  await translateEl.click()
  await waitForResult(page, 'Hi')
  assert.equal(mock.requests.length, 10)
  assert.equal(mock.requests.at(-1).text, 'Hi')
  console.log('[desktop] clearing restores focus and over-limit input cannot be sent')

  await browserWindow.evaluate((window) => window.setContentSize(520, 700))
  await page.waitForFunction(() => {
    const source = document.getElementById('source-text').getBoundingClientRect()
    const target = document.getElementById('target-text').getBoundingClientRect()
    return target.top >= source.bottom && document.documentElement.scrollWidth <= window.innerWidth
  })
  assert.deepEqual(pageErrors, [])
  console.log('[desktop] source and translation stack in a narrow window')

  if (hasPersistedKey) {
    await app.close()
    app = undefined
    app = await launchTranslator(profile)
    const reopenedPage = await app.firstWindow()
    reopenedPage.setDefaultTimeout(6000)
    const reopenedSourceEl = reopenedPage.locator('#source-text')
    assert.equal(await reopenedSourceEl.inputValue(), '')
    await reopenedSourceEl.fill(originals.reopened)
    await reopenedSourceEl.press(shortcut)
    await waitForResult(reopenedPage, originals.reopened)
    assert.equal(mock.requests.at(-1).model, 'qwen-mt-flash')
    console.log('[desktop] model settings survive relaunch, while source text is cleared')
  } else {
    console.log('[desktop] settings were session-only, so encrypted restart was skipped')
  }

  const genericPage = await app.firstWindow()
  await genericPage.locator('#settings-button').click()
  await genericPage.locator('#model').fill('generic-model')
  assert.equal(await genericPage.locator('#api-key').inputValue(), '')
  await genericPage.locator('#save-settings').click()
  await genericPage.locator('#settings-dialog').waitFor({ state: 'hidden' })
  await genericPage.locator('#source-text').fill(originals.generic)
  await genericPage.locator('#source-text').press(shortcut)
  await waitForResult(genericPage, originals.generic)
  assert.equal(mock.requests.at(-1).model, 'generic-model')
  assert.equal(mock.requests.at(-1).stream, false)
  console.log('[desktop] a general-purpose model works with the previously saved key')

  await genericPage.locator('#settings-button').click()
  await genericPage.locator('#model').fill('qwen-mt-flash')
  await genericPage.locator('#save-settings').click()
  await genericPage.locator('#settings-dialog').waitFor({ state: 'hidden' })
  const teacherSetupRequestCount = mock.requests.length
  await genericPage.locator('#teacher-mode').click()
  await genericPage.locator('#practice-start').click()
  await genericPage.locator('#practice-configure').click()
  assert.equal(mock.requests.length, teacherSetupRequestCount, 'the teacher needs a general-purpose model')
  await genericPage.locator('#learning-model').fill(teacherModel)
  await genericPage.locator('#save-settings').click()
  await genericPage.locator('#settings-dialog').waitFor({ state: 'hidden' })
  await genericPage.locator('#translation-mode').click()
  await genericPage.locator('#source-language').selectOption('English')
  await genericPage.locator('#source-text').fill(lookup)
  await genericPage.locator('#source-text').press(shortcut)
  await waitForResult(genericPage, lookup)
  assert.equal(mock.requests.at(-1).model, 'qwen-mt-flash', 'word lookups still use the translation model')
  assert.equal(mock.requests.at(-1).text, lookup)
  const lookupRequestCount = mock.requests.length
  await genericPage.locator('#teacher-mode').click()
  await genericPage.locator('#practice-terms').getByText(lookup).waitFor()
  assert.equal(mock.requests.length, lookupRequestCount, 'opening the teacher mode is local')

  const answer = await verifyPractice(genericPage, mock)
  await verifyGuide(genericPage, mock)
  console.log('[desktop] separate teacher mode uses lookup signals, grades a reply, and adapts the next lesson')
  console.log('[desktop] guided reading reveals hints and explanations progressively')

  const teacherFile = join(profile, 'teacher.json')
  const teacherData = readFileSync(teacherFile, 'utf8')
  assert.equal(JSON.parse(teacherData).practiceCount, 1)
  assert.ok(!teacherData.includes(answer))
  assert.ok(!teacherData.includes(guideSource))
  await genericPage.locator('#teacher-clear').click()
  await genericPage.locator('#teacher-clear-dialog').waitFor({ state: 'visible' })
  await genericPage.locator('#teacher-clear-confirm').click()
  await genericPage.locator('#teacher-clear-dialog').waitFor({ state: 'hidden' })
  assert.equal(existsSync(teacherFile), false, 'clearing teacher data removes the persisted learning records')
  for (const [name, contents] of Object.entries(previousFiles)) {
    assert.equal(readFileSync(join(profile, name), 'utf8'), contents)
  }
  console.log('[desktop] existing history and vocabulary files survive the upgrade')
} finally {
  try {
    await app?.close()
  } finally {
    await mock.close()
    rmSync(profile, { recursive: true, force: true })
  }
}
