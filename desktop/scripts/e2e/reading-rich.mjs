import assert from 'node:assert/strict'
import { isArticleExplanation } from './mock-api.mjs'

const ARTICLE_URL = 'https://reader.example.org/articles/rich-fixture'
const TITLE = 'Reading the complete calibration report'
const INLINE_SELECTION = 'record the interview and keep a release note'
const FOCUS_TEXT = 'The iridescence filter is adjusted only after the observatory cools down. Its delayed calibration compensates for a temperature shift that appears late in the experiment. The operators compare the final spectrum against an independent reference before accepting it.'
const TAIL_CONTEXT = 'The last rehearsal reached the remote observatory. We will record the final calibration after sunset. Its result confirms the late-stage correction.'
const COACH_REPLY = 'This paragraph explains why the operators wait for the observatory to cool before calibrating the filter.'

// Small, real PNG and VP8/WebM fixtures keep media checks entirely offline.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAeAAAAB4CAIAAACl9LZYAAAACXBIWXMAAAABAAAAAQBPJcTWAAACHUlEQVR4nO3coU1EQRhGUQg4BC2+Bl4FT69fsg1seQgECCQJBokc8l825zQwX0bcjJr717f3OwB6HqcHAPA7gQaIEmiAKIEGiBJogCiBBogSaIAogQYWO12u0xMWO/Zt5FyBBogSaIAogQaIEmiAKIEGiBJogCiBBogSaIAogQaIEmiAKIEGiBJo+OEHCWoEGiBKoAGiBBogSqABogQaIEqgAaIEGiBKoAGiBBogSqABogQaIEqgAaIEGiBKoAGiBBogSqABogQaIEqgAaIEGiBKoAGiBBogSqABogQaIEqg/73Ph+fpCYs9fX1MT4AEgf73zueX6QmLHfs2PQESBBogSqABogQaIEqgAaIEGiBKoAGiBBogSqABogQaIEqgAaIEGiBKoAGiBBogSqABogQaIEqgAaIEGiBKoAGiBBogSqABogQaIEqgAaIEGiBKoAGiBBogSqABogQaIEqgAaIEGiBKoAGixgJ9ulynjv4jx75NTwBuihc0QJRAA0QJNECUQANECTRAlEADRAk0QJRAA0QJNECUQANECTRAlEADRAk0QJRAA0QJNECUQANECTRAlEADRAk0QJRAA0QJNECUQANECTRAlEADRAk0QJRAA0QJNECUQANECTRAlEADRAk0QJRAA0QJNECUQANECTRA1Figj32bOvrGuMlV3OQqbnIVL2iAKIEGiBJogCiBBogSaIAogQaIEmiAKIEGiBJogCiBBogSaIAogQaIEmiAKIEGiBJogCiBBogSaIAogQaIEmiAKIEGiBJogCiBBogSaIAogQaIEmiAqG/mvRi7zROJ6gAAAABJRU5ErkJggg=='
const WEBM = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHLTbuMU6uEElTDZ1OsggEY7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmpSrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDAWVK5ryK4BAAAAAAAAP9eBAXPFiDVPrcx+awennIEAIrWcg3VuZIiBAIaFVl9WUDiDgQEj44OEBfXhAOCQsIFguoFAmoECVbCEVbmBARJUw2fXc3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2Mi4zLjEwMHNzsmPAi2PFiDVPrcx+awenZ8ihRaOHRU5DT0RFUkSHlExhdmM2Mi4xMS4xMDAgbGlidnB4H0O2dUCg54EAo7uBAACAsAMAnQEqYABAAABHCIWFiIWEiAICAnWqAgaf586dOnTp06dOnTfA/uQBf7gzPq7HD+5sc4tkMKOWgQBkANEBAAEQEAAYABhYL/QACIUoAKOWgQDIANEBAAEQEAAYABhYL/QACIUoAKOWgQEsANEBAAEQEAAYABhYL/QACIUoAKOWgQGQANEBAAEQEAAYABhYL/QACIUoAA=='

