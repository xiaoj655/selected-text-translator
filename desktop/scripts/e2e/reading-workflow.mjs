import assert from 'node:assert/strict'
import { READING_SOURCES } from '../../src/reading-sources.js'

const QUOTE = 'A shortage of refining capacity can slow production even when mines are producing enough material.'
const NEWS = {
  title: 'Why battery makers are rethinking the supply chain',
  text: `Battery manufacturers are reconsidering where they process the minerals used in electric vehicles. ${QUOTE} Some manufacturers are financing plants closer to where they assemble their batteries.`,
}
const ENGINEERING = {
  title: 'Testing what happens after a failed deployment',
  text: 'A rollback can restore working code while leaving behind data created by a newer version. The team ran a synthetic release to see whether an older version could read the data written during a rollout.',
}
const IDEAS = {
  title: 'How software teams remember decisions',
  text: 'An architecture decision record can make trade-offs visible to people joining a project. It ages well when it names the assumptions behind the decision and sets a date for revisiting them.',
}
const PASTED_TEXT = 'A slow database query can hide behind a fast cache. When the cache expires, requests arrive together and the same query can overwhelm the database.'
const INTRO = 'The article follows battery materials from mining to refining and manufacturing. Refining is the step to watch: mining more material will not help if refineries cannot process it quickly enough.'
const QUESTION = 'Why can battery materials run short even if mines produce enough?'
const EXPLANATION = 'The minerals have to be refined before they can go into batteries. “Even when” shows that the shortage can happen despite a good supply from mines, because refineries can only process so much.'
const PASTE_REPLY = 'When the cache expires, all those requests reach the database at once. That is how one otherwise hidden slow query can become a bottleneck.'
const WEB_URL = 'https://reader.example.org/articles/rollbacks'
const WEB_TITLE = 'Preparing for a rollback'
const WEB_TEXT = 'A rollback can restore the previous application version, but it cannot reliably undo a database migration. Fields added during a release may still be present when an older application starts running again. Test both directions before relying on a rollback to restore service.'
const WEB_SECOND_PARAGRAPH = 'One useful rehearsal is to deploy the new version, write a fresh record and then return to the old version. Verify that the record is still readable and that any background jobs can continue safely.'
const WEB_CLOUD_TEXT = `${WEB_TEXT}\n\n${WEB_SECOND_PARAGRAPH}\n\nCloud parsing retains paragraphs.`

function rss({ title, text, url, publishedAt }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Reading workflow fixture</title><item>
      <title>${title}</title><link>${url}</link><pubDate>${new Date(publishedAt).toUTCString()}</pubDate>
      <description><![CDATA[<p>${text}</p>]]></description>
    </item></channel></rss>`
}

function atom({ title, text, url, publishedAt }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"><title>Reading workflow fixture</title><entry>
      <title>${title}</title><id>${url}</id><link href="${url}" rel="alternate"/>
      <published>${publishedAt}</published><summary type="html">&lt;p&gt;${text}&lt;/p&gt;</summary>
    </entry></feed>`
}

export async function installReadingFeeds(app) {
  const pages = { news: NEWS, engineering: ENGINEERING, ideas: IDEAS }
  const articles = {}
  const responses = {}
  for (const [category, sources] of Object.entries(READING_SOURCES)) {
    for (const [index, source] of sources.entries()) {
      const article = {
        ...pages[category],
        source: source.name,
        title: index ? `${pages[category].title}: a second perspective` : pages[category].title,
        publishedAt: new Date(Math.floor(Date.now() / 1000) * 1000 - (index + 1) * 3600000).toISOString(),
        url: `https://${source.hosts[0]}/articles/reading-workflow-fixture-${index}`,
      }
      if (index === 0) articles[category] = article
      const useAtom = /atom|theverge/u.test(source.url)
      responses[source.url] = {
        body: useAtom ? atom(article) : rss(article),
        type: useAtom ? 'application/atom+xml' : 'application/rss+xml',
        failFirst: category === 'ideas' && index === 1,
      }
    }
  }
  await app.evaluate(({ session, net }, { feeds, cloudText, cloudTitle }) => {
    session.defaultSession.protocol.handle('https', async (request) => {
      if (request.url === 'https://cloud-iqs.aliyuncs.com/readpage/scrape') {
        const key = request.headers.get('X-API-Key')
        if (key === 'iqs-invalid-test-key') {
          return Response.json({ errorCode: 'InvalidAccessKeyId.NotFound' }, { status: 403 })
        }
        if (key !== 'iqs-mock-key') throw new Error('Unexpected IQS test key')
        const input = await request.json()
        return Response.json({ data: { statusCode: 200, text: cloudText, metadata: { title: cloudTitle, url: input.url } } })
      }
      const feed = feeds[request.url]
      if (!feed) return net.fetch(request, { bypassCustomProtocolHandlers: true })
      if (feed.failFirst) {
        feed.failFirst = false
        return new Response(null, { status: 503 })
      }
      return new Response(feed.body, { headers: { 'Content-Type': feed.type } })
    })
  }, { feeds: responses, cloudText: WEB_CLOUD_TEXT, cloudTitle: WEB_TITLE })
  await app.evaluate((_electron, { url, html }) => {
    const https = process.getBuiltinModule('node:https')
    const { Readable } = process.getBuiltinModule('node:stream')
    const originalGet = https.get
    https.get = (target, options, callback) => {
      if (target.href !== url) return originalGet(target, options, callback)
      const response = Object.assign(Readable.from([Buffer.from(html)]), {
        statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      })
      queueMicrotask(() => callback(response))
      return response
    }
  }, { url: WEB_URL, html: `<!doctype html><html><head><title>${WEB_TITLE}</title></head><body>
    <nav>Site navigation</nav><article><h1>${WEB_TITLE}</h1><p>${WEB_TEXT}</p>
    <p>${WEB_SECOND_PARAGRAPH}</p></article></body></html>` })
  return articles
}

