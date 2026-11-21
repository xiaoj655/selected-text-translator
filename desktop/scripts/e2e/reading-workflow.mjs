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
const INTRO = '这篇报道把电池供应链拆成了开采、精炼和制造三个阶段。原文里最值得看的是精炼这一步，因为扩大采矿也可能解决不了精炼产能不足。'
const QUESTION = '文中为什么说矿够挖也会缺电池材料？'
const EXPLANATION = '矿石需要经过精炼才能用在电池里。这里的 even when 引出一个条件，即使矿石供应充足，精炼厂处理不过来，成品材料还是会短缺。'
const PASTE_REPLY = '这段讲的是缓存失效时，大量请求同时落到数据库上的问题。'

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
  await app.evaluate(({ session, net }, feeds) => {
    session.defaultSession.protocol.handle('https', (request) => {
      const feed = feeds[request.url]
      if (!feed) return net.fetch(request, { bypassCustomProtocolHandlers: true })
      if (feed.failFirst) {
        feed.failFirst = false
        return new Response(null, { status: 503 })
      }
      return new Response(feed.body, { headers: { 'Content-Type': feed.type } })
    })
  }, responses)
  return articles
}

export async function verifyReadingWorkflow({ page, mock, check, shot, readingFeeds }) {
  await check('AI teacher: discover current articles, read and ask a follow-up', async () => {
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
      const partialStatus = page.getByText(`暂时无法读取 ${missingFeed}。`, { exact: true })
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
      await page.getByText('老师正在阅读…', { exact: true }).waitFor()
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
    } finally {
      releaseFollowup()
      mock.resetHandler()
      await translate.click()
    }
  })
}
