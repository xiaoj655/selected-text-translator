import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as playwrightElectron } from 'playwright'
import electronBinary from 'electron'
import { createMockApi } from './mock-api.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..', '..')
const artifactRoot = join(desktopDir, 'artifacts', 'e2e')
const screenLabel = process.env.STT_E2E_SCREEN
  ? process.env.STT_E2E_SCREEN.replace(/[^a-z0-9]/gi, '-') : ''
const screenshotDir = screenLabel ? join(artifactRoot, 'screenshots', screenLabel) : join(artifactRoot, 'screenshots')
const reportDir = join(artifactRoot, 'report')
const logDir = join(artifactRoot, 'logs')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LONG_EN = 'Although the proposal looked promising and the initial demonstrations were well received, '
  + 'the board remained reluctant to approve the budget without a more detailed risk assessment and a clear '
  + 'implementation timeline that everyone could follow.'
const LONG_TRANSLATION = '尽管这项提案看起来很有前景，最初的演示也获得了广泛好评，但董事会仍然不愿在没有更详细的风险评估'
  + '和每个人都能够清楚理解的实施时间表的情况下批准这笔预算，因为他们认为目前的关键假设还没有得到充分验证，'
  + '而且后续几个季度的资源投入也缺少明确的衡量标准，因此决定推迟最终表决并等待补充材料。'

const TRANSLATIONS = new Map([
  ['record', '唱片'],
  ['simple', '简单'],
  [LONG_EN, LONG_TRANSLATION],
])

const LEXICAL = {
  phonetic: '/ˈrɛkərd/',
  definitions: [
    { pos: 'n.', meaning: 'a copy of a music release', example: { source: 'their new record', target: '他们的新唱片' } },
    { pos: 'v.', meaning: 'to capture sound', example: { source: 'record the meeting', target: '录制会议' } },
  ],
  contextual_analysis: '根据 will 判断第一处为动词，根据 a new 判断第二处为名词。',
}

