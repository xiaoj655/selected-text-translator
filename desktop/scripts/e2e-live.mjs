import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as playwrightElectron } from 'playwright'
import electronBinary from 'electron'
import { ensureDisplay } from './e2e/runner.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const artifactRoot = join(desktopDir, 'artifacts', 'e2e')
const screenshotDir = join(artifactRoot, 'screenshots')
const reportDir = join(artifactRoot, 'report')

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const config = process.env.STT_LIVE_CONFIG
  ? JSON.parse(readFileSync(process.env.STT_LIVE_CONFIG, 'utf8'))
  : { apiKey: process.env.STT_API_KEY, baseUrl: process.env.STT_BASE_URL }
if (!config.apiKey || !config.baseUrl) {
  console.log('[e2e:live] skipped: set STT_API_KEY/STT_BASE_URL or STT_LIVE_CONFIG')
  process.exit(0)
}

const model = process.env.STT_TRANSLATION_MODEL || 'qwen-mt-flash'
const samples = ['record', 'simple', 'break the ice']

async function waitForMainPage(app) {
  for (let i = 0; i < 150; i += 1) {
    const page = app.windows().find((item) => item.url().includes('index.html'))
    if (page) return page
    await delay(100)
  }
  throw new Error('main window was not created')
}

function findCardPage(app) {
  return app.windows().find((item) => item.url().includes('card.html')) || null
}

async function openCard(app, mainPage, text) {
  const existing = findCardPage(app)
  const pending = existing ? Promise.resolve(existing) : app.waitForEvent('window', { timeout: 20000 })
  await mainPage.evaluate((value) => window.sttDesktop.e2e.showCard({ text: value, context: '' }), text)
  const cardPage = await pending
  await cardPage.locator('#card').waitFor({ state: 'visible', timeout: 20000 })
  return cardPage
}

async function waitForDone(cardPage) {
  await cardPage.locator('#actions button.is-primary').waitFor({ timeout: 40000 })
}

async function measure(cardPage, mainPage) {
  let last = null
  for (let i = 0; i < 80; i += 1) {
    last = await cardPage.evaluate(() => {
      const card = document.getElementById('card')
      const actions = document.getElementById('actions')
      return {
        cardBottom: card?.getBoundingClientRect().bottom ?? 0,
        actionsBottom: actions?.getBoundingClientRect().bottom ?? 0,
        innerHeight: window.innerHeight,
        docScrollHeight: document.documentElement.scrollHeight,
      }
    })
    const win = await mainPage.evaluate(() => window.sttDesktop.e2e.cardMetrics())
    if (win.bounds && win.bounds.height >= Math.ceil(last.docScrollHeight) - 2
      && last.actionsBottom <= last.innerHeight + 1) return { dom: last, win }
    await delay(80)
  }
  throw new Error('layout did not settle')
}

export async function runLiveE2E() {
  ensureDisplay()
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(reportDir, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'stt-e2e-live-'))
  const results = []
  let app
  try {
    app = await playwrightElectron.launch({
      executablePath: electronBinary,
      args: [desktopDir, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: { ...process.env, STT_E2E: '1' },
      timeout: 60000,
    })
    const mainPage = await waitForMainPage(app)
    await mainPage.evaluate(async (values) => {
      await window.sttDesktop.onCardEntry((entry) => {
        window.__liveEntries = window.__liveEntries || []
        window.__liveEntries.push(entry)
      })
      await chrome.storage.sync.set(values)
    }, {
      base_url: config.baseUrl.replace(/\/+$/, ''),
      api_key: config.apiKey,
      model,
      learning_model: 'qwen3.8-flash',
      reading_mode: 'translate',
    })

    for (const text of samples) {
      const startedAt = Date.now()
      try {
        const cardPage = await openCard(app, mainPage, text)
        await waitForDone(cardPage)
        const translated = await cardPage.locator('#result').textContent()
        assert.ok(translated.trim(), 'empty translation')
        const { win } = await measure(cardPage, mainPage)
        assert.equal(win.visible, true)
        const name = `live-${text.replace(/[^a-z]/gi, '-')}`
        await cardPage.screenshot({ path: join(screenshotDir, `${name}.png`) })
        results.push({ text, ok: true, elapsedMs: Date.now() - startedAt,
          translatedLength: translated.trim().length, windowHeight: win.bounds.height })
        console.log(`[e2e:live] ok ${text} (${translated.trim().length} chars)`)
      } catch (error) {
        results.push({ text, ok: false, error: String(error?.message || error) })
        console.error(`[e2e:live] FAIL ${text}: ${error?.message || error}`)
      }
    }

    const entries = await mainPage.evaluate(() => window.__liveEntries || [])
    assert.ok(entries.length >= 1, 'translation was not reported to the main window')
    assert.ok(entries.some((entry) => entry.status === 'done' && entry.translatedText),
      'no completed translation in history')
  } catch (error) {
    results.push({ name: 'harness', ok: false, error: String(error?.message || error) })
    console.error(`[e2e:live] FAIL harness: ${error?.stack || error}`)
  } finally {
    writeFileSync(join(reportDir, 'live.json'), JSON.stringify({ date: new Date().toISOString(), model, results }, null, 2))
    try {
      await app?.close()
    } catch { }
    rmSync(userDataDir, { recursive: true, force: true })
  }
  const failed = results.filter((item) => !item.ok)
  console.log(`[e2e:live] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

await runLiveE2E()