function articleHtml() {
  const paragraphs = Array.from({ length: 74 }, (_value, index) => index === 60
    ? `<p>${FOCUS_TEXT}</p>`
    : `<p>Observation ${index + 1} explains how the engineering team checks a complete sequence of measurements. Each experiment uses the same reference instrument so that a change in the environment can be distinguished from a change in the equipment. The team reviews the evidence before continuing.</p>`).join('')
  return `<!doctype html><html><head><title>${TITLE}</title></head><body><nav>Publisher navigation</nav><article>
    <h1>${TITLE}</h1><h2>A readable release report</h2>
    <p>Before the inline example. We will <strong>record the interview</strong> and keep a <a href="../notes/details">release note</a> for the team. After the inline example.</p>
    <p>The next paragraph explains why the measurements matter. The team checks them before a release.</p>
    <figure><img data-src="../assets/chart.png" src="../assets/placeholder.png" width="480" height="120" alt="Calibration chart"><figcaption>Figure 1. Measurements rise after calibration.</figcaption></figure>
    <figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 40" width="240" height="40" onload="window.richInjected=true"><title>Static calibration diagram</title><rect width="240" height="40" fill="#e5eaee"/><text x="12" y="26" fill="#27313a">Calibration reference</text><script>window.richInjected=true</script></svg></figure>
    <ul><li>Keep the original measurements.</li><li>Compare each independent sample.</li></ul>
    <table><caption>Calibration observations</caption><thead><tr><th>Phase</th><th>Reading</th></tr></thead><tbody><tr><td>Before</td><td>Two independent samples are within the expected range.</td></tr><tr><td>After</td><td>Four independent samples confirm the correction.</td></tr></tbody></table>
    <pre><code>const measurement = 42;\nverify(measurement);</code></pre>
    <p>The demonstration below shows the instrument after the calibration. A separate unavailable recording has an original-page fallback.</p>
    <video src="../assets/clip.webm" poster="../assets/chart.png" controls></video>
    <video src="../assets/unavailable.webm" controls></video>
    <iframe src="https://www.youtube.com/embed/rich-fixture" title="Original demonstration"></iframe>
    <p>Untrusted markup is removed while the article remains readable: <a href="javascript:window.richInjected=true">an unsafe link</a><img src="javascript:window.richInjected=true" alt="Unsafe image"><span onclick="window.richInjected=true">plain inline text</span>.</p>
    <script>window.richInjected=true</script><style>body{display:none}</style><form><input value="untrusted"></form>
    ${paragraphs}<h2>The final observation</h2><p>${TAIL_CONTEXT}</p>
  </article></body></html>`
}

async function selectText(page, startText, endText = startText) {
  if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
  return page.evaluate(async ({ startText, endText }) => {
    const material = document.querySelector('#reading-detail .reading-preview')
    const content = material.textContent
    const start = content.indexOf(startText)
    const end = content.indexOf(endText, start) + endText.length
    if (start < 0 || end < start) throw new Error('Missing selection in rich article')
    const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let offset = 0
    let started = false
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = offset + node.length
      if (!started && start < next) { range.setStart(node, start - offset); started = true }
      if (started && end <= next) { range.setEnd(node, end - offset); break }
      offset = next
    }
    const scroller = document.getElementById('tutor-workspace')
    scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const native = window.getSelection()
    native.removeAllRanges()
    native.addRange(range)
    const bounds = range.getClientRects()[0]
    material.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1,
      clientX: bounds.left + 1, clientY: bounds.top + 1 }))
    return content.slice(start, end)
  }, { startText, endText })
}