export function ensureDisplay() {
  if (process.env.DISPLAY || process.env.STT_E2E_WRAPPED === '1') return false
  const screen = process.env.STT_E2E_SCREEN || '1920x1080x24'
  const result = spawnSync('dbus-run-session', [
    '--', 'xvfb-run', '-a', '-s', `-screen 0 ${screen}`,
    process.execPath, ...process.argv.slice(1),
  ], {
    stdio: 'inherit',
    env: { ...process.env, STT_E2E_WRAPPED: '1', STT_E2E: '1' },
  })
  if (result.error) {
    console.error(`[e2e] cannot start virtual display: ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

function watchErrors(page, bag) {
  page.on('pageerror', (error) => bag.push(String(error?.stack || error?.message || error)))
  page.on('console', (message) => {
    if (message.type() === 'error') bag.push(message.text())
  })
}

async function waitForMainPage(app) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const page = app.windows().find((item) => item.url().includes('index.html'))
    if (page) return page
    await delay(100)
  }
  throw new Error('main window was not created')
}

function findCardPage(app) {
  return app.windows().find((item) => item.url().includes('card.html')) || null
}

async function openCard(app, mainPage, payload) {
  const existing = findCardPage(app)
  const pending = existing
    ? Promise.resolve(existing)
    : app.waitForEvent('window', { timeout: 20000 })
  await mainPage.evaluate((value) => window.sttDesktop.e2e.showCard(value), payload)
  const cardPage = await pending
  await cardPage.locator('#card').waitFor({ state: 'visible', timeout: 20000 })
  return cardPage
}

async function setConfig(mainPage, config) {
  await mainPage.evaluate(async (values) => {
    await chrome.storage.sync.set(values)
  }, config)
}

async function waitForResult(cardPage, { error = false, expect = /./u, timeout = 25000 } = {}) {
  await cardPage.waitForFunction(({ isError, pattern }) => {
    const result = document.getElementById('result')
    if (!result) return false
    if (isError) return result.classList.contains('is-error')
    const done = Boolean(document.getElementById('actions')?.querySelector('button.is-primary'))
    return done && !result.classList.contains('is-loading') && new RegExp(pattern, 'u').test(result.textContent || '')
  }, { isError: error, pattern: expect.source }, { timeout })
}

async function waitForLayout(cardPage, mainPage, timeout = 6000) {
  const started = Date.now()
  let last = { dom: null, win: null }
  while (Date.now() - started < timeout) {
    last = { dom: await domMetrics(cardPage), win: await windowMetrics(mainPage) }
    if (last.win?.bounds && last.win.bounds.height >= Math.ceil(last.dom.docScrollHeight) - 2
      && last.dom.card.bottom <= last.dom.innerHeight + 1) return last
    await delay(80)
  }
  return last
}

async function domMetrics(cardPage) {
  return cardPage.evaluate(() => {
    const rect = (node) => {
      if (!node) return null
      const value = node.getBoundingClientRect()
      return {
        top: value.top, bottom: value.bottom, left: value.left, right: value.right,
        width: value.width, height: value.height,
      }
    }
    const result = document.getElementById('result')
    return {
      card: rect(document.getElementById('card')),
      actions: rect(document.getElementById('actions')),
      menu: rect(document.querySelector('.action-menu:not([hidden])')),
      result: rect(result),
      resultScroll: result ? { scrollHeight: result.scrollHeight, clientHeight: result.clientHeight } : null,
      docScrollHeight: document.documentElement.scrollHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      text: result ? result.textContent.trim() : '',
      isError: Boolean(result?.classList.contains('is-error')),
      isLoading: Boolean(result?.classList.contains('is-loading')),
      lexical: Boolean(document.querySelector('.lexical')),
    }
  })
}

async function windowMetrics(mainPage) {
  return mainPage.evaluate(() => window.sttDesktop.e2e.cardMetrics())
}

function assertLayout(label, win, dom) {
  assert.ok(win?.bounds, `${label}: card window metrics missing`)
  assert.equal(win.visible, true, `${label}: card window is not visible`)
  assert.ok(win.bounds.height >= Math.ceil(dom.docScrollHeight) - 2,
    `${label}: window ${win.bounds.height}px shorter than content ${dom.docScrollHeight}px`)
  assert.ok(dom.card && dom.card.top >= -1, `${label}: card top clipped (${dom.card?.top})`)
  assert.ok(dom.card && dom.card.bottom <= dom.innerHeight + 1,
    `${label}: card bottom clipped (${dom.card?.bottom} > ${dom.innerHeight})`)
  assert.ok(dom.actions && dom.actions.bottom <= dom.innerHeight + 1,
    `${label}: action buttons clipped (${dom.actions?.bottom} > ${dom.innerHeight})`)
  assert.ok(win.bounds.x >= win.workArea.x - 1
    && win.bounds.x + win.bounds.width <= win.workArea.x + win.workArea.width + 1,
  `${label}: window outside work area horizontally`)
  assert.ok(win.bounds.y >= win.workArea.y - 1
    && win.bounds.y + win.bounds.height <= win.workArea.y + win.workArea.height + 1,
  `${label}: window outside work area vertically`)
  if (dom.menu) {
    assert.ok(dom.menu.bottom <= dom.innerHeight + 1, `${label}: action menu clipped`)
  }
}

async function measure(cardPage, mainPage, label) {
  const { dom, win } = await waitForLayout(cardPage, mainPage)
  assertLayout(label, win, dom)
  return { dom, win }
}

async function shot(cardPage, name) {
  await cardPage.screenshot({ path: join(screenshotDir, `${name}.png`) })
}

export async function runE2E(mode = 'core') {
  ensureDisplay()
  for (const dir of [screenshotDir, reportDir, logDir]) mkdirSync(dir, { recursive: true })
  const mock = createMockApi({
    translationFor: (text) => TRANSLATIONS.get(text) || `译文:${text}`,
    lexicalFor: () => LEXICAL,
  })
  const mockUrl = await mock.listen()
  const userDataDir = mkdtempSync(join(tmpdir(), 'stt-e2e-'))
  const pageErrors = []
  const results = []
  let app
  const check = async (name, fn) => {
    const startedAt = Date.now()
    try {
      await fn()
      results.push({ name, ok: true, elapsedMs: Date.now() - startedAt })
      console.log(`[e2e] ok  ${name}`)
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.message || error), elapsedMs: Date.now() - startedAt })
      console.error(`[e2e] FAIL  ${name}: ${error?.message || error}`)
    }
  }

  try {
    app = await playwrightElectron.launch({
      executablePath: electronBinary,
      args: [desktopDir, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: { ...process.env, STT_E2E: '1' },
      timeout: 60000,
    })
    try {
      app.context().on('page', (page) => watchErrors(page, pageErrors))
    } catch {
      // older Playwright builds expose pages per window only
    }
    const mainPage = await waitForMainPage(app)
    watchErrors(mainPage, pageErrors)
    await setConfig(mainPage, {
      base_url: mockUrl,
      api_key: 'e2e-mock-key',
      model: 'qwen-mt-flash',
      learning_model: 'qwen3.8-flash',
      reading_mode: 'translate',
    })

    await check('boot: real Electron with main window', async () => {
      assert.ok(mainPage.url().includes('index.html'))
      assert.equal(await mainPage.locator('.app').count(), 1, 'main window did not render its root')
    })

    if (mode === 'core' || mode === 'all' || mode === 'layout') {
      await check('short word: streaming translation and compact card', async () => {
        const cardPage = await openCard(app, mainPage, { text: 'record', context: '' })
        watchErrors(cardPage, pageErrors)
        await waitForResult(cardPage, { expect: /唱片/u })
        const { dom, win } = await measure(cardPage, mainPage, 'short word')
        assert.ok(win.bounds.height < 320, `short card should stay compact, got ${win.bounds.height}`)
        await shot(cardPage, 'core-short-word')
      })

      await check('long paragraph: adaptive height and scroll containment', async () => {
        const cardPage = findCardPage(app)
        await openCard(app, mainPage, { text: LONG_EN, context: '' })
        await waitForResult(cardPage, { expect: /尽管/u })
        const { win } = await measure(cardPage, mainPage, 'long paragraph')
        assert.ok(win.bounds.height > 200, 'long card should grow')
        await shot(cardPage, 'core-long-paragraph')
      })

      await check('lexical details: phonetic, definitions and analysis fit', async () => {
        await setConfig(mainPage, { model: 'mock-generic' })
        const cardPage = findCardPage(app)
        try {
          await openCard(app, mainPage, { text: 'record', context: '' })
          await waitForResult(cardPage, { expect: /唱片/u })
          const { dom } = await measure(cardPage, mainPage, 'lexical details')
          assert.equal(dom.lexical, true, 'lexical block was not rendered')
          await shot(cardPage, 'core-lexical')
        } finally {
          mock.resetHandler()
          await setConfig(mainPage, { model: 'qwen-mt-flash' })
        }
      })

      await check('reopen after hide: height dedup does not leave stale bounds', async () => {
        const cardPage = findCardPage(app)
        await mainPage.evaluate(() => window.sttDesktop.e2e.hideCard())
        await delay(120)
        await openCard(app, mainPage, { text: 'simple', context: '' })
        await waitForResult(cardPage, { expect: /简单/u })
        const { win } = await measure(cardPage, mainPage, 'reopen')
        assert.ok(win.bounds.height < 320, `reopened card kept stale height ${win.bounds.height}`)
        await shot(cardPage, 'core-reopen')
      })

      await check('rapid consecutive triggers: latest request wins', async () => {
        const cardPage = findCardPage(app)
        await mainPage.evaluate(async () => {
          await window.sttDesktop.e2e.showCard({ text: 'record', context: '' })
          await window.sttDesktop.e2e.showCard({ text: 'simple', context: '' })
        })
        await waitForResult(cardPage, { expect: /简单/u })
        const { dom } = await measure(cardPage, mainPage, 'rapid triggers')
        assert.doesNotMatch(dom.text, /唱片/u)
      })

      await check('content variety: word, sentence, Chinese, mixed, multiline, unbroken', async () => {
        const cardPage = findCardPage(app)
        const samples = [
          { text: 'respect', label: 'single word' },
          { text: 'I need a moment to think.', label: 'short sentence' },
          { text: '你好，世界', label: 'Chinese' },
          { text: 'Hello 世界 mixed 内容', label: 'mixed' },
          { text: 'line one\nline two\nline three', label: 'multiline' },
          { text: 'A'.repeat(180), label: 'unbroken' },
        ]
        for (const sample of samples) {
          await openCard(app, mainPage, { text: sample.text, context: '' })
          await waitForResult(cardPage, { expect: /译文/u })
          await measure(cardPage, mainPage, `content variety: ${sample.label}`)
        }
      })

      await check('screen edges: card stays inside the work area at every corner', async () => {
        const cardPage = findCardPage(app)
        const base = await windowMetrics(mainPage)
        const { x, y, width, height } = base.workArea
        const points = [
          ['top-left', x + 2, y + 2],
          ['top-right', x + width - 2, y + 2],
          ['bottom-left', x + 2, y + height - 2],
          ['bottom-right', x + width - 2, y + height - 2],
          ['center', x + Math.round(width / 2), y + Math.round(height / 2)],
        ]
        for (const [label, px, py] of points) {
          execFileSync('xdotool', ['mousemove', String(px), String(py)])
          await delay(80)
          await openCard(app, mainPage, { text: LONG_EN, context: '' })
          await waitForResult(cardPage, { expect: /尽管/u })
          await measure(cardPage, mainPage, `screen edge: ${label}`)
          await shot(cardPage, `edge-${label}`)
        }
      })

      await check('API error: readable error state without clipping', async () => {
        mock.setHandler(async ({ res }) => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end('{"error":"boom"}')
        })
        const cardPage = findCardPage(app)
        try {
          await openCard(app, mainPage, { text: 'record', context: '' })
          await waitForResult(cardPage, { error: true })
          const { dom } = await measure(cardPage, mainPage, 'api error')
          assert.ok(dom.text.length > 0)
          await shot(cardPage, 'core-api-error')
        } finally {
          mock.resetHandler()
        }
      })

      await check('cancel: busy state is cancellable and stays laid out', async () => {
        mock.setHandler(async ({ res }) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '慢' } }] })}\n\n`)
        })
        const cardPage = findCardPage(app)
        try {
          await openCard(app, mainPage, { text: 'record', context: '' })
          await cardPage.getByRole('button', { name: '取消请求' }).waitFor({ timeout: 15000 })
          await cardPage.getByRole('button', { name: '取消请求' }).click()
          await cardPage.locator('#result.is-error').waitFor({ timeout: 10000 })
          await measure(cardPage, mainPage, 'cancel')
        } finally {
          mock.resetHandler()
        }
      })

      await check('copy result: clipboard receives the translation', async () => {
        const cardPage = findCardPage(app)
        await openCard(app, mainPage, { text: 'record', context: '' })
        await waitForResult(cardPage, { expect: /唱片/u })
        await measure(cardPage, mainPage, 'copy')
        await cardPage.getByRole('button', { name: '复制结果' }).click()
        await delay(150)
        const clipboard = execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' })
        assert.match(clipboard, /唱片/u)
      })

      await check('selection toolbar: Esc closes toolbar before card', async () => {
        const cardPage = findCardPage(app)
        await openCard(app, mainPage, { text: 'record', context: '' })
        await waitForResult(cardPage, { expect: /唱片/u })
        await cardPage.evaluate(() => {
          const result = document.getElementById('result')
          const walker = document.createTreeWalker(result, NodeFilter.SHOW_TEXT)
          const node = walker.nextNode()
          if (!node || !node.textContent) return
          const range = document.createRange()
          range.setStart(node, 0)
          range.setEnd(node, Math.min(2, node.textContent.length))
          const selection = window.getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
        })
        await cardPage.locator('#selection-toolbar:not([hidden])').waitFor({ timeout: 5000 })
        await measure(cardPage, mainPage, 'selection toolbar')
        await cardPage.keyboard.press('Escape')
        await cardPage.waitForFunction(() => document.getElementById('selection-toolbar')?.hidden === true,
          null, { timeout: 5000 })
        assert.equal((await windowMetrics(mainPage)).visible, true, 'Esc closed the card instead of only the toolbar')
      })

      await check('more menu: fully visible and Esc closes menu before card', async () => {
        const cardPage = findCardPage(app)
        await openCard(app, mainPage, { text: LONG_EN, context: '' })
        await waitForResult(cardPage, { expect: /尽管/u })
        await cardPage.getByRole('button', { name: '更多操作' }).click()
        await cardPage.locator('.action-menu:not([hidden])').waitFor()
        const { win: openWin } = await measure(cardPage, mainPage, 'menu open')
        await shot(cardPage, 'core-menu-open')
        await cardPage.keyboard.press('Escape')
        await cardPage.waitForFunction(() => !document.querySelector('.action-menu:not([hidden])'))
        await cardPage.waitForFunction(
          (openHeight) => {
            const metrics = window.sttDesktop.e2e.cardMetrics()
            return Boolean(metrics?.bounds && metrics.bounds.height < openHeight - 4)
          },
          openWin.bounds.height,
          { timeout: 5000 },
        ).catch(() => {})
        const { win, dom } = await measure(cardPage, mainPage, 'menu closed')
        assert.equal(win.visible, true, 'Esc closed the whole card instead of only the menu')
        assert.ok(win.bounds.height < openWin.bounds.height,
          `card did not shrink after menu closed (${openWin.bounds.height} -> ${win.bounds.height}); `
          + `docScrollHeight=${dom.docScrollHeight} card.bottom=${dom.card?.bottom} innerHeight=${dom.innerHeight}`)
      })
    }

    if (mode === 'visual' || mode === 'all') {
      const themes = [
        { name: 'light', prefs: { theme: 'light', font: 'normal', reducedMotion: false } },
        { name: 'dark', prefs: { theme: 'dark', font: 'normal', reducedMotion: false } },
        { name: 'small-font', prefs: { theme: 'light', font: 'small', reducedMotion: false } },
        { name: 'large-font', prefs: { theme: 'light', font: 'large', reducedMotion: false } },
        { name: 'reduced-motion', prefs: { theme: 'light', font: 'normal', reducedMotion: true } },
      ]
      for (const variant of themes) {
        await check(`visual: ${variant.name}`, async () => {
          await mainPage.evaluate(async (prefs) => {
            await chrome.storage.sync.set({ desktop_prefs: prefs })
          }, variant.prefs)
          const cardPage = await openCard(app, mainPage, { text: LONG_EN, context: '', prefs: variant.prefs })
          await waitForResult(cardPage, { expect: /尽管/u })
          await measure(cardPage, mainPage, `visual ${variant.name}`)
          const data = await cardPage.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            font: document.documentElement.dataset.font,
            motion: document.documentElement.dataset.motion,
          }))
          assert.equal(data.theme, variant.prefs.theme)
          assert.equal(data.font, variant.prefs.font)
          assert.equal(data.motion, variant.prefs.reducedMotion ? 'reduced' : 'full')
          await shot(cardPage, `visual-${variant.name}`)
        })
      }
    }

    await check('no renderer errors during the whole run', async () => {
      assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join(' | ')}`)
    })
  } catch (error) {
    results.push({ name: 'harness', ok: false, error: String(error?.message || error) })
    console.error(`[e2e] FAIL harness: ${error?.stack || error}`)
  } finally {
    const runTag = screenLabel ? `${mode}-${screenLabel}` : mode
    const report = { mode, screen: process.env.STT_E2E_SCREEN || '1920x1080x24',
      date: new Date().toISOString(), results, pageErrors }
    writeFileSync(join(reportDir, `${runTag}.json`), JSON.stringify(report, null, 2))
    try {
      writeFileSync(join(logDir, `${runTag}-renderer.log`), pageErrors.join('\n'))
    } catch { }
    try {
      await app?.close()
    } catch { }
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
  const failed = results.filter((item) => !item.ok)
  console.log(`[e2e] ${mode}: ${results.length - failed.length}/${results.length} passed`)
  console.log(`[e2e] artifacts: ${artifactRoot}`)
  if (failed.length) process.exitCode = 1
  return results
}
