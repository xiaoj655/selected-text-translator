import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { ensureDisplay } from './e2e/runner.mjs'
import { clickWord } from './e2e/reading-lookup.mjs'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactDir = join(desktopDir, 'artifacts', 'e2e')
const reportDir = join(artifactDir, 'report')
const screenshotDir = join(artifactDir, 'screenshots')
const first = 'The changes that the team proposed could reduce costs.'
const second = 'The editor will record the interview tomorrow.'
const third = 'A careful review prevents mistakes.'
const text = `${first}\n\n${second}\n\n${third}\n\n${Array.from({ length: 35 }, (_, index) =>
  `Observation ${index + 1} explains how the engineering team checks its measurements. The researchers compare the evidence before continuing with the next experiment.`).join('\n\n')}`
let config
try {
  config = process.env.STT_LIVE_CONFIG
    ? JSON.parse(readFileSync(process.env.STT_LIVE_CONFIG, 'utf8'))
    : { apiKey: process.env.STT_API_KEY, baseUrl: process.env.STT_BASE_URL }
} catch {
  throw new Error('Could not read the external live-test configuration.')
}
assert.ok(config.apiKey && config.baseUrl, 'Set STT_LIVE_CONFIG or STT_API_KEY/STT_BASE_URL for this live test.')
const model = process.env.STT_TRANSLATION_MODEL || 'qwen-mt-flash'
const learningModel = process.env.STT_LEARNING_MODEL || 'qwen3.8-flash'
const articleUrl = process.env.STT_LIVE_ARTICLE_URL || 'https://paulgraham.com/think.html'
const scrub = (error) => String(error?.message || error)
  .split(String(config.apiKey)).join('[redacted]')
  .split(String(config.iqsApiKey || '__no_iqs_key__')).join('[redacted]')
  .replace(/sk-[A-Za-z0-9._-]+/gu, '[redacted]')

ensureDisplay()
mkdirSync(reportDir, { recursive: true })
mkdirSync(screenshotDir, { recursive: true })
const userDataDir = mkdtempSync(join(tmpdir(), 'stt-live-reading-'))
const results = []
const recoveryOnly = process.argv.includes('--recovery')
let app
let page
let savedWidth
let savedPosition
let pastedHistoryId
let importedHistoryId

async function check(name, run) {
  if (recoveryOnly && !/history stores|restart restores/u.test(name)) return
  const started = Date.now()
  try {
    const detail = await run()
    results.push({ name, ok: true, elapsedMs: Date.now() - started, ...detail })
    console.log(`[e2e:live-reading] ok ${name}: ${JSON.stringify(detail || {})}`)
  } catch (error) {
    const message = scrub(error)
    results.push({ name, ok: false, elapsedMs: Date.now() - started, error: message })
    console.error(`[e2e:live-reading] FAIL ${name}: ${message}`)
  }
}

async function launch() {
  app = await electron.launch({
    executablePath: electronBinary,
    args: [desktopDir, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
    env: { ...process.env, STT_E2E: '1' }, timeout: 60000,
  })
  for (let attempt = 0; attempt < 150; attempt++) {
    page = app.windows().find((window) => window.url().includes('index.html'))
    if (page) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(page, 'Main Electron window should open.')
  page.setDefaultTimeout(60000)
  await page.locator('#installed-version').waitFor({ state: 'attached' })
}

async function openCoach() {
  if (await page.locator('#settings-panel').isVisible()) await page.locator('#btn-close-settings').click()
  await page.locator('#btn-tutor-workspace').click()
  await page.locator('#tutor-reading-mode').click()
}

async function backToIndex() {
  if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
  if (await page.locator('#reading-back').isVisible()) await page.locator('#reading-back').click()
}

async function selectText(selected) {
  if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
  await page.evaluate(async (selected) => {
    const material = document.querySelector('#reading-detail .reading-preview')
    const start = material.textContent.indexOf(selected)
    if (start < 0) throw new Error('The live fixture is missing its selection.')
    const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let offset = 0
    let started = false
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = offset + node.length
      if (!started && start < next) { range.setStart(node, start - offset); started = true }
      if (started && start + selected.length <= next) { range.setEnd(node, start + selected.length - offset); break }
      offset = next
    }
    const scroller = document.getElementById('tutor-workspace')
    scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const native = window.getSelection()
    native.removeAllRanges()
    native.addRange(range)
    const bounds = range.getClientRects()[0]
    material.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0,
      clientX: bounds.left + 1, clientY: bounds.top + 1 }))
  }, selected)
  await page.locator('#reading-lookup').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#reading-lookup-text').textContent(), selected)
}