async function clickTailWord(page) {
  if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
  const point = await page.evaluate(async () => {
    const material = document.querySelector('#reading-detail .reading-preview')
    const start = material.textContent.indexOf('record the final calibration')
    const walker = document.createTreeWalker(material, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let offset = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (start >= offset && start + 6 <= offset + node.length) {
        range.setStart(node, start - offset)
        range.setEnd(node, start + 6 - offset)
        break
      }
      offset += node.length
    }
    window.getSelection().removeAllRanges()
    const scroller = document.getElementById('tutor-workspace')
    scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rect = range.getClientRects()[0]
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await page.locator('#reading-lookup').waitFor({ state: 'visible' })
}

export async function verifyRichReading({ app, page, mock, check, shot }) {
  let saved
  let installed = false
  const translationInputs = []
  const discussionInputs = []

  async function prepare() {
    if (installed) return
    saved = await page.evaluate(() => chrome.storage.sync.get(['model', 'learning_model', 'desktop_iqs_api_key', 'desktop_reading_lookup_mode']))
    await app.evaluate(({ shell }, { url, html, png, webm }) => {
      const https = process.getBuiltinModule('node:https')
      const { Readable } = process.getBuiltinModule('node:stream')
      globalThis.__richReadingFixture = { get: https.get, openExternal: shell.openExternal, requests: [], opened: [] }
      shell.openExternal = async (target) => { globalThis.__richReadingFixture.opened.push(target) }
      https.get = (target, options, callback) => {
        const href = typeof target === 'string' ? target : target.href
        if (href !== url && !href.startsWith('https://reader.example.org/assets/')) {
          return globalThis.__richReadingFixture.get(target, options, callback)
        }
        const range = options.headers?.Range || options.headers?.range || ''
        globalThis.__richReadingFixture.requests.push({ url: href, range })
        let body = href === url ? Buffer.from(html)
          : href.endsWith('/chart.png') ? Buffer.from(png, 'base64')
            : href.endsWith('/clip.webm') ? Buffer.from(webm, 'base64') : Buffer.from('Not a playable WebM file')
        const type = href === url ? 'text/html; charset=utf-8' : href.endsWith('.png') ? 'image/png' : 'video/webm'
        const total = body.length
        const headers = { 'content-type': type, 'content-length': String(total), 'accept-ranges': 'bytes' }
        let statusCode = 200
        const match = /^bytes=(\d+)-(\d*)$/u.exec(range)
        if (match) {
          const start = Number(match[1])
          const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
          body = body.subarray(start, end + 1)
          headers['content-range'] = `bytes ${start}-${end}/${total}`
          headers['content-length'] = String(body.length)
          statusCode = 206
        }
        const response = Object.assign(Readable.from([body]), { statusCode, headers })
        queueMicrotask(() => callback(response))
        return response
      }
    }, { url: ARTICLE_URL, html: articleHtml(), png: PNG, webm: WEBM })
    installed = true
    await page.evaluate(async () => {
      await chrome.storage.sync.set({ model: 'mock-generic', learning_model: 'mock-generic', desktop_iqs_api_key: '', desktop_reading_lookup_mode: 'translate' })
    })
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      if (isArticleExplanation(body)) return defaultResponse({ body, res })
      let input
      try { input = JSON.parse(body.messages.at(-1).content) } catch { return defaultResponse({ body, res }) }
      const isDiscussion = body.messages?.[0]?.content?.includes('Read an English article together')
      if (isDiscussion) discussionInputs.push(input)
      else if (input.selectedText) translationInputs.push(input)
      else return defaultResponse({ body, res })
      const content = isDiscussion ? { reply: COACH_REPLY, quote: FOCUS_TEXT.split('. ')[0] + '.', followups: [] }
        : { translation: `Meaning of ${input.selectedText}`, structure: [], phonetic: '/ˈrɛkərd/' }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
    })
  }

  async function openFixture() {
    await prepare()
    await page.locator('#btn-tutor-workspace').click()
    await page.locator('#tutor-reading-mode').click()
    if (await page.locator('#reading-back').isVisible()) await page.locator('#reading-back').click()
    await page.locator('#reading-import').click()
    await page.locator('#reading-import-url').fill(ARTICLE_URL)
    await page.getByRole('button', { name: 'Import article', exact: true }).click()
    await page.locator('#reading-detail').getByRole('heading', { name: TITLE, exact: true }).waitFor()
    return page.locator('#reading-detail .reading-preview')
  }

  try {
    await check('rich article: complete structure, safe HTML and offline media playback', async () => {
      const before = mock.requests.length
      const material = await openFixture()
      assert.equal(await material.evaluate((node) => node.tagName), 'DIV')
      assert.ok((await material.textContent()).length > 12000)
      assert.equal(await material.textContent(), await page.evaluate(async (url) =>
        (await window.sttDesktop.reading.importPage(url)).text, ARTICLE_URL), 'renderer and extracted article text must match')
      assert.ok((await material.textContent()).includes(TAIL_CONTEXT), 'the final paragraph must survive import')
      for (const selector of ['h2', 'strong', 'ul li', 'table th', 'pre code', 'figure figcaption']) {
        assert.ok(await material.locator(selector).count(), `missing article structure: ${selector}`)
      }
      assert.equal(await material.locator('a').filter({ hasText: 'release note' }).getAttribute('href'),
        'https://reader.example.org/notes/details')
      assert.equal(await material.locator('script, style, form, input, iframe, object, embed').count(), 0)
      assert.equal(await material.evaluate((node) => [...node.querySelectorAll('*')].some((element) =>
        [...element.attributes].some((attribute) => /^on/iu.test(attribute.name) || attribute.value.startsWith('javascript:')))), false)
      assert.equal(await page.evaluate(() => Boolean(window.richInjected)), false)
      const image = material.locator('img[alt="Calibration chart"]')
      await image.scrollIntoViewIfNeeded()
      await image.evaluate((node) => node.decode())
      assert.ok(await image.evaluate((node) => node.naturalWidth > 0))
      assert.match(await image.getAttribute('src'), /^stt-media:\/\/asset\//u)
      const diagram = material.locator('img[alt="Static calibration diagram"]')
      await diagram.scrollIntoViewIfNeeded()
      await diagram.evaluate((node) => node.decode())
      assert.ok(await diagram.evaluate((node) => node.naturalWidth > 0))
      assert.match(await diagram.getAttribute('src'), /^data:image\/svg\+xml;base64,/u)
      assert.equal(await page.evaluate(() => Boolean(window.richInjected)), false)

      const video = material.locator('video[src*="clip.webm"]')
      await video.scrollIntoViewIfNeeded()
      await video.evaluate(async (node) => { node.muted = true; await node.play() })
      await page.waitForFunction(() => document.querySelector('video[src*="clip.webm"]')?.currentTime > 0.04)
      await video.evaluate((node) => node.pause())
      const unavailable = material.locator('video[src*="unavailable.webm"]')
      await unavailable.evaluate((node) => { node.load() })
      await page.waitForFunction(() => Boolean(document.querySelector('video[src*="unavailable.webm"]')?.error))
      const fallback = unavailable.locator('xpath=following-sibling::*[1]').locator('a[data-reading-media-fallback]')
      await fallback.waitFor({ state: 'visible' })
      assert.equal(await fallback.getAttribute('href'), ARTICLE_URL)
      await fallback.click()
      const network = await app.evaluate(() => ({ requests: globalThis.__richReadingFixture.requests,
        opened: globalThis.__richReadingFixture.opened }))
      assert.ok(network.requests.some((request) => request.url.endsWith('/clip.webm') && /^bytes=/u.test(request.range)),
        'video loading must forward the Chromium Range request')
      assert.ok(network.opened.includes(ARTICLE_URL), 'the unavailable video must open the original page')
      assert.equal(mock.requests.length, before, 'reading and media loading must not call a model')
      await material.locator('h2').first().evaluate((node) => node.scrollIntoView({ block: 'start' }))
      await shot?.(page, 'main-tutor-rich-article')
    })

    await check('rich article: cross-tag selections and sentence context at the end', async () => {
      const material = await openFixture()
      await selectText(page, INLINE_SELECTION)
      await page.locator('#reading-lookup-result').getByText(`Meaning of ${INLINE_SELECTION}`, { exact: true }).waitFor()
      const inline = translationInputs.findLast((input) => input.selectedText === INLINE_SELECTION)
      assert.ok(inline, 'a selection across strong and a link must reach the model')
      assert.equal(inline.surroundingContext,
        'Before the inline example. We will record the interview and keep a release note for the team. After the inline example.')
      assert.equal(inline.surroundingContext.slice(inline.contextStart, inline.contextEnd), INLINE_SELECTION)

      const selected = await selectText(page, 'After the inline example.', 'The next paragraph explains why the measurements matter.')
      await page.locator('#reading-lookup-result').getByText(`Meaning of ${selected}`, { exact: true }).waitFor()
      const crossParagraph = translationInputs.findLast((input) => input.selectedText === selected)
      assert.ok(crossParagraph, 'cross-paragraph selection must preserve its exact text')
      assert.equal(crossParagraph.surroundingContext.slice(crossParagraph.contextStart, crossParagraph.contextEnd), selected,
        JSON.stringify(crossParagraph))

      await clickTailWord(page)
      await page.locator('#reading-lookup-result').getByText('Meaning of record', { exact: true }).waitFor()
      const tail = translationInputs.findLast((input) => input.selectedText === 'record')
      assert.equal(tail.surroundingContext, TAIL_CONTEXT)
      assert.equal(tail.surroundingContext.slice(tail.contextStart, tail.contextEnd), 'record')
      assert.ok((await material.textContent()).indexOf('record the final calibration') > 12000)
    })

    await check('rich article: bounded Coach context follows a paragraph beyond the old limit', async () => {
      const material = await openFixture()
      if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
      assert.ok((await material.textContent()).indexOf(FOCUS_TEXT) > 12000)
      await material.locator('p').filter({ hasText: FOCUS_TEXT }).evaluate((node) => node.scrollIntoView({ block: 'center' }))
      await page.evaluate(() => {
        const input = document.getElementById('reading-question')
        input.value = '这一段为什么要等到最后才校准？'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.form.requestSubmit()
      })
      await page.locator('#reading-thread').getByText(COACH_REPLY, { exact: true }).waitFor()
      const input = discussionInputs.at(-1)
      assert.ok(input, 'the Coach request must reach the configured mock')
      assert.equal(input.article.textIsPartial, true)
      assert.ok(input.article.totalTextLength > 12000)
      assert.ok(input.article.text.length + (input.article.headings || []).join('').length <= 12000)
      assert.ok(input.article.text.includes(FOCUS_TEXT), 'the visible later paragraph must receive context priority')
      assert.ok(input.history.reduce((total, turn) => total + turn.text.length, 0) <= 8000)
      assert.equal(await page.locator('#reading-thread .reading-quote').last().textContent(), FOCUS_TEXT.split('. ')[0] + '.')
    })

    await check('rich article: long pasted text is complete and Coach receives an independent budget', async () => {
      await prepare()
      if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
      await page.locator('#reading-back').click()
      await page.locator('#reading-paste').click()
      const text = Array.from({ length: 100 }, (_value, index) => `Paragraph ${index + 1}. The team compares independent measurements before recording a result. The final calibration must preserve a complete record of its assumptions.`).join('\n\n')
        + '\n\nThis pasted article ends beyond the former character limit.'
      await page.locator('#reading-paste-text').fill(text)
      const before = mock.requests.length
      await page.locator('#reading-paste-open').click()
      assert.equal(await page.locator('#reading-detail .reading-preview').textContent(), text)
      assert.equal(mock.requests.length, before, 'opening pasted text must not call a model')
      await page.locator('#reading-start').click()
      await page.locator('#reading-thread').getByText(COACH_REPLY, { exact: true }).waitFor()
      const input = discussionInputs.at(-1)
      assert.equal(input.article.kind, 'pasted_text')
      assert.equal(input.article.totalTextLength, text.length)
      assert.ok(input.article.text.length <= 12000)
      assert.ok(input.article.text.includes('This pasted article ends beyond the former character limit.'))
      await page.getByText('Coach is using selected passages from this long article.', { exact: false }).waitFor()
    })
  } finally {
    if (installed) {
      mock.resetHandler()
      await app.evaluate(({ shell }) => {
        const https = process.getBuiltinModule('node:https')
        https.get = globalThis.__richReadingFixture.get
        shell.openExternal = globalThis.__richReadingFixture.openExternal
        delete globalThis.__richReadingFixture
      })
      await page.evaluate(async (values) => {
        await chrome.storage.sync.remove(['model', 'learning_model', 'desktop_iqs_api_key', 'desktop_reading_lookup_mode'])
        await chrome.storage.sync.set(values)
      }, saved)
      if (await page.locator('#reading-lookup').isVisible()) await page.locator('#reading-lookup-close').click()
      await page.locator('#btn-translate-workspace').click()
    }
  }
}
