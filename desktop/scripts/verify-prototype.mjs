import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { createMockApi } from './e2e/mock-api.mjs'

const require = createRequire(import.meta.url)
const desktopDir = fileURLToPath(new URL('../', import.meta.url))
const entry = join(desktopDir, 'prototype', 'main.js')
const shortcut = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
const shouldUseSystemClipboard = process.env.STT_PROTOTYPE_REAL_CLIPBOARD === '1'
const mockKey = 'local-mock-key'

const originals = {
  first: 'The museum opens at ten.\nOn rainy days, the courtyard stays closed.',
  edited: 'The edited source.',
  retry: 'This request needs a retry.',
  stale: 'An older pending request.',
  latest: 'Only this translation should stay.',
  reopened: 'A translation after relaunch.',
  generic: 'A translation through a general-purpose model.',
}

function translationFor(text) {
  return text === originals.first ? '博物馆十点开放。\n下雨时，庭院不对外开放。' : `译:${text}`
}

function launchPrototype(profile) {
  return electron.launch({
    executablePath: process.env.STT_ELECTRON_EXECUTABLE || require('electron'),
    args: process.platform === 'linux' ? [entry, '--no-sandbox'] : [entry],
    env: { ...process.env, STT_PROTOTYPE_USER_DATA: profile },
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

const profile = mkdtempSync(join(tmpdir(), 'stt-prototype-e2e-'))
const mock = createMockApi({ translationFor })
let app

try {
  const url = await mock.listen()
  app = await launchPrototype(profile)
  const page = await app.firstWindow()
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile)
  const browserWindow = await app.browserWindow(page)
  page.setDefaultTimeout(6000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const sourceEl = page.locator('#source-text')
  const settingsEl = page.locator('#settings-dialog')

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
  const syncFile = join(profile, 'sync.json')
  const savedSettings = existsSync(syncFile) ? readFileSync(syncFile, 'utf8') : ''
  assert.ok(!savedSettings.includes(mockKey), 'the API key must not be persisted as plaintext')
  if (!savedSettings) {
    assert.match(await page.locator('#status').textContent(), /仅在本次运行中有效/u)
  }
  console.log('[prototype] opens with focus in the editor and saves model settings')

  await sourceEl.fill('')
  await sourceEl.focus()
  if (shouldUseSystemClipboard) {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originals.first)
    await browserWindow.evaluate((window) => window.webContents.paste())
  } else {
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = (text) => { globalThis.prototypeTestClipboard = text }
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
  if (process.env.STT_PROTOTYPE_SCREENSHOT) await page.screenshot({ path: process.env.STT_PROTOTYPE_SCREENSHOT })
  await page.locator('#copy-button').click()
  await waitFor(async () => await app.evaluate(({ clipboard }, real) => {
    return real ? clipboard.readText() : globalThis.prototypeTestClipboard
  }, shouldUseSystemClipboard) === translationFor(originals.first), 'copy should pass the translation to the clipboard')
  console.log('[prototype] manual submit, streamed translation, source preservation, and copy')

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
  console.log('[prototype] edits are manual and a failed request can be retried in place')

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
  console.log('[prototype] the latest submission wins when an earlier response comes back late')

  await browserWindow.evaluate((window) => window.setContentSize(520, 700))
  await page.waitForFunction(() => {
    const source = document.getElementById('source-text').getBoundingClientRect()
    const target = document.getElementById('target-text').getBoundingClientRect()
    return target.top >= source.bottom && document.documentElement.scrollWidth <= window.innerWidth
  })
  assert.deepEqual(pageErrors, [])
  console.log('[prototype] source and translation stack in a narrow window')

  if (savedSettings) {
    await app.close()
    app = undefined
    app = await launchPrototype(profile)
    const reopenedPage = await app.firstWindow()
    reopenedPage.setDefaultTimeout(6000)
    const reopenedSourceEl = reopenedPage.locator('#source-text')
    assert.equal(await reopenedSourceEl.inputValue(), '')
    await reopenedSourceEl.fill(originals.reopened)
    await reopenedSourceEl.press(shortcut)
    await waitForResult(reopenedPage, originals.reopened)
    assert.equal(mock.requests.at(-1).model, 'qwen-mt-flash')
    console.log('[prototype] model settings survive relaunch, while source text is cleared')
  } else {
    console.log('[prototype] settings were session-only, so encrypted restart was skipped')
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
  console.log('[prototype] a general-purpose model works with the previously saved key')
} finally {
  try {
    await app?.close()
  } finally {
    await mock.close()
    rmSync(profile, { recursive: true, force: true })
  }
}
