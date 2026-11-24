import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createReadingDiscovery, discoverReadingArticles, READING_SOURCES } from '../src/reading-sources.js'
import { createStorage } from '../src/storage.js'

test('article discovery preserves full plain text and sanitized feed formatting', async () => {
  const [ars, verge] = READING_SOURCES.news
  const body = `An opening paragraph with a <em>nearly seamless</em> quote. ${'Longer text. '.repeat(1000)}`
  const rss = `<rss><channel><item>
    <title>First &amp; second</title>
    <link>https://${ars.hosts[0]}/first?x=1&amp;y=2</link>
    <pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate>
    <description>A short description.</description>
    <content:encoded><![CDATA[<p>${body}</p><p>Another paragraph.</p><script>ignore this.</script>]]></content:encoded>
  </item></channel></rss>`
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title type="html"><![CDATA[What&rsquo;s new]]></title>
    <link rel="self" href="https://${verge.hosts[0]}/feed"/>
    <link href='https://${verge.hosts[0]}/new' rel='alternate'/>
    <published>2026-11-20T12:30:00Z</published><updated>2026-11-21T00:00:00Z</updated>
    <summary type="html">A &lt;b&gt;thoughtful&lt;/b&gt; summary.</summary>
  </entry></feed>`
  const result = await discoverReadingArticles('news', {
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error')
      assert.equal(options.credentials, 'omit')
      assert.ok(options.signal instanceof AbortSignal)
      return new Response(url === ars.url ? rss : atom)
    },
  })
  assert.deepEqual(result.unavailableSources, [])
  const [newest, first] = result.articles
  assert.deepEqual([newest.title, newest.publishedAt, newest.excerpt, newest.url], [
    'What’s new', '2026-11-20T12:30:00.000Z', 'A thoughtful summary.', `https://${verge.hosts[0]}/new`,
  ])
  assert.equal(first.title, 'First & second')
  assert.equal(first.url, `https://${ars.hosts[0]}/first?x=1&y=2`)
  assert.equal(first.excerpt, 'A short description.')
  assert.equal(first.feedHasBody, true)
  assert.equal(newest.feedHasBody, false)
  assert.match(first.text, /^An opening paragraph with a nearly seamless quote\./)
  assert.doesNotMatch(first.text, /<em>/)
  assert.ok(first.text.length > 12000)
  assert.match(first.text, /Another paragraph\.$/u)
  assert.match(first.html, /<em>nearly seamless<\/em>/u)
  assert.doesNotMatch(first.html, /script|ignore this/u)
})