export async function verifyReadingWorkflow({ page, mock, check, shot, readingFeeds }) {
  await check('English Coach: discover current articles, read and ask a follow-up', async () => {
    const inputs = []
    let releaseFollowup
    const followupGate = new Promise((resolve) => { releaseFollowup = resolve })
    mock.setHandler(async ({ body, res, defaultResponse }) => {
      if (!body.messages?.[0]?.content?.includes('Read an English article together')) {
        await defaultResponse({ body, res })
        return
      }
      const input = JSON.parse(body.messages.at(-1).content)
      inputs.push(input)
      if (input.question === QUESTION) await followupGate
      const reply = input.article.kind === 'pasted_text' ? PASTE_REPLY : input.question ? EXPLANATION : INTRO
      const content = JSON.stringify({ reply, quote: input.article.kind === 'pasted_text' ? '' : QUOTE, followups: [QUESTION] })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
    const articles = page.locator('#reading-articles')
    const detail = page.locator('#reading-detail')
    const thread = page.locator('#reading-thread')
    const translate = page.locator('#btn-translate-workspace')
    const tutor = page.locator('#btn-tutor-workspace')
    const selectArticle = (title) => articles.getByRole('button', { name: title, exact: false }).first().click()
    try {
      await tutor.click()
      assert.equal(await page.locator('#tutor-reading-mode').getAttribute('aria-pressed'), 'true')
      await articles.getByRole('button', { name: NEWS.title, exact: false }).first().waitFor()
      await page.locator('#reading-category-engineering').click()
      await selectArticle(ENGINEERING.title)
      assert.match(await detail.textContent(), new RegExp(ENGINEERING.title, 'u'))
      await page.locator('#reading-back').click()
      await page.locator('#reading-category-ideas').click()
      await articles.getByRole('button', { name: IDEAS.title, exact: false }).first().waitFor()
      const missingFeed = READING_SOURCES.ideas[1].name
      const partialStatus = page.getByText(`Couldn’t load ${missingFeed}.`, { exact: true })
      await partialStatus.waitFor()
      await page.locator('#reading-refresh').click()
      await articles.getByRole('button', { name: new RegExp(`${IDEAS.title}: a second perspective`, 'u') }).waitFor()
      assert.equal(await partialStatus.count(), 0)
      await page.locator('#reading-category-news').click()
      await selectArticle(NEWS.title)
      const news = readingFeeds.news
      const articleMetadata = await detail.textContent()
      assert.match(articleMetadata, new RegExp(NEWS.title, 'u'))
      assert.ok(articleMetadata.includes(news.source))
      assert.equal(await detail.locator('time').getAttribute('datetime'), news.publishedAt)
      assert.equal(await page.locator('#reading-original').getAttribute('href'), news.url)
      assert.equal(inputs.length, 0, 'browsing articles must not ask the learning model')

      await page.locator('#reading-start').click()
      await thread.getByText(INTRO, { exact: true }).waitFor()
      await thread.getByText(QUOTE, { exact: true }).waitFor()
      assert.deepEqual(inputs[0], {
        question: '',
        history: [],
        article: { ...news, kind: 'feed_excerpt' },
      })
      await shot?.(page, 'main-tutor-reading')

      await page.locator('#reading-question').fill(QUESTION)
      await page.locator('#reading-send').click()
      await page.getByText('English Coach is reading…', { exact: true }).waitFor()
      await page.locator('#reading-back').click()
      await selectArticle(NEWS.title)
      releaseFollowup()
      await thread.getByText(EXPLANATION, { exact: true }).waitFor()
      assert.equal(inputs[1].question, QUESTION)
      assert.deepEqual(inputs[1].history, [{ role: 'assistant', text: `${INTRO}\n${QUOTE}` }])
      assert.deepEqual(inputs[1].article, inputs[0].article)
      await translate.click()
      await tutor.click()
      assert.equal(await thread.getByText(EXPLANATION, { exact: true }).isVisible(), true)

      await page.locator('#reading-back').click()
      await page.locator('#reading-paste').click()
      await page.locator('#reading-paste-text').fill(PASTED_TEXT)
      await page.locator('#reading-paste-open').click()
      await page.locator('#reading-start').click()
      await thread.getByText(PASTE_REPLY, { exact: true }).waitFor()
      assert.equal(inputs[2].article.kind, 'pasted_text')
      assert.equal(inputs[2].article.text, PASTED_TEXT)
      assert.deepEqual(inputs[2].history, [], 'pasted material should start a fresh conversation')

      await page.locator('#reading-back').click()
      await page.locator('#reading-import').click()
      const importUrl = page.locator('#reading-import-url')
      const importArticle = page.getByRole('button', { name: 'Import article' })
      await importArticle.click()
      await page.getByText('Enter a public HTTPS article link.').waitFor()
      await importUrl.fill('this is not a URL')
      await importArticle.click()
      await page.getByText('Enter a public HTTPS article link.').waitFor()
      await importUrl.fill('http://reader.example.org/articles/rollbacks')
      await importArticle.click()
      await page.getByText('Enter a public HTTPS article link.').waitFor()
      await page.getByRole('button', { name: 'Paste text', exact: true }).waitFor()
      await importUrl.fill(`[Read this article](${WEB_URL})`)
      await importArticle.click()
      await detail.getByRole('heading', { name: WEB_TITLE }).waitFor()
      assert.equal(await detail.locator('.reading-preview[data-reading-selectable]').textContent(),
        `${WEB_TEXT}\n\n${WEB_SECOND_PARAGRAPH}`)
      assert.equal(await page.locator('#reading-original').getAttribute('href'), WEB_URL)
      assert.equal(inputs.length, 3, 'importing a webpage must not ask the learning model')
      await shot?.(page, 'main-tutor-web-article')
      await page.locator('#reading-start').click()
      await thread.getByText(INTRO, { exact: true }).waitFor()
      assert.equal(inputs[3].article.kind, 'web_article')
      assert.equal(inputs[3].article.text, `${WEB_TEXT}\n\n${WEB_SECOND_PARAGRAPH}`)
      assert.equal(inputs[3].article.url, WEB_URL)

      await page.locator('#reading-back').click()
      await page.locator('#reading-import').click()
      await page.locator('#reading-import-settings').click()
      assert.equal(await page.locator('#iqs-console-link').getAttribute('href'),
        'https://aisearch.aliyun.com/web-parsing?tab=docs&apiTab=scrape')
      await page.locator('#cfg-iqs-key').fill('iqs-invalid-test-key')
      await page.locator('#btn-save-web-import').click()
      await page.getByText('Web import settings saved.', { exact: true }).waitFor()
      await page.locator('#btn-close-settings').click()
      await importUrl.fill(WEB_URL)
      await importArticle.click()
      await page.locator('#reading-import-status').getByText('Alibaba Cloud rejected the IQS API key.', { exact: false }).waitFor()
      await shot?.(page, 'main-tutor-import-error')
      assert.equal(await importArticle.isEnabled(), true)
      await page.locator('#reading-import-settings').click()
      assert.equal(await page.locator('#cfg-iqs-key').inputValue(), 'iqs-invalid-test-key')
      assert.equal(await page.locator('#cfg-iqs-key').getAttribute('type'), 'password')
      await page.locator('#cfg-iqs-key').fill('iqs-mock-key')
      await page.locator('#btn-save-web-import').click()
      await page.waitForFunction(async () => (await chrome.storage.sync.get('desktop_iqs_api_key')).desktop_iqs_api_key === 'iqs-mock-key')
      await page.locator('#btn-close-settings').click()
      await importArticle.click()
      await detail.getByRole('heading', { name: WEB_TITLE }).waitFor()
      assert.equal(await detail.locator('.reading-preview').textContent(), WEB_CLOUD_TEXT)
      assert.equal(inputs.length, 4, 'cloud parsing must not ask the learning model')
      await page.locator('#reading-start').click()
      await thread.getByText(INTRO, { exact: true }).waitFor()
      assert.equal(inputs[4].article.text, WEB_CLOUD_TEXT)
      await page.locator('#reading-back').click()
      await selectArticle(NEWS.title)
      await page.locator('#reading-import-full').click()
      await detail.getByRole('heading', { name: WEB_TITLE }).waitFor()
      assert.equal(await detail.locator('.reading-preview').textContent(), WEB_CLOUD_TEXT)
      assert.equal(await page.locator('#reading-original').getAttribute('href'), news.url)
      assert.equal(inputs.length, 5, 'importing the full feed article must not ask the learning model')
    } finally {
      await page.evaluate(() => chrome.storage.sync.remove('desktop_iqs_api_key'))
      releaseFollowup()
      mock.resetHandler()
      await translate.click()
    }
  })
}
