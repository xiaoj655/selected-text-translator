import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const appDir = join(root, 'desktop', 'app')

const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '') || 'index.html'
  const file = join(appDir, name)
  if (!file.startsWith(appDir)) { res.writeHead(403); res.end(); return }
  try {
    const ext = extname(file)
    const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'text/javascript'
    res.writeHead(200, { 'content-type': type })
    res.end(readFileSync(file))
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
const indexUrl = `${baseUrl}/index.html`
const cardUrl = `${baseUrl}/card.html`

const entries = [
  {
    id: 'e1',
    requestId: 'r1',
    text: 'The evidence suggests that remote work can boost productivity.',
    mode: 'translate',
    status: 'done',
    translatedText: '有证据表明，远程办公能够提升生产效率。',
    lexical: { phonetic: '/ˈevɪdəns/', definitions: ['证据'], contextual_analysis: '语境说明' },
    createdAt: '2026-11-17T10:00:00.000Z',
  },
]

const baseInit = ({ history = [], copyLog = [], messageLog = [] } = {}) => {
  const noop = () => {}
  const store = {
    reading_mode: 'translate',
    desktop_prefs: { theme: 'system', font: 'normal', accent: 'indigo', reducedMotion: false },
  }
  window.__copyLog = copyLog
  window.__messageLog = messageLog
  window.sttDesktop = {
    loadHistory: async () => history,
    saveHistory: noop,
    clearHistory: noop,
    getHotkey: async () => 'Alt+Shift+E',
    getFlags: async () => ({ alwaysOnTop: false, loginItem: false, clipboardOnly: false }),
    getPlatform: async () => 'win32',
    platform: async () => 'win32',
    setTheme: noop,
    setCaptureMode: noop,
    setAlwaysOnTop: noop,
    setLoginItem: noop,
    setHotkey: async () => true,
    copyText: async (text) => { copyLog.push(text) },
    openLibrary: noop,
    openLog: noop,
    hide: noop,
    hideCard: noop,
    resizeCard: noop,
    setCardPinned: noop,
    onSelection: noop,
    onCardEntry: noop,
    onStatus: noop,
  }
  window.chrome = {
    storage: {
      sync: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : Object.keys(store)
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]))
        },
        set: async (items) => Object.assign(store, items),
      },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: noop },
    },
    runtime: {
      sendMessage: async (msg) => { messageLog.push(msg); return { accepted: true } },
      onMessage: { addListener: noop },
      getURL: (p) => `app://local/${p}`,
    },
    i18n: { getMessage: (k) => k },
  }
}

const browser = await chromium.launch({ headless: true })
const failures = []
const check = (name, fn) => {
  try { fn(); console.log(`  ok - ${name}`) }
  catch (error) { failures.push({ name, error }); console.log(`  NOT OK - ${name}: ${error.message}`) }
}

