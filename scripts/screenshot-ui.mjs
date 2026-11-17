import { createServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const appDir = join(root, 'desktop', 'app')
const outDir = join(root, '.agents', 'screenshots')
mkdirSync(outDir, { recursive: true })

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

const entries = [
  {
    id: 'e1',
    requestId: 'r1',
    text: 'The evidence suggests that remote work can boost productivity when teams have clear communication norms.',
    mode: 'translate',
    status: 'done',
    translatedText: '有证据表明，当团队具备清晰的沟通规范时，远程办公能够提升生产效率。',
    lexical: {
      phonetic: '/ˈevɪdəns/',
      definitions: [
        { pos: 'n.', meaning: '证据；迹象', example: { source: 'strong evidence', target: '有力的证据' } },
        { pos: 'v.', meaning: '表明；证明' },
      ],
      contextual_analysis: '此处 evidence 为不可数名词，suggests 表示“表明、显示”，而非“建议”。',
    },
    createdAt: Date.now() - 1000 * 60 * 12,
    hintCount: 1,
    answerRevealed: false,
  },
  {
    id: 'e2',
    requestId: 'r2',
    text: "It's not rocket science.",
    mode: 'guide',
    status: 'done',
    translatedText: '',
    guide: {
      phonetic: '',
      hints: [
        '先想想 rocket science 指的是什么领域。',
        '这句话常用来表示某事其实并不难。',
        '类似中文里的“这又不难”。',
      ],
      answer: {
        meaning: '这并不难；没什么高深的。',
        explanation: 'rocket science 指高深复杂的学问，否定形式表示某事简单易懂。',
        example: "Come on, just follow the steps — it's not rocket science.",
        usage: '常用于口语，带有轻松、鼓励的语气。',
      },
    },
    createdAt: Date.now() - 1000 * 60 * 9,
    hintCount: 2,
    answerRevealed: false,
  },
  {
    id: 'e3',
    requestId: 'r3',
    text: '这一个请求超时了，用来看看错误卡片长什么样。',
    mode: 'translate',
    status: 'error',
    error: '请求超时，请检查网络或稍后重试。',
    createdAt: Date.now() - 1000 * 60 * 4,
    hintCount: 1,
    answerRevealed: false,
  },
]

const baseInit = ({ history = [], theme = 'system', font = 'normal', accent = 'indigo' } = {}) => {
  window.__sttMessages = []
  const store = {
    reading_mode: 'translate',
    desktop_prefs: { theme, font, accent, reducedMotion: false, enterToSend: false, alwaysOnTop: false },
  }
  const noop = () => {}
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
    copyText: noop,
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
      sendMessage: async (msg) => {
        window.__sttMessages.push(msg)
        return { accepted: true }
      },
      onMessage: { addListener: noop },
      getURL: (path) => `app://local/${path}`,
      lastError: undefined,
    },
  }
}

async function shot(browser, name, { config, url, post }, viewport = { width: 1080, height: 780 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  await context.addInitScript(baseInit, config)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(350)
  if (post) await post(page)
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false })
  if (errors.length) console.log(`  ${name} pageerrors: ${errors.slice(0, 3).join(' | ')}`)
  console.log(`[shot] ${name}`)
  await context.close()
}

const browser = await chromium.launch({ headless: true })

const indexUrl = `${baseUrl}/index.html`
const cardUrl = `${baseUrl}/card.html`

await shot(browser, '13-settings-scrolled', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => {
    await page.click('#btn-settings')
    await page.waitForTimeout(150)
    await page.evaluate(() => { const d = document.querySelector('.drawer-body'); d.scrollTop = d.scrollHeight })
    await page.waitForTimeout(120)
  },
})
const closeSettings = async (page) => {
  await page.evaluate(() => {
    const panel = document.getElementById('settings-panel')
    if (panel && !panel.hidden) document.getElementById('btn-close-settings')?.click()
  })
  await page.waitForTimeout(120)
}
const scrollTop = async (page) => {
  await page.evaluate(() => { document.getElementById('stream').scrollTop = 0 })
  await page.waitForTimeout(120)
}

