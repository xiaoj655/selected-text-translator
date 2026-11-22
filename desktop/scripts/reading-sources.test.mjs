import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReadingDiscovery, discoverReadingArticles, READING_SOURCES } from '../src/reading-sources.js'

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
  const source = READING_SOURCES.ideas.find(({ name }) => name === 'Simon Willison')
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title>Notes on writing software</title>
    <link rel="alternate" href="https://simonwillison.net/2026/Nov/23/notes/"/>
    <summary type="html">&lt;p&gt;A first paragraph.&lt;/p&gt;&lt;p&gt;The article continues.&lt;/p&gt;</summary>
  </entry></feed>`
  const result = await discoverReadingArticles('ideas', {
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
