import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as playwrightElectron } from 'playwright'
import electronBinary from 'electron'
import { ensureDisplay } from './e2e/runner.mjs'
import { clickWord } from './e2e/reading-lookup.mjs'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactRoot = join(desktopDir, 'artifacts', 'e2e')
const screenshotDir = join(artifactRoot, 'screenshots')
const reportDir = join(artifactRoot, 'report')
const TEXT = "There are some kinds of work that you can't do well without thinking differently from your peers. To be a successful scientist"
const FRAGMENT = 'To be a successful scientist'
const ELLIPSIS = 'The sooner, the better.'
const FIRST_SENTENCE_END = TEXT.indexOf(FRAGMENT)
const model = process.env.STT_TRANSLATION_MODEL || 'qwen-mt-flash'
const learningModel = process.env.STT_LEARNING_MODEL || 'qwen3.8-flash'
let config
try {
  config = process.env.STT_LIVE_CONFIG
    ? JSON.parse(readFileSync(process.env.STT_LIVE_CONFIG, 'utf8'))
    : { apiKey: process.env.STT_API_KEY, baseUrl: process.env.STT_BASE_URL }
} catch {
  console.error('[e2e:live-sentence] Could not read the external live-test configuration.')
  process.exit(1)
}
if (!config?.apiKey || !config?.baseUrl) {
  console.log('[e2e:live-sentence] skipped: set STT_API_KEY/STT_BASE_URL or STT_LIVE_CONFIG')
  process.exit(0)
}

function scrub(value) {
  return String(value?.message || value).split(String(config.apiKey)).join('[redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gu, '[redacted]')
}

async function waitForMainPage(app) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const page = app.windows().find((item) => item.url().includes('index.html'))
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Main window was not created.')
}

async function selectArticleText(page) {
  await page.evaluate((text) => {
    const host = [...document.querySelectorAll('.reading-preview')]
      .find((node) => node.getClientRects().length && node.textContent.includes(text))
    if (!host) throw new Error('The pasted article is not visible.')
    const start = host.textContent.indexOf(text)
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let offset = 0
    let locatedStart = false
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const end = offset + node.textContent.length
      if (!locatedStart && start < end) {
        range.setStart(node, start - offset)
        locatedStart = true
      }
      if (locatedStart && start + text.length <= end) {
        range.setEnd(node, start + text.length - offset)
        break
      }
      offset = end
    }
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const bounds = range.getClientRects()[0]
    if (!bounds) throw new Error('The article selection has no visible bounds.')
    host.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, button: 0,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
    }))
  }, TEXT)
  await page.locator('#reading-lookup').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#reading-lookup-text').textContent(), TEXT)
}

async function articleRoles(page) {
  if (await page.locator('.reading-sentence-source .sentence-mark').count()) {
    await page.waitForFunction(() => ['subject', 'verb', 'object', 'complement'].some((role) =>
      CSS.highlights.has(`reading-lookup-${role}`)))
  }
  return page.evaluate(() => Object.fromEntries(['subject', 'verb', 'object', 'complement'].map((role) => [
    role, [...(CSS.highlights.get(`reading-lookup-${role}`) || [])].map((range) => range.toString()),
  ])))
}

async function verifyArticleAnalysis(host) {
  const paraphrase = host.locator('.reading-sentence-paraphrase')
  await paraphrase.waitFor()
  const meaning = (await paraphrase.textContent()).trim()
  assert.ok(meaning, 'The model must provide full-sentence meaning independently of the grammar details.')
  return meaning
}

function assertMainRoles(roles) {
  assert.deepEqual(roles.verb, ['are'], 'Only the main-clause verb should be highlighted in the article.')
  assert.deepEqual(roles.object, [], 'An existential there sentence must not acquire a direct object.')
  for (const spans of Object.values(roles)) {
    for (const text of spans) {
      const start = TEXT.indexOf(text)
      assert.ok(start >= 0 && start + text.length <= FIRST_SENTENCE_END,
        'Main highlights must remain in the complete first sentence.')
      assert.ok(!text.includes('that you'), `The embedded relative clause must stay out of main highlights: ${JSON.stringify(roles)}`)
    }
  }
}

