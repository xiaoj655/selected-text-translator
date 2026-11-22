import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverReadingArticles, READING_SOURCES } from '../src/reading-sources.js'

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
