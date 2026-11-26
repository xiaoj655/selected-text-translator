import assert from 'node:assert/strict'
import catalog from '../../vendor/src/reading-source-catalog.json' with { type: 'json' }

const FEED_NAME = 'Field Notes'
const FEED_URL = 'https://feeds.example.org/fieldnotes'
const ARTICLE_URL = 'https://fieldnotes.example.org/articles/night-count'
const ARTICLE_TITLE = 'What we heard while counting birds at night'
const ARTICLE_SUMMARY = 'A team of volunteers counted migrating birds by listening for their calls after dark.'
const ARTICLE_BODY = 'Two observers compared notes at the end of each shift. They marked uncertain calls separately so the final count would reflect what they could actually identify.'
const ARTICLE_NOTES = Array.from({ length: 28 }, (_value, index) =>
  `Field note ${index + 1}. The observers wrote down the time and direction of every call before checking their notes together.`)
const RESUME_PARAGRAPH = ARTICLE_NOTES[19]
const IMPORTED_BODY = 'The volunteers repeated the count the following night to check whether wind and rain had affected their observations. Both teams recorded what they heard before sharing their notes.'
const SECOND_TITLE = 'Preparing a notebook for the spring migration'
const CLAUDE = catalog.optional.find(({ id }) => id === 'claude')
const CLAUDE_TITLE = 'Getting started with Claude'

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel><title>${FEED_NAME}</title><link>https://fieldnotes.example.org/</link>
      <item><title>${ARTICLE_TITLE}</title><link>${ARTICLE_URL}</link>
        <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate>
        <description><![CDATA[<p>${ARTICLE_SUMMARY}</p>]]></description>
        <content:encoded><![CDATA[${[ARTICLE_SUMMARY, ARTICLE_BODY, ...ARTICLE_NOTES].map((paragraph) => `<p>${paragraph}</p>`).join('')}]]></content:encoded>
      </item>
      <item><title>${SECOND_TITLE}</title><link>https://fieldnotes.example.org/articles/spring-notebook</link>
        <pubDate>Fri, 13 Nov 2026 09:00:00 GMT</pubDate>
        <description><![CDATA[<p>Leaving room for the weather, location and time makes the notebook easier to use when the first birds arrive.</p>]]></description>
      </item>
    </channel>
  </rss>`

async function installCustomFeed(app) {
  await app.evaluate((_electron, { feedUrl, articleUrl, rss, articleHtml, claudeUrl, claudeRss }) => {
    const feeds = globalThis.__sttE2EReadingFeedResponses
    globalThis.__sttE2ECustomFeedResponses = feeds
    globalThis.__sttE2ECustomFeedUnavailable = false
    globalThis.__sttE2ECustomArticleUnavailable = false
    feeds[`${feedUrl}/`] = { redirectTo: feedUrl }
    feeds[feedUrl] = {
      body: rss,
      type: 'application/rss+xml; charset=utf-8',
      requests: 0,
      failureAttempts: [],
      failureFlag: '__sttE2ECustomFeedUnavailable',
    }
    feeds[claudeUrl] = {
      body: claudeRss,
      type: 'application/rss+xml; charset=utf-8',
      requests: 0,
      failureAttempts: [],
    }
    const https = process.getBuiltinModule('node:https')
    const { Readable } = process.getBuiltinModule('node:stream')
    const originalGet = https.get
    https.get = (target, options, callback) => {
      if (target.href !== articleUrl) {
        return originalGet(target, options, callback)
      }
      const unavailable = globalThis.__sttE2ECustomArticleUnavailable
      const response = Object.assign(Readable.from(unavailable ? [] : [Buffer.from(articleHtml)]), {
        statusCode: unavailable ? 503 : 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
      queueMicrotask(() => callback(response))
      return response
    }
  }, {
    feedUrl: FEED_URL, articleUrl: ARTICLE_URL, rss: RSS,
    claudeUrl: CLAUDE.url,
    claudeRss: `<rss><channel><title>Claude</title><item><title>${CLAUDE_TITLE}</title>
      <link>https://${CLAUDE.hosts[0]}/resources/articles/getting-started</link></item></channel></rss>`,
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
    await input.fill('http://127.0.0.1/fieldnotes')
    await submit.click()
    await status.getByText(/public HTTP or HTTPS feed URL/u).waitFor()
    await input.fill(`${FEED_URL}/`)
    await submit.click()
    try {
      await feedArticle(page).waitFor({ timeout: 10000 })
    } catch (error) {
      const listStatus = await page.locator('.reading-list-status').first().textContent()
      const addStatus = await status.textContent()
      throw new Error(`${error.message} (list: ${listStatus}; add: ${addStatus})`)
    }
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

    await feedArticle(page, SECOND_TITLE).click()
    await page.locator('#reading-detail').getByRole('heading', { name: SECOND_TITLE }).waitFor()
    assert.equal(await page.evaluate(async (title) => (await window.sttDesktop.reading.history())
      .some((article) => article.title === title), SECOND_TITLE), false, 'opening a summary should not save it as a full article')
    await page.locator('#reading-back').click()

    await app.evaluate(() => { globalThis.__sttE2ECustomFeedUnavailable = true })
    await page.locator('#reading-refresh').click()
    await page.getByText(`Showing previous results from ${FEED_NAME}.`, { exact: false }).waitFor()
    await feedArticle(page).click()
    const detail = page.locator('#reading-detail')
    await detail.getByText(ARTICLE_BODY, { exact: true }).waitFor()
    assert.equal(await detail.locator('#reading-original').getAttribute('href'), ARTICLE_URL)
    const previousTop = await detail.getByText(RESUME_PARAGRAPH, { exact: true }).evaluate(async (paragraph) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const scroller = document.getElementById('tutor-workspace')
      scroller.scrollTop += paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120
      return scroller.scrollTop
    })
    assert.ok(previousTop > 0, 'the RSS article should scroll past its opening paragraphs')
    const progressSaved = await page.evaluate(async (url) => {
      const deadline = performance.now() + 8000
      while (performance.now() < deadline) {
        const entry = (await window.sttDesktop.reading.history()).find((article) => article.url === url)
        if (entry?.progress > 0.4) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return false
    }, ARTICLE_URL)
    assert.ok(progressSaved, 'the RSS position should reach reading history before restart')

    const restarted = await restart()
    await installCustomFeed(restarted.app)
    await restarted.app.evaluate(() => {
      globalThis.__sttE2ECustomFeedUnavailable = true
      globalThis.__sttE2ECustomArticleUnavailable = true
    })
    const current = restarted.page
    await showMyFeeds(current)
    await current.getByText(`Couldn’t load ${FEED_NAME}.`, { exact: false }).waitFor()
    await current.locator('#reading-feed-manage').click()
    const sources = current.locator('#reading-feed-sources')
    await sources.getByText(FEED_URL, { exact: true }).waitFor()
    const remove = sources.getByRole('button', { name: `Remove ${FEED_NAME}`, exact: true })
    await remove.click()
    await remove.waitFor({ state: 'detached' })
    await current.locator('#reading-back').click()
    assert.equal(await feedArticle(current).count(), 0)

    await current.locator('#reading-history').click()
    const historyRow = current.locator('.reading-history-item').filter({ hasText: ARTICLE_TITLE })
    await historyRow.getByText(/\d+% read/u).waitFor()
    await historyRow.getByRole('button', { name: ARTICLE_TITLE, exact: true }).click()
    const reopened = current.locator('#reading-detail')
    await reopened.getByText(ARTICLE_BODY, { exact: true }).waitFor()
    await reopened.getByText(RESUME_PARAGRAPH, { exact: true }).waitFor()
    const resumedTop = await reopened.getByText(RESUME_PARAGRAPH, { exact: true }).evaluate(async (paragraph) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return paragraph.getBoundingClientRect().top - document.getElementById('tutor-workspace').getBoundingClientRect().top
    })
    await shot?.(current, 'main-tutor-feed-resumed')
    assert.ok(Math.abs(resumedTop - 120) < 50, `History should restore the saved RSS paragraph near the top, got ${resumedTop}px`)

    await restarted.app.evaluate(() => { globalThis.__sttE2ECustomArticleUnavailable = false })
    await reopened.locator('#reading-import-full').click()
    await reopened.getByText(IMPORTED_BODY, { exact: true }).waitFor()
    const matching = await current.evaluate(async (url) => (await window.sttDesktop.reading.history())
      .filter((article) => article.url === url), ARTICLE_URL)
    assert.equal(matching.length, 1, 'the import should replace the RSS snapshot in history')
    assert.equal(matching[0].progress, 0, 'the new body should start at the beginning')
    await current.locator('#reading-back').click()

    await current.locator('#reading-category-custom').click()
    assert.equal(await feedArticle(current, CLAUDE_TITLE).count(), 0)
    const currentAdd = current.locator('#reading-feed-add')
    const claudePreset = current.locator('#reading-feed-preset-claude')
    await currentAdd.click()
    await shot?.(current, 'main-tutor-claude-preset')
    await claudePreset.click()
    await feedArticle(current, CLAUDE_TITLE).waitFor()
    await currentAdd.click()
    assert.equal(await claudePreset.count(), 0)
    await current.locator('#reading-back').click()
  })
}