test('discovery retains working sources and rejects links outside the publisher', async () => {
  const [ars, verge] = READING_SOURCES.news
  const article = (link) => `<item><title>An article</title><link>${link}</link><description>
    <![CDATA[<p>Original summary.</p><item><title>Confusing markup</title></item><script>ignore this.</script>]]>
    </description></item>`
  const canonicalUrl = `https://${ars.hosts[0]}/reading`
  let requested = []
  const result = await discoverReadingArticles('news', {
    fetchImpl: async (url) => {
      requested.push(url)
      if (url === verge.url) return new Response(null, { status: 503 })
      return new Response(`<rss><channel>
        ${article(canonicalUrl)}${article(`${canonicalUrl}#fragment`)}
        ${article('https://different-publisher.test/example')}
        ${article(`https://${ars.hosts[0]}@different-publisher.test/example`)}
        ${article(`http://${ars.hosts[0]}/not-https`)}
      </channel></rss>`)
    },
  })
  assert.deepEqual(requested, [ars.url, verge.url])
  assert.deepEqual(result.unavailableSources, [verge.name])
  assert.deepEqual(result.articles.map((entry) => entry.url), [canonicalUrl])
  assert.equal(result.articles[0].excerpt, 'Original summary. Confusing markup')

  requested = []
  await assert.rejects(discoverReadingArticles('constructor', { fetchImpl: (url) => requested.push(url) }))
  assert.deepEqual(requested, [])
})

test('RSS discovery reads HTML documents with publisher footers and skips empty material', async () => {
  const source = READING_SOURCES.engineering[0]
  const rss = `<rss><channel>
    <item>
      <title>Engineering notes</title>
      <link>https://${source.hosts[0]}/article</link>
      <description>A short summary.</description>
      <content:encoded><![CDATA[<!DOCTYPE html><html><body>
        <p>An opening paragraph about engineering and a <strong>notable detail.</strong></p>
      </body></html><p>A publisher footer.</p>]]></content:encoded>
    </item>
    <item>
      <title>Empty body</title>
      <link>https://${source.hosts[0]}/empty</link>
      <description><![CDATA[<template>This should never be shown.</template>]]></description>
    </item>
    <item>
      <title>Repeated summary</title>
      <link>https://${source.hosts[0]}/summary</link>
      <description>A plain summary.</description>
      <content:encoded><![CDATA[<p>A plain</p><p>summary.</p>]]></content:encoded>
    </item>
  </channel></rss>`
  const result = await discoverReadingArticles('engineering', {
    fetchImpl: async (url) => url === source.url ? new Response(rss) : new Response(null, { status: 503 }),
  })
  assert.ok(!result.unavailableSources.includes(source.name))
  const [article, summary] = result.articles
  assert.equal(result.articles.length, 2)
  assert.equal(article.feedHasBody, true)
  assert.match(article.html, /<strong>notable detail.<\/strong>/u)
  assert.match(article.text, /\n\nA publisher footer\.$/u)
  assert.equal(summary.feedHasBody, false)
  assert.equal(summary.text, 'A plain summary.')
})

test('Simon Willison provides reading material in the Atom summary field', async () => {
  const source = READING_SOURCES.engineering.find(({ name }) => name === 'Simon Willison')
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title>Notes on writing software</title>
    <link rel="alternate" href="https://simonwillison.net/2026/Nov/23/notes/"/>
    <summary type="html">&lt;p&gt;A first paragraph.&lt;/p&gt;&lt;p&gt;The article continues.&lt;/p&gt;</summary>
  </entry></feed>`
  const result = await discoverReadingArticles('engineering', {
    fetchImpl: async (url) => url === source.url ? new Response(atom) : new Response(null, { status: 503 }),
  })
  assert.equal(result.articles[0].feedHasBody, true)
  assert.equal(result.articles[0].text, 'A first paragraph.\n\nThe article continues.')
})

test('a refresh keeps eight latest articles per source and reuses old entries on partial or total failure', async () => {
  const [ars, verge] = READING_SOURCES.news
  let refreshCount = 0
  let requests = 0
  const rss = (source) => `<rss><channel>${Array.from({ length: 10 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0')
    return `<item>
      <title>${source.name} ${refreshCount}-${index}</title>
      <link>https://${source.hosts[0]}/${refreshCount}/${index}</link>
      <pubDate>2026-11-${day}T12:00:00Z</pubDate>
      <description>An article description.</description>
    </item>`
  }).join('')}</channel></rss>`
  const discovery = createReadingDiscovery({
    fetchImpl: async (url) => {
      requests += 1
      if (refreshCount === 2 || (refreshCount === 1 && url === ars.url)) {
        return new Response(null, { status: 503 })
      }
      return new Response(rss(url === ars.url ? ars : verge))
    },
  })
  const [initial, sameRefresh] = await Promise.all([discovery.discover('news'), discovery.discover('news')])
  assert.equal(requests, 2)
  assert.deepEqual(initial, sameRefresh)
  assert.equal(initial.articles.length, 16)
  assert.deepEqual(initial.staleSources, [])
  const oldArs = initial.articles.filter(({ source }) => source === ars.name)
  const oldVerge = initial.articles.find(({ source }) => source === verge.name)
  assert.deepEqual(oldArs.map(({ title }) => title), Array.from({ length: 8 }, (_, index) => `${ars.name} 0-${9 - index}`))

  refreshCount = 1
  const partial = await discovery.discover('news')
  assert.equal(partial.articles.length, 16)
  assert.deepEqual(partial.unavailableSources, [ars.name])
  assert.deepEqual(partial.staleSources, [ars.name])
  assert.deepEqual(partial.articles.filter(({ source }) => source === ars.name), oldArs)
  assert.equal(discovery.getArticle(oldArs[0].id), oldArs[0])
  assert.equal(discovery.getArticle(oldVerge.id), undefined)
  assert.ok(partial.articles.some(({ title }) => title === `${verge.name} 1-9`))

  refreshCount = 2
  const totalFailure = await discovery.discover('news')
  assert.deepEqual(totalFailure.articles, partial.articles)
  assert.deepEqual(totalFailure.unavailableSources, [ars.name, verge.name])
  assert.deepEqual(totalFailure.staleSources, [ars.name, verge.name])

  refreshCount = 3
  const recovered = await discovery.discover('news')
  assert.deepEqual(recovered.unavailableSources, [])
  assert.deepEqual(recovered.staleSources, [])
  assert.ok(recovered.articles.every(({ title }) => title.includes('3-')))
})

function feedResponse(url, xml, statusCode = 200) {
  const response = Readable.from([Buffer.from(xml)])
  response.statusCode = statusCode
  response.headers = { 'content-type': 'application/xml; charset=UTF-8' }
  return { url: new URL(url), response }
}

test('custom subscriptions use the redirected URL, reuse the initial response, and survive restart', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'stt-rss-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const typed = 'https://rss.reader-sample.com/redirect#feed'
  const canonical = 'https://rss.reader-sample.com/blog/feed.xml'
  const xml = `<rss><channel>
    <!-- <title>Ignore this</title> -->
    <title><![CDATA[News &amp; notes]]></title>
    <item><title>A headline</title><link>posts/one#top</link></item>
    <item><title>A full article</title><link>https://reader-sample.com/two</link>
      <pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>This is <em>readable</em> text.</p><script>ignore me</script>]]></content:encoded>
    </item>
    <item><title>Private article</title><link>https://127.0.0.1/local</link></item>
  </channel></rss>`
  const requested = []
  const openResource = async (url, options) => {
    requested.push(url)
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.headers.Cookie, undefined)
    return feedResponse(canonical, xml)
  }
  const discovery = createReadingDiscovery({ storage: createStorage(profile), openResource })
  const added = await discovery.addFeed(typed)
  assert.deepEqual(requested, ['https://rss.reader-sample.com/redirect'])
  const [source] = added.sources
  assert.deepEqual({ name: source.name, url: source.url }, { name: 'News & notes', url: canonical })
  assert.deepEqual(added.articles.map(({ title }) => title), ['A full article', 'A headline'])
  assert.match(added.articles[0].html, /<em>readable<\/em>/)
  assert.doesNotMatch(added.articles[0].html, /ignore me/)
  assert.equal(added.articles[1].url, 'https://rss.reader-sample.com/blog/posts/one')
  assert.equal(added.articles[1].text, '')
  assert.match(added.articles[0].id, /^custom-feed-[a-f0-9]{64}$/)
  assert.equal(discovery.getArticle(added.articles[0].id)?.title, 'A full article')
  await assert.rejects(discovery.addFeed(canonical), /already added/)
  assert.equal(requested.length, 1)
  await assert.rejects(discovery.addFeed(typed), /already added/)
  assert.equal(requested.length, 2)

  const restarted = createReadingDiscovery({ storage: createStorage(profile), openResource })
  assert.deepEqual(await restarted.discover('custom'), added)
  assert.equal(requested.at(-1), canonical)
  const removed = await restarted.removeFeed(source.id)
  assert.deepEqual(removed.sources, [])
  assert.deepEqual(removed.articles, [])
  assert.equal(restarted.getArticle(added.articles[0].id), undefined)
  assert.deepEqual(await createReadingDiscovery({ storage: createStorage(profile), openResource }).discover('custom'), removed)
})

test('custom refresh keeps prior articles on failure, deduplicates links, and cannot restore a removed subscription', async () => {
  const first = 'https://reader-one.com/feed.xml'
  const second = 'https://reader-two.com/feed.xml'
  const xml = (name) => `<feed xmlns="http://www.w3.org/2005/Atom"><title>${name}</title>
    <entry><title>A shared article</title><link href="https://reader-sample.com/shared" />
    <summary>Article text.</summary></entry></feed>`
  let mode = 'ready'
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const discovery = createReadingDiscovery({ openResource: async (url) => {
    if (url === first && mode === 'pending') {
      started.resolve()
      await finish.promise
    }
    if (url === first && mode !== 'ready') return feedResponse(url, '', 503)
    return feedResponse(url, xml(url === first ? 'First' : 'Second'))
  } })
  const [one, two] = await Promise.all([discovery.addFeed(first), discovery.addFeed(second)])
  const source = [...one.sources, ...two.sources].find(({ url }) => url === first)
  mode = 'failure'
  const stale = await discovery.discover('custom')
  assert.equal(stale.sources.length, 2)
  assert.equal(stale.articles.length, 1)
  assert.equal(discovery.getArticle(stale.articles[0].id), stale.articles[0])
  assert.deepEqual(stale.unavailableSources, ['First'])
  assert.deepEqual(stale.staleSources, ['First'])
  assert.match(stale.sourceErrors[source.id], /HTTP 503/)

  mode = 'pending'
  const refresh = discovery.discover('custom')
  await started.promise
  const removed = await discovery.removeFeed(source.id)
  assert.deepEqual(removed.sources.map(({ name }) => name), ['Second'])
  finish.resolve()
  assert.deepEqual(await refresh, removed)
})

test('custom source addition rejects invalid URLs and non-feed pages, and accepts a valid empty Atom feed', async () => {
  const empty = 'https://rss.reader-sample.com/empty.xml'
  const requests = []
  const discovery = createReadingDiscovery({ openResource: async (url) => {
    requests.push(url)
    return feedResponse(url, url === empty
      ? '<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>'
      : '<html><body><rss><channel><title>Nested</title></channel></rss></body></html>')
  } })
  await assert.rejects(discovery.addFeed('http://rss.reader-sample.com/feed'), /public HTTPS/)
  await assert.rejects(discovery.addFeed('https://192.168.0.1/feed'), /public HTTPS/)
  assert.equal(requests.length, 0)
  await assert.rejects(discovery.addFeed('https://rss.reader-sample.com/'), /did not return an RSS or Atom feed/)
  const result = await discovery.addFeed(empty)
  assert.equal(result.sources[0].name, 'Empty')
  assert.deepEqual(result.articles, [])
  assert.deepEqual(result.unavailableSources, [])
})

test('simultaneous aliases of the same source save only one subscription', async () => {
  const canonical = 'https://rss.reader-sample.com/feed'
  const discovery = createReadingDiscovery({ openResource: async () => feedResponse(canonical, '<feed/>') })
  const results = await Promise.allSettled([discovery.addFeed(`${canonical}/`), discovery.addFeed(canonical)])
  const added = results.filter(({ status }) => status === 'fulfilled')
  const rejected = results.filter(({ status }) => status === 'rejected')
  assert.equal(added.length, 1)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason.message, /already added/)
  assert.deepEqual(await discovery.discover('custom'), added[0].value)
})