await shot(browser, '01-empty', {
  config: {},
  url: indexUrl,
  post: closeSettings,
})
await shot(browser, '02-conversation-light', {
  config: { history: entries },
  url: indexUrl,
  post: scrollTop,
})
await shot(browser, '03-conversation-dark', {
  config: { history: entries, theme: 'dark' },
  url: indexUrl,
  post: scrollTop,
})
await shot(browser, '04-settings', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => { await page.click('#btn-settings'); await page.waitForTimeout(200) },
})
await shot(browser, '05-help', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => { await page.click('#btn-more'); await page.click('#btn-help'); await page.waitForTimeout(200) },
})
await shot(browser, '06-history', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => { await page.click('#btn-history'); await page.waitForTimeout(200) },
})
await shot(browser, '07-export', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => { await page.click('#btn-export'); await page.waitForTimeout(200) },
})
await shot(browser, '09-actions-menu', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => {
    await scrollTop(page)
    await page.click('.action-more')
    await page.waitForTimeout(150)
  },
})
await shot(browser, '10-conversation-lower', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => {
    await page.evaluate(() => { const s = document.getElementById('stream'); s.scrollTop = s.scrollHeight })
    await page.waitForTimeout(120)
  },
})
await shot(browser, '08-card', {
  config: {},
  url: cardUrl,
  post: async (page) => {
    await page.evaluate(() => {
      const result = document.getElementById('result')
      result.className = 'result'
      result.innerHTML = '有证据表明，当团队具备清晰的沟通规范时，远程办公能够提升生产效率。'
      document.getElementById('src').textContent = 'The evidence suggests that remote work can boost productivity…'
      const actions = document.getElementById('actions')
      actions.innerHTML = '<button type="button" class="is-primary">复制结果</button><button type="button">朗读</button><button type="button" class="action-more" aria-label="更多操作" aria-expanded="false">⋯</button><div class="action-menu" hidden><button type="button">复制原文</button><button type="button">朗读译文</button><button type="button">收藏</button><button type="button">重新生成</button><button type="button">在主窗口打开</button></div>'
    })
    await page.waitForTimeout(150)
  },
}, { width: 460, height: 172 })
await shot(browser, '11-card-menu', {
  config: {},
  url: cardUrl,
  post: async (page) => {
    await page.evaluate(() => {
      const result = document.getElementById('result')
      result.className = 'result'
      result.innerHTML = '有证据表明，当团队具备清晰的沟通规范时，远程办公能够提升生产效率。'
      document.getElementById('src').textContent = 'The evidence suggests that remote work can boost productivity…'
      const actions = document.getElementById('actions')
      actions.innerHTML = '<button type="button" class="is-primary">复制结果</button><button type="button">朗读</button><button type="button" class="action-more" aria-label="更多操作" aria-expanded="false">⋯</button><div class="action-menu"><button type="button">复制原文</button><button type="button">朗读译文</button><button type="button">收藏</button><button type="button">重新生成</button><button type="button">在主窗口打开</button></div>'
    })
    await page.waitForTimeout(150)
  },
}, { width: 460, height: 360 })

await shot(browser, '12-bottom-menu', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => {
    await page.evaluate(() => { const s = document.getElementById('stream'); s.scrollTop = s.scrollHeight })
    await page.waitForTimeout(100)
    const more = page.locator('.entry .action-more').last()
    await more.click()
    await page.waitForTimeout(150)
  },
})

await shot(browser, '14-selection-toolbar', {
  config: { history: entries },
  url: indexUrl,
  post: async (page) => {
    await scrollTop(page)
    await page.evaluate(() => {
      const result = document.querySelector('.entry .entry-body .result')
      const textNode = [...result.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim().length > 8)
      const range = document.createRange()
      range.setStart(textNode, 0)
      range.setEnd(textNode, Math.min(10, textNode.textContent.length))
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      document.getElementById('stream').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.waitForTimeout(200)
  },
})

await browser.close()
server.close()
console.log(`[screenshots] ${outDir}`)