async function waitForAnalysis() {
  await page.waitForFunction(() => ['done', 'error', 'unavailable'].includes(
    document.getElementById('reading-sentence-structure')?.dataset.status))
  assert.equal(await page.locator('#reading-sentence-structure').getAttribute('data-status'), 'done',
    await page.locator('#reading-sentence-structure').textContent())
  const paraphrase = await page.locator('.reading-sentence-paraphrase').textContent()
  assert.ok(paraphrase.trim(), 'The article should show its full-sentence meaning.')
  return paraphrase.trim()
}

async function roles() {
  const details = page.locator('#reading-sentence-toggle')
  if (await details.getAttribute('open') === null) await details.locator('summary').click()
  await page.locator('.reading-sentence-source').first().waitFor()
  if (await details.locator('.reading-sentence-source .sentence-mark').count()) {
    await page.waitForFunction(() => ['subject', 'verb', 'object', 'complement'].some((role) =>
      CSS.highlights.has(`reading-lookup-${role}`)))
  }
  return page.evaluate(() => Object.fromEntries(['subject', 'verb', 'object', 'complement'].map((role) => [
    role, [...(CSS.highlights.get(`reading-lookup-${role}`) || [])].map((range) => range.toString()),
  ])))
}

async function screenshot(name) {
  assert.equal(await page.locator('#settings-panel').isVisible(), false, 'Keep credentials out of screenshots.')
  await page.screenshot({ path: join(screenshotDir, `live-reading-${name}.png`) })
}