async function verifyAnalysis(page, host) {
  await host.locator('.sentence-fragment').filter({ hasText: FRAGMENT }).waitFor({ timeout: 45000 })
  await host.locator('.sentence-connection').first().waitFor()
  const details = host.locator('details.sentence-explore')
  await details.waitFor()
  assert.equal(await details.getAttribute('open'), null, 'Clause details should start collapsed.')
  await details.locator('summary').click()
  await details.locator('.sentence-clause-source .sentence-mark').first().waitFor()
  assert.equal(await details.getAttribute('open'), '', 'Opening clause details should not need another API request.')
  const clauses = await details.locator('.sentence-clause-source').allTextContents()
  assert.ok(clauses.some((clause) => clause.includes("you can't do")), 'The relative clause should be available for deeper reading.')
  const clauseRoles = await details.locator('.sentence-mark').evaluateAll((marks) => marks.map((mark) => ({
    role: mark.dataset.role, text: mark.textContent,
  })))
  assert.equal(clauseRoles.some(({ role, text }) => role === 'object' && /^(well|differently)$/iu.test(text)), false,
    'An adverb must not be labeled as a subordinate-clause object.')
  return {
    connectionCount: await host.locator('.sentence-connection').count(),
    fragmentCount: await host.locator('.sentence-fragment').count(),
    clauseCount: clauses.length,
    clauseRoleCount: await details.locator('.sentence-mark').count(),
    clauseRoles,
  }
}