async function selectResultText(page, selector) {
  await page.evaluate((sel) => {
    const result = document.querySelector(sel)
    const walker = document.createTreeWalker(result, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && node.textContent.trim().length < 4) node = walker.nextNode()
    if (!node) throw new Error(`no text node in ${sel}`)
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(6, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    ;(sel.includes('#result') ? document.getElementById('result') : document.getElementById('stream'))
      .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, selector)
  await page.waitForTimeout(250)
}

// ---- main window toolbar ----
{
  const copyLog = []
  const messageLog = []
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 780 } })
  await ctx.addInitScript(baseInit, { history: entries, copyLog, messageLog })
  const page = await ctx.newPage()
  const pageerrors = []
  page.on('pageerror', (e) => pageerrors.push(e.message))
  await page.goto(indexUrl, { waitUntil: 'load' })
  await page.waitForTimeout(350)

  console.log('main-window selection toolbar:')
  await selectResultText(page, '.entry .entry-body .result')

  const visible = await page.locator('#selection-toolbar').isVisible()
  check('toolbar shown', () => assert.equal(visible, true))

  await page.click('#selection-toolbar [data-sel-action="copy"]')
  await page.waitForTimeout(120)
  const copyLogPage = await page.evaluate(() => window.__copyLog)
  check('copy captured selected text', () => {
    assert.equal(copyLogPage.length, 1)
    assert.ok(copyLogPage[0].length > 0, 'copied text non-empty')
  })
  const copyFeedback = await page.locator('#selection-toolbar [data-sel-action="copy"]').textContent()
  check('copy feedback stays visible', () => assert.match(copyFeedback, /已复制/))
  const toolbarStillVisible = await page.locator('#selection-toolbar').isVisible()
  check('toolbar still visible during feedback', () => assert.equal(toolbarStillVisible, true))

  await page.waitForTimeout(1500)
  const toolbarHiddenAfter = await page.locator('#selection-toolbar').isVisible()
  check('toolbar hides after feedback delay', () => assert.equal(toolbarHiddenAfter, false))

  await selectResultText(page, '.entry .entry-body .result')
  await page.click('#selection-toolbar [data-sel-action="speak"]')
  await page.waitForTimeout(120)
  const speakLog = await page.evaluate(() => window.__messageLog)
  check('speak sends SPEAK_TEXT', () => {
    assert.ok(speakLog.some((m) => m.type === 'SPEAK_TEXT'), 'SPEAK_TEXT present')
  })

  await selectResultText(page, '.entry .entry-body .result')
  await page.click('#selection-toolbar [data-sel-action="save"]')
  await page.waitForTimeout(120)
  const saveLog = await page.evaluate(() => window.__messageLog)
  check('save sends VOCABULARY_SAVE', () => {
    assert.ok(saveLog.some((m) => m.type === 'VOCABULARY_SAVE'), 'VOCABULARY_SAVE present')
  })

  console.log('main-window SOURCE text toolbar:')
  await selectResultText(page, '.entry .entry-source .bubble')
  const sourceToolbarVisible = await page.locator('#selection-toolbar').isVisible()
  check('toolbar shown on source text', () => assert.equal(sourceToolbarVisible, true))
  await page.click('#selection-toolbar [data-sel-action="copy"]')
  await page.waitForTimeout(120)
  const sourceCopyLog = await page.evaluate(() => window.__copyLog)
  check('source selection copy works', () => {
    assert.ok(sourceCopyLog.length >= 2, 'second copy captured')
    const last = sourceCopyLog[sourceCopyLog.length - 1]
    assert.ok(entries[0].text.startsWith(last), 'copied text is a prefix of the source')
  })

  check('no page errors (main)', () => assert.deepEqual(pageerrors, []))
  await ctx.close()
}

// ---- card window toolbar ----
{
  const copyLog = []
  const messageLog = []
  const ctx = await browser.newContext({ viewport: { width: 460, height: 360 } })
  await ctx.addInitScript(baseInit, { history: [], copyLog, messageLog })
  const page = await ctx.newPage()
  const pageerrors = []
  page.on('pageerror', (e) => pageerrors.push(e.message))
  await page.goto(cardUrl, { waitUntil: 'load' })
  await page.waitForTimeout(350)
  await page.evaluate(() => {
    document.getElementById('result').innerHTML = '<div>有证据表明远程办公能够提升生产效率，这是一个用于测试的译文句子。</div>'
  })

  console.log('card selection toolbar:')
  await selectResultText(page, '#result')

  const visible = await page.locator('#selection-toolbar').isVisible()
  check('card toolbar shown', () => assert.equal(visible, true))

  await page.click('#selection-toolbar [data-sel-action="copy"]')
  await page.waitForTimeout(120)
  const cardCopyLog = await page.evaluate(() => window.__copyLog)
  check('card copy captured selected text', () => {
    assert.equal(cardCopyLog.length, 1)
    assert.ok(cardCopyLog[0].length > 0)
  })
  const copyFeedback = await page.locator('#selection-toolbar [data-sel-action="copy"]').textContent()
  check('card copy feedback visible', () => assert.match(copyFeedback, /已复制/))

  check('no page errors (card)', () => assert.deepEqual(pageerrors, []))
  await ctx.close()
}

await browser.close()
server.close()

if (failures.length) {
  console.error(`\n[interaction] FAIL (${failures.length})`)
  process.exitCode = 1
} else {
  console.log('\n[interaction] ok - selection toolbar actions verified end-to-end')
}