try {
  await launch()
  await page.evaluate((settings) => chrome.storage.sync.set(settings), {
    base_url: config.baseUrl.replace(/\/+$/u, ''), api_key: config.apiKey,
    model, learning_model: learningModel, reading_mode: 'translate',
    desktop_iqs_api_key: config.iqsApiKey || '', desktop_reading_lookup_mode: 'translate',
    desktop_live_translate: false, desktop_source_language: 'english', desktop_target_language: 'Chinese',
  })
  await page.reload()
  await page.locator('#installed-version').waitFor({ state: 'attached' })
  await page.evaluate(() => {
    window.__readingLiveRequests = []
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === 'START_TRANSLATION') window.__readingLiveRequests.push({
        kind: message.payload?.kind, text: message.payload?.text,
      })
      return send(message, ...args)
    }
  })
  await openCoach()
  if (recoveryOnly) {
    savedWidth = 486
    await page.evaluate((width) => chrome.storage.local.set({ desktop_reading_lookup_width: width }), savedWidth)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html')).setContentSize(1280, 800)
    })
    await page.locator('#reading-paste').click()
    await page.locator('#reading-paste-text').fill(text)
    await page.locator('#reading-paste-open').click()
    await page.locator('#reading-detail .reading-preview').waitFor()
  }

  await check('real webpage import and history snapshot', async () => {
    await backToIndex()
    await page.locator('#reading-import').click()
    await page.locator('#reading-import-url').fill(articleUrl)
    await page.locator('form.reading-paste-form button[type="submit"]').click()
    await page.waitForFunction(() => Boolean(document.getElementById('reading-detail'))
      || (!document.querySelector('form.reading-paste-form button[type="submit"]')?.disabled
        && Boolean(document.getElementById('reading-import-status')?.textContent)))
    assert.equal(await page.locator('#reading-detail').isVisible(), true,
      await page.evaluate(() => document.getElementById('reading-import-status')?.textContent || 'Article import did not open.'))
    const title = await page.locator('#reading-detail > h3').textContent()
    const length = (await page.locator('#reading-detail .reading-preview').textContent()).length
    assert.ok(length > 1000, 'A real article should retain its full body.')
    await backToIndex()
    await page.locator('#reading-history').click()
    const saved = page.locator('.reading-history-open').filter({ hasText: title }).first()
    await saved.waitFor()
    importedHistoryId = await saved.getAttribute('data-history-id')
    return { title, bodyLength: length, importMethod: config.iqsApiKey ? 'iqs' : 'direct' }
  })

  await check('real imported passage exposes main and subordinate clauses', async () => {
    assert.ok(importedHistoryId, 'The imported article should be available in history.')
    await page.locator(`.reading-history-open[data-history-id="${importedHistoryId}"]`).click()
    await selectText('thinking differently from your peers')
    await page.locator('#reading-lookup-result .translation-text').waitFor()
    const paraphrase = await waitForAnalysis()
    assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [
      "There are some kinds of work that you can't do well without thinking differently from your peers.",
    ])
    const main = await roles()
    assert.deepEqual(main.verb, ['are'], 'The relative-clause verb belongs in the clause details.')
    assert.deepEqual(main.object, [], 'Existential there has no main-clause object.')
    const details = page.locator('#reading-sentence-toggle')
    await screenshot('imported-article')
    return { paraphrase, roles: main, clauseCount: await details.locator('.sentence-clause').count() }
  })

  await check('one word click requests meaning and sentence explanation, then shares it with the next word', async () => {
    await backToIndex()
    await page.locator('#reading-paste').click()
    await page.locator('#reading-paste-text').fill(text)
    await page.locator('#reading-paste-open').click()
    await page.locator('#reading-detail .reading-preview').waitFor()
    const before = await page.evaluate(() => window.__readingLiveRequests.length)
    await clickWord(page, 'costs')
    await page.locator('#reading-lookup-result .translation-text').waitFor()
    const paraphrase = await waitForAnalysis()
    assert.equal(await page.locator('#reading-sentence-toggle').getAttribute('open'), '')
    assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [first])
    const main = await roles()
    assert.ok(main.verb.includes('could reduce'), JSON.stringify(main))
    assert.ok(main.subject.includes('The changes'), JSON.stringify(main))
    await screenshot('point-word')
    await clickWord(page, 'proposed', 0, { keepOpen: true })
    await page.locator('#reading-lookup-result .translation-text').waitFor()
    assert.equal(await waitForAnalysis(), paraphrase)
    const requests = await page.evaluate((start) => window.__readingLiveRequests.slice(start), before)
    assert.deepEqual(requests.filter(({ kind }) => kind === 'article-explanation').map(({ text }) => text), [first])
    assert.deepEqual(requests.filter(({ kind }) => kind === 'translate').map(({ text }) => text), ['costs', 'proposed'])
    return { paraphrase, roles: main, sentenceRequests: 1 }
  })

  await check('partial clause translates selection and analyzes the full sentence', async () => {
    await selectText('the team proposed')
    await page.locator('#reading-lookup-result .translation-text').waitFor()
    await waitForAnalysis()
    assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [first])
    const main = await roles()
    assert.ok(main.subject.includes('The changes'), JSON.stringify(main))
    assert.ok(main.verb.includes('could reduce'), JSON.stringify(main))
    assert.ok(!main.subject.some((part) => part.includes('the team')), 'The relative-clause subject should stay out of the main clause.')
    await screenshot('partial-clause')
    return { roles: main, translatedSelection: 'the team proposed' }
  })

  await check('cross-paragraph selection completes both endpoint sentences', async () => {
    await selectText('reduce costs.\n\nThe editor will record')
    await page.locator('#reading-lookup-result .translation-text').waitFor()
    await waitForAnalysis()
    assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [first, second])
    const main = await roles()
    assert.ok(main.verb.includes('could reduce') && main.verb.includes('will record'), JSON.stringify(main))
    assert.ok(!main.subject.includes('A careful review'), 'Unselected neighboring sentences must be excluded.')
    await screenshot('multiple-sentences')
    return { roles: main, sentenceCount: 2 }
  })

  await check('guided phrase keeps separate full-sentence structure', async () => {
    await selectText('the team proposed')
    await page.locator('#reading-lookup-guide').click()
    await page.locator('#reading-lookup-result .guide-tools').waitFor()
    await waitForAnalysis()
    assert.deepEqual(await page.locator('.reading-sentence-source').allTextContents(), [first])
    await page.locator('#reading-lookup-translate').click()
    await page.locator('#reading-lookup-result .translation-text').waitFor()
    return { sourceSentenceCount: await page.locator('.reading-sentence-source').count() }
  })

  await check('side panel drag width persists', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html')).setContentSize(1280, 800)
    })
    await page.waitForFunction(() => innerWidth === 1280)
    const handle = page.locator('#reading-lookup-resize')
    await handle.waitFor()
    const before = (await page.locator('.reading-lookup-dock').boundingBox()).width
    const box = await handle.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 110, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    savedWidth = (await page.locator('.reading-lookup-dock').boundingBox()).width
    assert.ok(savedWidth > before + 70, `Expected drag to widen the panel: ${before} -> ${savedWidth}`)
    await screenshot('resized-panel')
    return { before, after: savedWidth }
  })

  await check('history stores a reading anchor before restart', async () => {
    await backToIndex()
    await page.locator('#reading-history').click()
    const pasted = page.locator('.reading-history-open').filter({ hasText: first }).first()
    pastedHistoryId = await pasted.getAttribute('data-history-id')
    await pasted.click()
    await page.locator('#reading-detail .reading-preview').waitFor()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.evaluate(() => { document.getElementById('tutor-workspace').scrollTop = 1600 })
    savedPosition = await page.locator('#tutor-workspace').evaluate((node) => node.scrollTop)
    assert.ok(savedPosition > 500)
    await backToIndex()
    return { scrollTop: savedPosition }
  })

  await check('restart restores article position and panel width', async () => {
    assert.ok(pastedHistoryId, 'The saved pasted article should have a history identifier.')
    await app.close()
    app = null
    await launch()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html')).setContentSize(1280, 800)
    })
    await openCoach()
    await page.locator('#reading-history').click()
    await page.locator(`.reading-history-open[data-history-id="${pastedHistoryId}"]`).click()
    await page.waitForFunction(() => document.getElementById('tutor-workspace').scrollTop > 500)
    const restored = await page.locator('#tutor-workspace').evaluate((node) => node.scrollTop)
    assert.ok(Math.abs(restored - savedPosition) < 120, `Reading position changed: ${savedPosition} -> ${restored}`)
    await selectText('the team proposed')
    await page.locator('#reading-lookup-result .translation-text').waitFor()
    const width = (await page.locator('.reading-lookup-dock').boundingBox()).width
    assert.ok(Math.abs(width - savedWidth) < 3, `Saved sidebar width changed: ${savedWidth} -> ${width}`)
    return { savedScrollTop: savedPosition, restoredScrollTop: restored, sidebarWidth: width }
  })
} catch (error) {
  results.push({ name: 'harness', ok: false, error: scrub(error) })
  console.error(`[e2e:live-reading] FAIL harness: ${scrub(error)}`)
} finally {
  try { await app?.close() } catch { /* Keep the original test result. */ }
  rmSync(userDataDir, { recursive: true, force: true })
  writeFileSync(join(reportDir, recoveryOnly ? 'live-reading-recovery.json' : 'live-reading.json'), JSON.stringify({
    date: new Date().toISOString(), model, learningModel, results,
  }, null, 2))
}

const failed = results.filter((result) => !result.ok)
console.log(`[e2e:live-reading] ${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exitCode = 1