export async function runLiveSentenceE2E() {
  ensureDisplay()
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(reportDir, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'stt-live-sentence-'))
  const results = []
  let app
  let page
  async function check(name, run) {
    const started = Date.now()
    try {
      const detail = await run()
      results.push({ name, ok: true, elapsedMs: Date.now() - started, ...detail })
      console.log(`[e2e:live-sentence] ok ${name}: ${JSON.stringify(detail)}`)
    } catch (error) {
      const message = scrub(error)
      const analysisEvents = await page?.evaluate(() => window.__liveSentenceAnalysisEvents || []).catch(() => [])
      results.push({ name, ok: false, elapsedMs: Date.now() - started, error: message, analysisEvents })
      console.error(`[e2e:live-sentence] FAIL ${name}: ${message}`)
    }
  }
  try {
    app = await playwrightElectron.launch({
      executablePath: electronBinary,
      args: [desktopDir, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: { ...process.env, STT_E2E: '1' }, timeout: 60000,
    })
    page = await waitForMainPage(app)
    page.setDefaultTimeout(45000)
    await page.evaluate(async (values) => chrome.storage.sync.set(values), {
      base_url: config.baseUrl.replace(/\/+$/u, ''), api_key: config.apiKey,
      model, learning_model: learningModel, reading_mode: 'translate',
      desktop_reading_lookup_mode: 'translate', desktop_live_translate: false,
      desktop_source_language: 'english', desktop_target_language: 'Chinese',
    })
    await page.reload()
    await page.locator('#installed-version').waitFor({ state: 'attached' })
    await page.evaluate(() => {
      window.__liveSentenceAnalysisEvents = []
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type !== 'TRANSLATION_EVENT') return
        const { status, structure, sentenceAnalysis, result } = message.payload || {}
        if (status === 'structure' || (status === 'success' && result?.sentenceAnalysis)) {
          window.__liveSentenceAnalysisEvents.push({ status, structure, sentenceAnalysis, result })
        }
      })
    })
    if (await page.locator('#settings-panel').isVisible()) await page.locator('#btn-close-settings').click()
    const screenshot = async (name) => {
      assert.equal(await page.locator('#settings-panel').isVisible(), false, 'Settings must stay out of screenshots.')
      await page.screenshot({ path: join(screenshotDir, `${name}.png`) })
    }

    await page.locator('#btn-tutor-workspace').click()
    await page.locator('#tutor-reading-mode').click()
    await page.locator('#reading-paste').click()
    await page.locator('#reading-paste-text').fill(`${TEXT}\n\n${ELLIPSIS}`)
    await page.locator('#reading-paste-open').click()
    await page.locator('.reading-preview').first().waitFor()
    await selectArticleText(page)
    const lookup = page.locator('#reading-lookup-result')

    await check('article-direct', async () => {
      await lookup.locator('.translation-text').waitFor()
      const paraphrase = await verifyArticleAnalysis(lookup)
      const grammar = lookup.locator('#reading-sentence-toggle')
      assert.equal(await grammar.getAttribute('open'), null)
      const translated = (await lookup.locator('.translation-text').textContent()).trim()
      assert.ok(translated, 'The completed real translation should be nonempty.')
      await screenshot('live-sentence-article-direct')
      await grammar.locator('summary').click()
      const roles = await articleRoles(page)
      if (roles.verb.length) assertMainRoles(roles)
      return { translatedLength: translated.length, paraphrase, roles }
    })

    await check('article-guided', async () => {
      await page.locator('#reading-lookup-guide').click()
      await lookup.locator('.hint').first().waitFor()
      const explanation = lookup.locator('#reading-sentence-explanation')
      assert.equal(await explanation.getAttribute('open'), null)
      await explanation.locator(':scope > summary').click()
      const paraphrase = await verifyArticleAnalysis(lookup)
      const roles = await articleRoles(page)
      assert.equal(await lookup.locator('.answer').count(), 0, 'Exploring clauses must not reveal the answer.')
      await screenshot('live-sentence-article-guided')
      return { paraphrase, roles }
    })

    await check('article-ellipsis', async () => {
      await clickWord(page, 'sooner')
      await lookup.locator('.translation-text').waitFor()
      const paraphrase = await verifyArticleAnalysis(lookup)
      assert.match(paraphrase, /越[早快]|尽早/u)
      assert.deepEqual(await lookup.locator('.reading-sentence-source').allTextContents(), [ELLIPSIS])
      assert.equal(await lookup.locator('#reading-sentence-toggle').getAttribute('open'), null)
      await screenshot('live-sentence-article-ellipsis')
      return { paraphrase }
    })

    await check('workbench-direct', async () => {
      await page.locator('#reading-lookup-close').click()
      await page.locator('#btn-translate-workspace').click()
      await page.locator('.mode[data-mode=translate]').click()
      await page.locator('#input').fill(TEXT)
      await page.locator('#btn-send').click()
      const entry = page.locator('.entry:last-child')
      await entry.locator('.translation-text').waitFor()
      const analysis = await verifyAnalysis(page, entry)
      const roles = Object.fromEntries(await Promise.all(['subject', 'verb', 'object', 'complement'].map(async (role) => [
        role, await entry.locator(`.entry-source .sentence-mark[data-role="${role}"]`).allTextContents(),
      ])))
      assertMainRoles(roles)
      await screenshot('live-sentence-workbench-direct')
      return { roles, ...analysis }
    })
  } catch (error) {
    const message = scrub(error)
    results.push({ name: 'harness', ok: false, error: message })
    console.error(`[e2e:live-sentence] FAIL harness: ${message}`)
  } finally {
    writeFileSync(join(reportDir, 'live-sentence.json'), JSON.stringify({
      date: new Date().toISOString(), model, learningModel, selection: TEXT, results,
    }, null, 2))
    try { await app?.close() } catch { }
    rmSync(userDataDir, { recursive: true, force: true })
  }
  const passed = results.filter((item) => item.ok).length
  console.log(`[e2e:live-sentence] ${passed}/${results.length} passed`)
  if (passed !== results.length) process.exitCode = 1
}

await runLiveSentenceE2E()
