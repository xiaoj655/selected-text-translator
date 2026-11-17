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
  await mainPage.waitForFunction(() => {
    const panel = document.getElementById('settings-panel')
    if (!panel || panel.hidden) return true
    document.getElementById('btn-close-settings')?.click()
    return false
  }, null, { timeout: 5000 }).catch(() => {})
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
  try {
    await delay(250)
    await cardPage.screenshot({ path: join(screenshotDir, `${name}.png`), animations: 'disabled', timeout: 12000 })
  } catch (error) {
    console.warn(`[e2e] screenshot ${name} skipped: ${String(error?.message || error).split('\n')[0]}`)
  }
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

    await check('empty state: example translates in one click when configured', async () => {
      await mainPage.getByRole('button', { name: '试一个单词' }).click()
      await mainPage.waitForFunction(() => document.querySelectorAll('.entry').length >= 1, null, { timeout: 15000 })
      const source = await mainPage.locator('.entry .bubble').first().textContent()
      assert.match(source, /record/u)
      await mainPage.locator('#btn-more').click()
      await mainPage.locator('#btn-clear').click()
      await mainPage.locator('.snackbar-action').click()
      await mainPage.waitForFunction(() => document.querySelectorAll('.entry').length === 0, null, { timeout: 5000 })
    })

    await check('differentiation empty state: dual-mode cards switch translate/guide intent', async () => {
      assert.equal(await mainPage.locator('.empty').count(), 1, 'empty state should be visible')
      assert.equal(await mainPage.locator('.empty-mode').count(), 2, 'two mode cards should be shown')
      await shot(mainPage, 'empty-state-modes')
      await mainPage.locator('.empty-mode[data-empty-mode="guide"]').click()
      await mainPage.waitForFunction(() => document.querySelector('.mode[data-mode="guide"]')?.classList.contains('is-active'))
      const savedMode = await mainPage.evaluate(() => chrome.storage.sync.get('reading_mode'))
      assert.equal(savedMode.reading_mode, 'guide')
      assert.equal(await mainPage.locator('.empty-mode[data-empty-mode="guide"].is-active').count(), 1)
      await shot(mainPage, 'empty-state-guide-active')
      await mainPage.locator('.empty-mode[data-empty-mode="translate"]').click()
      await mainPage.waitForFunction(() => document.querySelector('.mode[data-mode="translate"]')?.classList.contains('is-active'))
      await shot(mainPage, 'empty-state-translate-active')
    })

    await check('floating card switch: UI toggle updates the main-process flag', async () => {
      await mainPage.locator('#btn-settings').click()
      await mainPage.waitForFunction(() => !document.getElementById('settings-panel').hidden)
      await mainPage.locator('#opt-main-window-only').check()
      const enabled = await mainPage.evaluate(() => window.sttDesktop.getFlags())
      assert.equal(enabled.floatingCardDisabled, true)
      await mainPage.locator('#opt-main-window-only').uncheck()
      const disabled = await mainPage.evaluate(() => window.sttDesktop.getFlags())
      assert.equal(disabled.floatingCardDisabled, false)
      await mainPage.locator('#btn-close-settings').click()
    })

    if (mode === 'core' || mode === 'all' || mode === 'layout') {
      await check('paste and translate: clipboard text becomes a translation without hotkey', async () => {
        const clipText = 'clipboard selection test'
        await mainPage.evaluate((text) => window.sttDesktop.copyText(text), clipText)
        await mainPage.locator('#btn-paste-translate').click()
        await mainPage.waitForFunction(() => document.querySelectorAll('.entry').length >= 1, null, { timeout: 15000 })
        await mainPage.waitForFunction(() => {
          const result = document.querySelector('.entry .result')
          return Boolean(result && result.textContent.trim() && !result.classList.contains('is-loading'))
        }, null, { timeout: 25000 })
        const source = await mainPage.locator('.entry .bubble').first().textContent()
        assert.match(source, /clipboard selection test/u)
      })

      await check('main window: scrolling up during streaming is not yanked back', async () => {
        const translation = '这是一段很长的流式译文,足够让内容超出可视区域。'.repeat(40)
        mock.setHandler(async ({ body, res }) => {
          if (!body?.stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translation }) } }] }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          for (const char of [...translation]) {
            if (res.destroyed) return
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`)
            await delay(6)
          }
          res.write('data: [DONE]\n\n')
          res.end()
        })
        try {
          await mainPage.locator('#input').fill('streaming scroll regression source text '.repeat(8))
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => {
            const s = document.getElementById('stream')
            return Boolean(s && s.scrollHeight - s.clientHeight > 160)
          }, null, { timeout: 15000 })
          await mainPage.evaluate(() => { document.getElementById('stream').scrollTop = 0 })
          await delay(400)
          const scrollTop = await mainPage.evaluate(() => document.getElementById('stream').scrollTop)
          assert.ok(scrollTop < 60, `stream was yanked back during streaming: scrollTop=${scrollTop}`)
        } finally {
          mock.resetHandler()
        }
      })

      await check('main window: cancel restores the submitted text to the input', async () => {
        mock.setHandler(async ({ res }) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '慢' } }] })}\n\n`)
        })
        const source = 'cancel me, keep my text'
        try {
          await mainPage.locator('#input').fill(source)
          await mainPage.locator('#btn-send').click()
          await mainPage.getByRole('button', { name: '取消请求' }).first().waitFor({ timeout: 15000 })
          await mainPage.getByRole('button', { name: '取消请求' }).first().click()
          await mainPage.waitForFunction(() => {
            const input = document.getElementById('input')
            return Boolean(input && input.value.trim())
          }, null, { timeout: 10000 })
          const restored = await mainPage.locator('#input').inputValue()
          assert.equal(restored.trim(), source)
        } finally {
          mock.resetHandler()
        }
      })

      await check('focused view: a new lookup replaces the previous result and history stays in sidebar', async () => {
        await mainPage.locator('#input').fill('record')
        await mainPage.locator('#btn-send').click()
        await mainPage.waitForFunction(() => {
          const result = document.querySelector('.entry .result')
          return Boolean(result && result.textContent.match(/唱片/u) && !result.classList.contains('is-loading'))
        }, null, { timeout: 20000 })
        assert.equal(await mainPage.locator('.entry').count(), 1, 'only the current result should be rendered')
        assert.match(await mainPage.locator('.entry .bubble').first().textContent(), /record/u)

        await mainPage.locator('#input').fill('simple')
        await mainPage.locator('#btn-send').click()
        await mainPage.waitForFunction(() => {
          const result = document.querySelector('.entry .result')
          return Boolean(result && result.textContent.match(/简单/u) && !result.classList.contains('is-loading'))
        }, null, { timeout: 20000 })
        assert.equal(await mainPage.locator('.entry').count(), 1, 'the second lookup must replace the first on screen')
        assert.match(await mainPage.locator('.entry .bubble').first().textContent(), /simple/u)
        assert.doesNotMatch(await mainPage.locator('.entry .bubble').first().textContent(), /record/u)

        await mainPage.locator('#btn-history').click()
        const historyCount = await mainPage.locator('.history-item').count()
        assert.ok(historyCount >= 2, `past lookups should remain in the sidebar, got ${historyCount}`)
        await shot(mainPage, 'main-focused-view')
        await mainPage.locator('#sidebar-backdrop').click({ force: true })
      })

      await check('live translation: typing alone translates and keeps the source text', async () => {
        const typed = 'live-translate-probe'
        await mainPage.locator('#input').fill('')
        await mainPage.locator('#input').pressSequentially(typed, { delay: 12 })
        await mainPage.waitForFunction((value) => {
          const bubble = document.querySelector('.entry .bubble')
          return Boolean(bubble && bubble.textContent.includes(value))
        }, typed, { timeout: 20000 })
        assert.equal(await mainPage.locator('#input').inputValue(), typed,
          'live translation must not clear the source text from the input')
        assert.equal(await mainPage.locator('.entry').count(), 1)
        assert.match(await mainPage.locator('.entry .bubble').first().textContent(), new RegExp(typed, 'u'))
        await shot(mainPage, 'main-live-translate')
      })

      await check('stale requests: a superseded translation cannot overwrite the current result', async () => {
        let firstCall = true
        mock.setHandler(async ({ body, res, defaultResponse }) => {
          if (firstCall) {
            firstCall = false
            await delay(1500)
          }
          await defaultResponse({ body, res })
        })
        try {
          await mainPage.locator('#input').fill('stale-probe-alpha')
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => /请求中|已自动翻译/u.test(
            document.getElementById('statusbar')?.textContent || ''), null, { timeout: 10000 })
          await mainPage.locator('#input').fill('fresh-probe-beta')
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => {
            const bubble = document.querySelector('.entry .bubble')
            const status = document.getElementById('statusbar')?.textContent || ''
            return Boolean(bubble && bubble.textContent.includes('fresh-probe-beta') && /完成/u.test(status))
          }, null, { timeout: 20000 })
          await delay(1800)
          assert.match(await mainPage.locator('.entry .bubble').textContent(), /fresh-probe-beta/u,
            'the visible result must stay the newest translation')
          assert.match(await mainPage.locator('#statusbar').textContent(), /完成/u,
            'a late event from a cancelled request must not clobber the current status')
          assert.ok((await mainPage.locator('.history-item').count()) >= 2)
          await shot(mainPage, 'main-stale-request')
        } finally {
          mock.resetHandler()
        }
      })

      await check('main window: translate result renders a dictionary-style learning card', async () => {
        await setConfig(mainPage, { model: 'mock-generic' })
        try {
          await mainPage.locator('#input').fill('record')
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => {
            const node = document.querySelector('.entry:last-child')
            const result = node?.querySelector('.result')
            return Boolean(result && !result.classList.contains('is-loading') && result.textContent.trim())
          }, null, { timeout: 20000 })
          await mainPage.waitForFunction(() => {
            const node = document.querySelector('.entry:last-child')
            return Boolean(node && node.querySelector('.translation-answer') && node.querySelector('.pos-chip')
              && node.querySelector('.sense-example') && node.querySelector('.phonetic-badge'))
          }, null, { timeout: 20000 })
          const chips = await mainPage.locator('.entry:last-child .pos-chip').allTextContents()
          assert.ok(chips.length >= 2, `expected multiple senses, got ${chips.length}`)
          assert.equal(await mainPage.locator('.entry:last-child .source-label').textContent(), '原文')
          const answerBorder = await mainPage.locator('.entry:last-child .translation-answer')
            .evaluate((node) => getComputedStyle(node).borderLeftWidth)
          assert.notEqual(answerBorder, '0px', 'the primary translation must render as an emphasized answer block')
          await delay(300)
          await shot(mainPage, 'main-dictionary-card')
        } finally {
          await setConfig(mainPage, { model: 'qwen-mt-flash' })
        }
      })

      await check('main window: guide card renders learning-focused styling', async () => {
        mock.setHandler(async ({ body, res }) => {
          const content = JSON.stringify({
            guideType: 'term',
            phonetic: '/rɪˈlʌk.tənt/',
            hints: ['想一想:不愿去做某事', '提示:近义词 hesitant', '提示:be reluctant to do'],
            answer: {
              meaning: 'not wanting to do something',
              explanation: 'reluctant means unwilling or hesitant to act.',
              example: 'She was reluctant to accept the offer.',
              usage: 'reluctant to do something',
            },
          })
          if (body?.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
            })
            for (const char of content) {
              if (res.destroyed) return
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`)
            }
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        })
        await mainPage.locator('.mode[data-mode=guide]').click()
        try {
          await mainPage.locator('#input').fill('reluctant')
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => {
            const node = document.querySelector('.entry:last-child')
            return Boolean(node && node.querySelector('.entry-card--guide') && node.querySelector('.guide-intro')
              && node.querySelector('.hint-step'))
          }, null, { timeout: 20000 })
          assert.ok((await mainPage.locator('.entry:last-child .hint-step').count()) >= 1)
          assert.match(await mainPage.locator('.entry:last-child .guide-intro').textContent(), /主动思考/u)
          await mainPage.locator('.entry:last-child').getByRole('button', { name: '揭晓答案' }).click()
          await mainPage.waitForFunction(() => Boolean(document.querySelector('.entry:last-child .answer')),
            null, { timeout: 5000 })
          await delay(300)
          await shot(mainPage, 'main-guide-card')
        } finally {
          mock.resetHandler()
          await mainPage.locator('.mode[data-mode=translate]').click()
        }
      })

      await check('companion drill-down: one click goes translate to guided learning and back', async () => {
        mock.setHandler(async ({ body, res, defaultResponse }) => {
          if (body?.model !== 'qwen3.8-flash') {
            await defaultResponse({ body, res })
            return
          }
          const content = JSON.stringify({
            guideType: 'term',
            phonetic: '/ˈrɛkərd/',
            hints: ['先看 will 后面的词', '再对比第二个 record', '想一想录音这个动作'],
            answer: {
              meaning: 'to capture sound or music',
              explanation: 'The first record follows will, so it is a verb.',
              example: 'I need to record this podcast.',
              usage: 'record + object',
            },
          })
          if (body?.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
            })
            for (const char of content) {
              if (res.destroyed) return
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`)
            }
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        })
        await setConfig(mainPage, { model: 'mock-generic' })
        try {
          await mainPage.locator('.mode[data-mode=translate]').click()
          await mainPage.locator('#input').fill('companion-probe')
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => {
            const status = document.getElementById('statusbar')?.textContent || ''
            const result = document.querySelector('.entry:last-child .result')
            return Boolean(result && !result.classList.contains('is-loading') && /完成|翻译记忆/u.test(status))
          }, null, { timeout: 20000 })
          assert.equal(await mainPage.locator('.entry:last-child .lexical-details').count(), 1)
          assert.equal(await mainPage.locator('.entry:last-child .lexical-details').evaluate((el) => el.open), false)

          await mainPage.locator('.entry:last-child .action-companion').click()
          await mainPage.waitForFunction(() => {
            const node = document.querySelector('.entry:last-child')
            return Boolean(node && node.querySelector('.entry-card--guide') && node.querySelector('.hint-step'))
          }, null, { timeout: 20000 })
          assert.match(await mainPage.locator('.entry:last-child .entry-source .bubble').textContent(), /companion-probe/u)

          await mainPage.locator('.entry:last-child .action-companion').click()
          await mainPage.waitForFunction(() => Boolean(document.querySelector('.entry:last-child .translation-answer')),
            null, { timeout: 20000 })
          assert.match(await mainPage.locator('.entry:last-child .entry-source .bubble').textContent(), /companion-probe/u)
          await shot(mainPage, 'main-companion-drilldown')
        } finally {
          mock.resetHandler()
          await setConfig(mainPage, { model: 'qwen-mt-flash' })
        }
      })

      await check('mode switch: changing intent re-translates the current input', async () => {
        mock.setHandler(async ({ body, res, defaultResponse }) => {
          if (body?.model !== 'qwen3.8-flash') {
            await defaultResponse({ body, res })
            return
          }
          const content = JSON.stringify({
            guideType: 'term',
            phonetic: '/məd/',
            hints: ['先看这个词的语境', '想一想它描述的对象', '再确认它的作用'],
            answer: {
              meaning: 'a preposition indicating accompaniment',
              explanation: 'Used to express being together with something.',
              example: 'I went with my friend.',
              usage: 'with + noun',
            },
          })
          if (body?.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
            })
            for (const char of content) {
              if (res.destroyed) return
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`)
            }
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        })
        try {
          await mainPage.locator('.mode[data-mode=translate]').click()
          await mainPage.locator('#input').fill('mode-switch-probe')
          await mainPage.waitForFunction(() => {
            const bubble = document.querySelector('.entry .bubble')
            const status = document.getElementById('statusbar')?.textContent || ''
            return Boolean(bubble && bubble.textContent.includes('mode-switch-probe') && /完成|翻译记忆/u.test(status))
          }, null, { timeout: 20000 })
          assert.equal(await mainPage.locator('.entry:last-child .translation-answer').count(), 1)

          await mainPage.locator('.mode[data-mode=guide]').click()
          await mainPage.waitForFunction(() => {
            const node = document.querySelector('.entry:last-child')
            return Boolean(node && node.querySelector('.entry-card--guide') && node.querySelector('.hint-step'))
          }, null, { timeout: 20000 })
          assert.match(await mainPage.locator('.entry:last-child .entry-source .bubble').textContent(), /mode-switch-probe/u,
            'switching mode must re-translate the same input, not clear it')
          assert.equal(await mainPage.locator('#input').inputValue(), 'mode-switch-probe')

          await mainPage.locator('.mode[data-mode=translate]').click()
          await mainPage.waitForFunction(() => Boolean(document.querySelector('.entry:last-child .translation-answer')),
            null, { timeout: 20000 })
          assert.match(await mainPage.locator('.entry:last-child .entry-source .bubble').textContent(), /mode-switch-probe/u)
          await shot(mainPage, 'main-mode-switch')
        } finally {
          mock.resetHandler()
          await mainPage.locator('.mode[data-mode=translate]').click()
        }
      })

      await check('target language: explicit setting reaches the model request', async () => {
        const capturedBodies = []
        const ensureSettings = async () => {
          const hidden = await mainPage.locator('#settings-panel').evaluate((el) => el.hidden)
          if (hidden) await mainPage.locator('#btn-settings').click()
          await mainPage.waitForFunction(() => !document.getElementById('settings-panel').hidden)
        }
        const waitForCaptured = async (count) => {
          const deadline = Date.now() + 20000
          while (capturedBodies.length < count && Date.now() < deadline) await delay(50)
          assert.ok(capturedBodies.length >= count, `expected ${count} captured requests, got ${capturedBodies.length}`)
        }
        mock.setHandler(async ({ body, res, defaultResponse }) => {
          capturedBodies.push(body)
          await defaultResponse({ body, res })
        })
        try {
          await ensureSettings()
          await mainPage.locator('#opt-target-language').selectOption('Japanese')
          const saved = await mainPage.evaluate(() => chrome.storage.sync.get('desktop_target_language'))
          assert.equal(saved.desktop_target_language, 'Japanese')
          await mainPage.locator('#btn-close-settings').click()

          await mainPage.locator('#input').fill('record')
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => {
            const result = document.querySelector('.entry:last-child .result')
            return Boolean(result && result.textContent.trim() && !result.classList.contains('is-loading'))
          }, null, { timeout: 20000 })
          await waitForCaptured(1)
          assert.equal(capturedBodies[0].translation_options?.target_lang, 'Japanese',
            'Qwen-MT request should carry the explicit target language')

          await setConfig(mainPage, { model: 'mock-generic' })
          await mainPage.locator('#input').fill('simple')
          await mainPage.locator('#btn-send').click()
          await mainPage.waitForFunction(() => {
            const results = document.querySelectorAll('.entry:last-child .result')
            const result = results[results.length - 1]
            return Boolean(result && result.textContent.trim() && !result.classList.contains('is-loading'))
          }, null, { timeout: 20000 })
          await waitForCaptured(2)
          const systemPrompt = capturedBodies[1].messages?.[0]?.content || ''
          assert.match(systemPrompt, /Translate only selectedText into Japanese\./u,
            'generic request system prompt should carry the explicit target language')
          assert.doesNotMatch(systemPrompt, /If selectedText contains Chinese/u,
            'generic system prompt should not keep the auto-direction sentence')
          await shot(mainPage, 'main-target-language')
        } finally {
          mock.resetHandler()
          await ensureSettings()
          await mainPage.locator('#opt-target-language').selectOption('auto')
          await mainPage.locator('#btn-close-settings').click()
          await setConfig(mainPage, { model: 'qwen-mt-flash' })
        }
      })

      await check('language bar: detected source language is shown as you type', async () => {
        const input = mainPage.locator('#input')
        const selectedLabel = () => mainPage.locator('#lang-source option:checked').textContent()
        try {
          await input.fill('')
          await input.dispatchEvent('input')
          assert.equal((await selectedLabel()).trim(), '自动检测原文')

          await input.fill('你好,我的朋友')
          await input.dispatchEvent('input')
          assert.match(await selectedLabel(), /检测为中文/u)

          await input.fill('Good morning, my friend.')
          await input.dispatchEvent('input')
          assert.match(await selectedLabel(), /检测为英语/u)

          await input.fill('おはようございます')
          await input.dispatchEvent('input')
          assert.match(await selectedLabel(), /检测为日语/u)

          await input.fill('')
          await input.dispatchEvent('input')
        } finally {
          await input.fill('')
          await input.dispatchEvent('input')
        }
      })

      await check('language bar: source can be pinned and directions swapped', async () => {
        const capturedBodies = []
        const waitForCaptured = async (count) => {
          const deadline = Date.now() + 20000
          while (capturedBodies.length < count && Date.now() < deadline) await delay(50)
          assert.ok(capturedBodies.length >= count, `expected ${count} captured requests, got ${capturedBodies.length}`)
        }
        mock.setHandler(async ({ body, res, defaultResponse }) => {
          capturedBodies.push(body)
          await defaultResponse({ body, res })
        })
        try {
          await mainPage.locator('#lang-source').selectOption('Japanese')
          await mainPage.locator('#lang-target').selectOption('Chinese')
          const saved = await mainPage.evaluate(() => chrome.storage.sync.get(['desktop_source_language', 'desktop_target_language']))
          assert.equal(saved.desktop_source_language, 'Japanese')
          assert.equal(saved.desktop_target_language, 'Chinese')
          await mainPage.locator('#input').fill('swap direction probe')
          await mainPage.waitForFunction(() => /完成|翻译记忆/u.test(document.getElementById('statusbar')?.textContent || ''),
            null, { timeout: 20000 })
          await waitForCaptured(1)
          assert.ok(capturedBodies.some((b) => b.translation_options?.source_lang === 'Japanese'),
            'pinned source language must reach the model request')
          const beforeSwap = capturedBodies.length

          await mainPage.locator('#btn-swap-lang').click()
          await waitForCaptured(beforeSwap + 1)
          const swapBody = capturedBodies[beforeSwap]
          const afterSwap = await mainPage.evaluate(() => chrome.storage.sync.get(['desktop_source_language', 'desktop_target_language']))
          assert.equal(afterSwap.desktop_source_language, 'Chinese')
          assert.equal(afterSwap.desktop_target_language, 'Japanese')
          assert.equal(await mainPage.locator('#lang-source').inputValue(), 'Chinese')
          assert.equal(await mainPage.locator('#lang-target').inputValue(), 'Japanese')
          assert.equal(swapBody.translation_options?.source_lang, 'Chinese')
          assert.equal(swapBody.translation_options?.target_lang, 'Japanese')
          assert.equal((await mainPage.locator('#input').inputValue()).trim(), 'swap direction probe')
          await shot(mainPage, 'main-language-swap')
        } finally {
          mock.resetHandler()
          await mainPage.locator('#lang-source').selectOption('auto')
          await mainPage.locator('#lang-target').selectOption('Chinese')
          await mainPage.locator('#input').fill('')
        }
      })

      await check('language bar: workspace target select syncs, persists and retranslates', async () => {
        const capturedBodies = []
        const waitForCaptured = async (count) => {
          const deadline = Date.now() + 20000
          while (capturedBodies.length < count && Date.now() < deadline) await delay(50)
          assert.ok(capturedBodies.length >= count, `expected ${count} captured requests, got ${capturedBodies.length}`)
        }
        mock.setHandler(async ({ body, res, defaultResponse }) => {
          capturedBodies.push(body)
          await defaultResponse({ body, res })
        })
        const probe = 'workspace language probe'
        try {
          assert.equal(await mainPage.locator('#lang-target').count(), 1)
          await mainPage.locator('#lang-target').selectOption('Japanese')
          const saved = await mainPage.evaluate(() => chrome.storage.sync.get('desktop_target_language'))
          assert.equal(saved.desktop_target_language, 'Japanese')
          const settingsValue = await mainPage.evaluate(() => document.getElementById('opt-target-language').value)
          assert.equal(settingsValue, 'Japanese', 'settings select must mirror the workspace bar')
          assert.match(await mainPage.locator('#statusbar').textContent(), /目标语言已设为 Japanese/u)

          await mainPage.locator('#input').fill(probe)
          await mainPage.waitForFunction((text) => {
            const entry = document.querySelector('.entry:last-child')
            const bubble = entry?.querySelector('.bubble')?.textContent || ''
            const result = entry?.querySelector('.result')
            const status = document.getElementById('statusbar')?.textContent || ''
            return Boolean(bubble.includes(text) && result?.textContent.trim()
              && !result.classList.contains('is-loading') && /完成/u.test(status))
          }, probe, { timeout: 20000 })
          await waitForCaptured(1)
          assert.equal(capturedBodies[0].translation_options?.target_lang, 'Japanese')

          await mainPage.locator('#lang-target').selectOption('French')
          await waitForCaptured(2)
          assert.equal(capturedBodies[1].translation_options?.target_lang, 'French',
            'changing the workspace language must retranslate the current text')
          assert.equal((await mainPage.locator('#input').inputValue()).trim(), probe,
            'retranslation must preserve the source text')
          await shot(mainPage, 'main-language-bar')
        } finally {
          mock.resetHandler()
          await mainPage.locator('#lang-target').selectOption('auto')
        }
      })

      await check('learning loop: study progress reminder and vocabulary book visualization', async () => {
        const now = Date.now()
        const DAY = 86400000
        const entry = (id, text, meaning, dueAt, intervalDays, reviewCount) => ({
          id, text, meaning, context: '', contextStart: null, contextEnd: null,
          usage: '', explanation: '', example: '', phonetic: '', sourceUrl: '',
          createdAt: now - 20 * DAY, updatedAt: now - DAY, dueAt, intervalDays, reviewCount,
        })
        const samples = [
          entry('due-1', 'reluctant', 'hesitant', now - DAY, 3, 2),
          entry('due-2', 'break the ice', 'ease tension', now - 1000, 1, 1),
          entry('due-3', 'record', 'a music album', now - 5 * DAY, 14, 4),
          entry('learning-1', 'simple', 'easy', now + DAY, 0, 0),
          entry('learning-2', 'phrase', 'a short expression', now + 2 * DAY, 3, 2),
          entry('mastered-1', 'take in', 'absorb', now + 7 * DAY, 7, 3),
        ]
        try {
          await mainPage.evaluate((entries) => chrome.storage.local.set({ vocabulary_entries: entries }), samples)
          await mainPage.waitForFunction(() => document.getElementById('study-progress-text')
            ?.textContent.includes('今日待复习 3'), null, { timeout: 10000 })
          assert.match(await mainPage.locator('#study-progress-text').textContent(),
            /今日待复习 3 · 学习中 2 · 已掌握 1/u)
          assert.equal(await mainPage.locator('#btn-study-progress.has-due').count(), 1)
          await shot(mainPage, 'main-study-progress')

          await mainPage.locator('#btn-study-progress').click()
          const libraryPage = await app.waitForEvent('window', { timeout: 20000 })
          await libraryPage.locator('#study-progress').waitFor({ state: 'visible', timeout: 20000 })
          await libraryPage.waitForFunction(() => document.getElementById('progress-due')?.textContent === '3',
            null, { timeout: 10000 })
          assert.equal(await libraryPage.locator('#progress-learning').textContent(), '2')
          assert.equal(await libraryPage.locator('#progress-mastered').textContent(), '1')
          assert.equal(await libraryPage.locator('#today-review-reminder').isVisible(), true)
          assert.equal(await libraryPage.locator('#today-review-count').textContent(), '3')
          await shot(libraryPage, 'library-study-progress')

          await libraryPage.evaluate(() => {
            window.__ankiCaptured = ''
            const original = URL.createObjectURL.bind(URL)
            URL.createObjectURL = (blob) => {
              if (blob instanceof Blob) void blob.text().then((text) => { window.__ankiCaptured = text })
              return original(blob)
            }
          })
          await libraryPage.locator('#export-anki').click()
          await libraryPage.waitForFunction(() => window.__ankiCaptured.length > 0, null, { timeout: 10000 })
          const ankiTsv = await libraryPage.evaluate(() => window.__ankiCaptured)
          const ankiRows = ankiTsv.split('\n')
          assert.equal(ankiRows.length, 6)
          assert.match(ankiRows[0], /^reluctant\t/u)
          assert.match(ankiRows[0], /selected-english$/u)
          assert.match(await libraryPage.locator('#library-status').textContent(), /已导出 6 条到 Anki/u)

          await libraryPage.locator('#start-review').click()
          await libraryPage.waitForFunction(() => document.getElementById('review-tab')?.getAttribute('aria-pressed') === 'true',
            null, { timeout: 5000 })
          await libraryPage.close()
        } finally {
          await mainPage.evaluate(() => chrome.storage.local.set({ vocabulary_entries: [] }))
        }
      })

      await check('proactive review reminder: per-day dedup and cross-day reset', async () => {
        const now = Date.now()
        const due = (id, text) => ({
          id, text, meaning: 'meaning', context: '', contextStart: null, contextEnd: null,
          usage: '', explanation: '', example: '', phonetic: '', sourceUrl: '',
          createdAt: now - 20 * 86400000, updatedAt: now - 86400000,
          dueAt: now - 1000, intervalDays: 3, reviewCount: 2,
        })
        const samples = [due('due-1', 'reluctant'), due('due-2', 'break the ice'), due('due-3', 'record')]
        const dayKeys = await mainPage.evaluate(() => {
          const fmt = (ms) => {
            const date = new Date(ms)
            const pad = (n) => String(n).padStart(2, '0')
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
          }
          return { today: fmt(Date.now()), yesterday: fmt(Date.now() - 86400000) }
        })
        try {
          await mainPage.evaluate((entries) => chrome.storage.local.set({
            vocabulary_entries: entries, lastReviewReminderDate: '',
          }), samples)
          await mainPage.reload()
          await mainPage.locator('.app').waitFor({ state: 'visible', timeout: 20000 })
          await mainPage.locator('#notice').waitFor({ state: 'visible', timeout: 15000 })
          assert.equal(await mainPage.locator('#notice').getAttribute('data-kind'), 'review')
          assert.match(await mainPage.locator('#notice').textContent(), /今天有 3 条表达等待复习/u)
          assert.equal(await mainPage.getByRole('button', { name: '去复习' }).count(), 1)
          assert.equal(await mainPage.locator('#notice .notice-close').count(), 1)
          assert.match(await mainPage.locator('#study-progress-text').textContent(), /今日待复习 3/u)
          const persisted = await mainPage.evaluate(() => chrome.storage.local.get('lastReviewReminderDate'))
          assert.equal(persisted.lastReviewReminderDate, dayKeys.today, 'reminder date must persist as today')
          await shot(mainPage, 'main-review-reminder')

          await mainPage.getByRole('button', { name: '去复习' }).click()
          const libraryPage = await app.waitForEvent('window', { timeout: 20000 })
          await libraryPage.locator('#study-progress').waitFor({ state: 'visible', timeout: 20000 })
          await libraryPage.close()

          await mainPage.locator('#notice .notice-close').click()
          await mainPage.waitForFunction(() => document.getElementById('notice').hidden, null, { timeout: 5000 })

          await mainPage.reload()
          await mainPage.locator('.app').waitFor({ state: 'visible', timeout: 20000 })
          await mainPage.waitForFunction(() => /今日待复习 3/u.test(
            document.getElementById('study-progress-text')?.textContent || ''), null, { timeout: 10000 })
          await delay(600)
          assert.equal(await mainPage.locator('#notice').isVisible(), false,
            'the reminder must not reappear on the same day')

          await mainPage.evaluate((date) => chrome.storage.local.set({ lastReviewReminderDate: date }), dayKeys.yesterday)
          await mainPage.reload()
          await mainPage.locator('.app').waitFor({ state: 'visible', timeout: 20000 })
          await mainPage.locator('#notice').waitFor({ state: 'visible', timeout: 15000 })
          assert.equal(await mainPage.locator('#notice').getAttribute('data-kind'), 'review',
            'the reminder must reappear on a new day')
        } finally {
          await mainPage.evaluate(() => chrome.storage.local.set({ vocabulary_entries: [], lastReviewReminderDate: '' }))
        }
      })

      await check('learning archive: export and import carry vocabulary, memory and history', async () => {
        const before = await mainPage.evaluate(async () => ({
          vocabulary: (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || [],
          memory: (await chrome.storage.local.get('translation_memory')).translation_memory || {},
          history: await window.sttDesktop.loadHistory(),
        }))
        const seedVocab = [{ id: 'archive-v1', text: 'portable archive', meaning: '可携带的学习档案' }]
        const seedMemory = { 'translate\0auto\0qwen\0archive probe': { translatedText: '档案探针', savedAt: Date.now() } }
        const seedHistory = [{ id: 'archive-h1', text: 'archive probe', status: 'done', createdAt: Date.now() }]
        try {
          await delay(400)
          await mainPage.evaluate(async ({ vocabulary, memory, history }) => {
            await chrome.storage.local.set({ vocabulary_entries: vocabulary, translation_memory: memory })
            window.sttDesktop.saveHistory(history)
          }, { vocabulary: seedVocab, memory: seedMemory, history: seedHistory })
          await mainPage.waitForFunction(async () => {
            const loaded = await window.sttDesktop.loadHistory()
            return loaded.some((entry) => entry.id === 'archive-h1')
          }, null, { timeout: 10000 })

          await mainPage.locator('#btn-settings').click()
          await mainPage.waitForFunction(() => !document.getElementById('settings-panel').hidden)
          await mainPage.evaluate(() => {
            window.__archiveCaptured = ''
            const original = URL.createObjectURL.bind(URL)
            URL.createObjectURL = (blob) => {
              if (blob instanceof Blob) void blob.text().then((text) => { window.__archiveCaptured = text })
              return original(blob)
            }
            window.__archiveAnchorClick = HTMLAnchorElement.prototype.click
            HTMLAnchorElement.prototype.click = function () {
              if (this.download) return
              return window.__archiveAnchorClick.call(this)
            }
          })
          await mainPage.locator('#btn-archive-export').click()
          await mainPage.waitForFunction(() => window.__archiveCaptured.length > 0, null, { timeout: 10000 })
          const archiveText = await mainPage.evaluate(() => window.__archiveCaptured)
          const archive = JSON.parse(archiveText)
          assert.equal(archive.format, 'selected-learning-archive')
          assert.equal(archive.version, 1)
          assert.equal(archive.sections.vocabulary.entries.length, 1)
          assert.equal(archive.sections.vocabulary.entries[0].text, 'portable archive')
          assert.equal(Object.keys(archive.sections.translationMemory.entries).length, 1)
          assert.ok(archive.sections.history.entries.some((entry) => entry.id === 'archive-h1'))
          assert.match(await mainPage.locator('#archive-status').textContent(), /已导出完整学习档案/u)

          await mainPage.evaluate(async () => {
            await chrome.storage.local.set({ vocabulary_entries: [], translation_memory: {} })
            window.sttDesktop.saveHistory([{ id: 'placeholder', text: 'placeholder', status: 'done', createdAt: Date.now() }])
          })
          await mainPage.locator('#archive-file').setInputFiles({
            name: 'archive.json', mimeType: 'application/json', buffer: Buffer.from(archiveText),
          })
          await mainPage.waitForFunction(async () => {
            const vocab = (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || []
            return vocab.some((entry) => entry.id === 'archive-v1')
          }, null, { timeout: 10000 })
          const restored = await mainPage.evaluate(async () => ({
            memory: (await chrome.storage.local.get('translation_memory')).translation_memory || {},
            history: await window.sttDesktop.loadHistory(),
          }))
          assert.equal(Object.keys(restored.memory).length, 1)
          assert.ok(restored.history.some((entry) => entry.id === 'archive-h1'))
          assert.match(await mainPage.locator('#archive-status').textContent(), /已导入档案/u)
          await mainPage.locator('#btn-close-settings').click()
          await mainPage.waitForFunction(() => document.getElementById('settings-panel').hidden)
          await shot(mainPage, 'main-learning-archive')
        } finally {
          await mainPage.evaluate(async (snapshot) => {
            if (window.__archiveAnchorClick) HTMLAnchorElement.prototype.click = window.__archiveAnchorClick
            await chrome.storage.local.set({
              vocabulary_entries: snapshot.vocabulary, translation_memory: snapshot.memory,
            })
            window.sttDesktop.saveHistory(snapshot.history)
          }, before)
          const panelHidden = await mainPage.locator('#settings-panel').evaluate((el) => el.hidden)
          if (!panelHidden) await mainPage.locator('#btn-close-settings').click()
        }
      })

      await check('learning archive import: conflicts protect existing data and legacy versions migrate', async () => {
        const before = await mainPage.evaluate(async () => ({
          vocabulary: (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || [],
          memory: (await chrome.storage.local.get('translation_memory')).translation_memory || {},
          history: await window.sttDesktop.loadHistory(),
        }))
        try {
          await delay(400)
          await mainPage.evaluate(async () => {
            await chrome.storage.local.set({
              vocabulary_entries: [{ id: 'conflict-existing', text: 'shared word', meaning: '现有释义', reviewCount: 7 }],
              translation_memory: { 'k-shared': { translatedText: '现有译文', savedAt: 1 } },
            })
            window.sttDesktop.saveHistory([{ id: 'conflict-h', text: 'shared word', status: 'done', createdAt: Date.now() }])
          })
          await mainPage.waitForFunction(async () => {
            const vocab = (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || []
            return vocab.some((entry) => entry.id === 'conflict-existing')
          }, null, { timeout: 10000 })

          const incoming = {
            format: 'selected-learning-archive',
            version: 1,
            exportedAt: Date.now(),
            sections: {
              vocabulary: { entries: [
                { id: 'conflict-incoming', text: 'shared word', meaning: '现有释义', reviewCount: 99 },
                { id: 'new-entry', text: 'brand new', meaning: '新增' },
              ] },
              translationMemory: { entries: {
                'k-shared': { translatedText: '新译文', savedAt: 999 },
                'k-new': { translatedText: '新记忆', savedAt: 999 },
              } },
              history: { entries: [{ id: 'new-h', text: 'brand new', status: 'done', createdAt: Date.now() }] },
            },
          }
          await mainPage.locator('#btn-settings').click()
          await mainPage.waitForFunction(() => !document.getElementById('settings-panel').hidden)
          await mainPage.locator('#archive-file').setInputFiles({
            name: 'conflicting.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)),
          })
          await mainPage.waitForFunction(() => {
            const box = document.getElementById('archive-conflict')
            return Boolean(box && !box.hidden)
          }, null, { timeout: 10000 })
          assert.match(await mainPage.locator('#archive-conflict-text').textContent(), /2 处冲突/u)
          assert.match(await mainPage.locator('#archive-conflict-text').textContent(), /收藏 1 · 记忆 1/u)
          assert.match(await mainPage.locator('#archive-status').textContent(), /现有数据未被改动/u)
          const beforeChoice = await mainPage.evaluate(async () => ({
            vocabulary: (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || [],
            memory: (await chrome.storage.local.get('translation_memory')).translation_memory || {},
          }))
          assert.equal(beforeChoice.vocabulary.find((e) => e.text === 'shared word').reviewCount, 7,
            'conflicting import must not touch existing data before the user chooses')
          assert.equal(beforeChoice.memory['k-shared'].translatedText, '现有译文')
          await mainPage.screenshot({ path: join(screenshotDir, 'main-archive-conflict.png'), animations: 'disabled' })

          await mainPage.locator('#archive-conflict-keep').click()
          await mainPage.waitForFunction(async () => {
            const vocab = (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || []
            return vocab.some((entry) => entry.text === 'brand new')
          }, null, { timeout: 10000 })
          const after = await mainPage.evaluate(async () => ({
            vocabulary: (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || [],
            memory: (await chrome.storage.local.get('translation_memory')).translation_memory || {},
          }))
          assert.equal(after.vocabulary.find((e) => e.text === 'shared word').reviewCount, 7,
            'existing review progress must survive the import')
          assert.equal(after.memory['k-shared'].translatedText, '现有译文',
            'existing translation must survive the import')
          assert.equal(after.memory['k-new'].translatedText, '新记忆')
          assert.match(await mainPage.locator('#archive-status').textContent(), /保留现有冲突 2 处/u)
          assert.equal(await mainPage.locator('#archive-conflict').evaluate((el) => el.hidden), true)

          const legacy = {
            format: 'selected-learning-archive',
            exportedAt: Date.now(),
            sections: {
              vocabulary: { entries: [{ id: 'legacy-entry', text: 'legacy word', meaning: '旧词' }] },
              translationMemory: { entries: {} },
              history: { entries: [] },
            },
          }
          await mainPage.locator('#archive-file').setInputFiles({
            name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)),
          })
          await mainPage.waitForFunction(async () => {
            const vocab = (await chrome.storage.local.get('vocabulary_entries')).vocabulary_entries || []
            return vocab.some((entry) => entry.text === 'legacy word')
          }, null, { timeout: 10000 })
          assert.match(await mainPage.locator('#archive-status').textContent(), /已导入档案/u)
          assert.equal(await mainPage.locator('#archive-conflict').evaluate((el) => el.hidden), true,
            'a legacy archive with no conflicts should import without a prompt')

          await mainPage.locator('#btn-close-settings').click()
          await mainPage.waitForFunction(() => document.getElementById('settings-panel').hidden)
          await shot(mainPage, 'main-archive-imported')
        } finally {
          await mainPage.evaluate(async (snapshot) => {
            await chrome.storage.local.set({
              vocabulary_entries: snapshot.vocabulary, translation_memory: snapshot.memory,
            })
            window.sttDesktop.saveHistory(snapshot.history)
          }, before)
          const conflictHidden = await mainPage.locator('#archive-conflict').evaluate((el) => el.hidden)
          if (!conflictHidden) await mainPage.locator('#archive-conflict-cancel').click()
          const panelHidden = await mainPage.locator('#settings-panel').evaluate((el) => el.hidden)
          if (!panelHidden) await mainPage.locator('#btn-close-settings').click()
        }
      })

      await check('translation memory: repeat text is served instantly without a new API call', async () => {
        await setConfig(mainPage, { model: 'qwen-mt-flash' })
        const text = 'memory-probe-alpha'
        const before = mock.requests.length
        await mainPage.locator('#input').fill(text)
        await mainPage.locator('#btn-send').click()
        await mainPage.waitForFunction(() => {
          const result = document.querySelector('.entry:last-child .result')
          const status = document.getElementById('statusbar')?.textContent || ''
          return Boolean(result && result.textContent.trim() && !result.classList.contains('is-loading')
            && /完成/u.test(status))
        }, null, { timeout: 20000 })
        const afterFirst = mock.requests.length
        assert.ok(afterFirst > before, 'first submission should reach the model API')
        const stored = await mainPage.evaluate(() => chrome.storage.local.get('translation_memory'))
        assert.ok(Object.keys(stored.translation_memory || {}).length >= 1,
          'completed translation should be persisted to translation memory')

        await mainPage.locator('#input').fill(text)
        await mainPage.locator('#btn-send').click()
        await mainPage.waitForFunction(() => {
          const node = document.querySelector('.entry:last-child')
          return Boolean(node && node.querySelector('.memory-tag') && node.querySelector('.result')?.textContent.trim())
        }, null, { timeout: 15000 })
        assert.equal(mock.requests.length, afterFirst, 'repeat submission must be served from memory, not the API')
        assert.match(await mainPage.locator('#statusbar').textContent(), /来自翻译记忆/u)
        await mainPage.locator('.entry:last-child').scrollIntoViewIfNeeded()
        await delay(200)
        await shot(mainPage, 'main-translation-memory')
      })

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
