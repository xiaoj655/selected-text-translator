import assert from 'node:assert/strict'

const FEED_NAME = 'Field Notes'
const FEED_URL = 'https://feeds.example.org/fieldnotes'
const ARTICLE_URL = 'https://fieldnotes.example.org/articles/night-count'
const ARTICLE_TITLE = 'What we heard while counting birds at night'
const ARTICLE_SUMMARY = 'A team of volunteers counted migrating birds by listening for their calls after dark.'
const ARTICLE_BODY = 'Two observers compared notes at the end of each shift. They marked uncertain calls separately so the final count would reflect what they could actually identify.'
const IMPORTED_BODY = 'The volunteers repeated the count the following night to check whether wind and rain had affected their observations. Both teams recorded what they heard before sharing their notes.'
const SECOND_TITLE = 'Preparing a notebook for the spring migration'

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel><title>${FEED_NAME}</title><link>https://fieldnotes.example.org/</link>
      <item><title>${ARTICLE_TITLE}</title><link>${ARTICLE_URL}</link>
        <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate>
        <description><![CDATA[<p>${ARTICLE_SUMMARY}</p>]]></description>
        <content:encoded><![CDATA[<p>${ARTICLE_SUMMARY}</p><p>${ARTICLE_BODY}</p>]]></content:encoded>
      </item>
      <item><title>${SECOND_TITLE}</title><link>https://fieldnotes.example.org/articles/spring-notebook</link>
        <pubDate>Fri, 13 Nov 2026 09:00:00 GMT</pubDate>
        <description><![CDATA[<p>Leaving room for the weather, location and time makes the notebook easier to use when the first birds arrive.</p>]]></description>
      </item>
    </channel>
  </rss>`

async function installCustomFeed(app) {
  await app.evaluate((_electron, { feedUrl, articleUrl, rss, articleHtml }) => {
    const https = process.getBuiltinModule('node:https')
    const { Readable } = process.getBuiltinModule('node:stream')
    const originalGet = https.get
    https.get = (target, options, callback) => {
      let statusCode = 200
      let headers = { 'content-type': 'application/rss+xml; charset=utf-8' }
      let body = rss
      if (target.href === `${feedUrl}/`) {
        statusCode = 301
        headers = { location: feedUrl }
        body = ''
      } else if (target.href === articleUrl) {
        headers = { 'content-type': 'text/html; charset=utf-8' }
        body = articleHtml
      } else if (target.href !== feedUrl) {
        return originalGet(target, options, callback)
      } else if (globalThis.__sttE2ECustomFeedUnavailable) {
        statusCode = 503
        body = ''
      }
      const response = Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers })
      queueMicrotask(() => callback(response))
      return response
    }
  }, {
    feedUrl: FEED_URL, articleUrl: ARTICLE_URL, rss: RSS,
    articleHtml: `<!doctype html><html><head><title>${ARTICLE_TITLE}</title></head><body>
      <article><h1>${ARTICLE_TITLE}</h1><p>${ARTICLE_SUMMARY}</p><p>${IMPORTED_BODY}</p></article></body></html>`,
  })
}

async function showMyFeeds(page) {
  await page.locator('#btn-tutor-workspace').click()
  await page.locator('#tutor-reading-mode').click()
  await page.locator('#reading-category-custom').click()
}

function feedArticle(page, title = ARTICLE_TITLE) {
  return page.locator('#reading-articles').getByRole('button', { name: title, exact: true })
}

export async function verifyCustomReadingFeeds({ app, page, check, shot, restart }) {
  await check('My feeds: add, read, refresh, restart and remove a subscription', async () => {
    await installCustomFeed(app)
    await page.reload()
    await showMyFeeds(page)

    const add = page.locator('#reading-feed-add')
    const input = page.locator('#reading-feed-url')
    const submit = page.locator('#reading-feed-submit')
    const status = page.locator('#reading-feed-status')
    await add.click()
    await input.fill('http://feeds.example.org/fieldnotes')
    await submit.click()
    await status.getByText(/public HTTPS feed URL/u).waitFor()
    await input.fill(`${FEED_URL}/`)
    await submit.click()
    await feedArticle(page).waitFor()
    const firstRow = feedArticle(page).locator('..')
    await firstRow.getByText(FEED_NAME, { exact: true }).waitFor()
    await firstRow.getByText(/words in feed/u).waitFor()
    await feedArticle(page, SECOND_TITLE).locator('..').getByText(/Summary only/u).waitFor()
    await shot?.(page, 'main-tutor-my-feeds')

    await add.click()
    await input.fill(FEED_URL)
    await submit.click()
    await status.getByText(/already (?:added|subscribed)/u).waitFor()
    await page.locator('#reading-back').click()
    assert.equal(await feedArticle(page).count(), 1)

    await app.evaluate(() => { globalThis.__sttE2ECustomFeedUnavailable = true })
    await page.locator('#reading-refresh').click()
    await page.getByText(`Showing previous results from ${FEED_NAME}.`, { exact: false }).waitFor()
    await feedArticle(page).click()
    const detail = page.locator('#reading-detail')
    await detail.getByText(ARTICLE_BODY, { exact: true }).waitFor()
    assert.equal(await detail.locator('#reading-original').getAttribute('href'), ARTICLE_URL)
    await detail.locator('#reading-import-full').click()
    await detail.getByText(IMPORTED_BODY, { exact: true }).waitFor()

    const restarted = await restart()
    await installCustomFeed(restarted.app)
    const current = restarted.page
    await showMyFeeds(current)
    await feedArticle(current).waitFor()
    await current.locator('#reading-feed-manage').click()
    const sources = current.locator('#reading-feed-sources')
    await sources.getByText(FEED_URL, { exact: true }).waitFor()
    const remove = sources.getByRole('button', { name: `Remove ${FEED_NAME}`, exact: true })
    await remove.click()
    await remove.waitFor({ state: 'detached' })
    await current.locator('#reading-back').click()
    assert.equal(await feedArticle(current).count(), 0)

    await current.locator('#reading-history').click()
    await current.locator('.reading-history-open').getByText(ARTICLE_TITLE, { exact: true }).waitFor()
  })
}
