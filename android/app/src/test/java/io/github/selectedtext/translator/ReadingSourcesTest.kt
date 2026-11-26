package io.github.selectedtext.translator

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.parser.Parser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReadingSourcesTest {
    @Test
    fun iqsAcceptsNullErrorOnSuccessfulLongArticle() = runBlocking {
        val firstParagraph = "This example explains the author's argument in detail. ".repeat(1_100).trimEnd()
        val finalParagraph = "This final paragraph should remain available after the entire article is saved."
        val html = """
            <article><h1>Long essay</h1><p>$firstParagraph</p>
            <img src="figures/sketch.jpg" alt="Sketch"><p>$finalParagraph</p></article>
        """.trimIndent()
        val sourceUrl = publicArticleUrl("[Open the essay](https://example.com/long-essay)")
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(JSONObject().put("data", JSONObject()
                .put("statusCode", 200).put("errorMessage", JSONObject.NULL).put("html", html)
                .put("metadata", JSONObject().put("title", "Long essay"))).toString()))
            val importer = IqsArticleImporter(OkHttpClient.Builder().followRedirects(false).build(), server.url("/readpage/scrape"))
            val article = importer.fetch(sourceUrl, "test-iqs-key")
            assertEquals("Long essay", article.title)
            assertTrue(article.blocks.sumOf { it.text.length } > 50_000)
            assertEquals(ArticleImage("https://example.com/figures/sketch.jpg", "Sketch"),
                article.blocks.single { it.image != null }.image)
            assertEquals(finalParagraph, article.blocks.last().text)
            assertEquals(sourceUrl.toString(), article.sourceUrl)
            val request = server.takeRequest()
            assertEquals("test-iqs-key", request.getHeader("X-API-Key"))
            assertEquals(sourceUrl.toString(), JSONObject(request.body.readUtf8()).getString("url"))
        }
    }

    @Test
    fun feedDistinguishesFullContentFromAnExcerptAndKeepsOnlyPublicLinks() {
        val url = "https://example.org/feed.xml".toHttpUrl()
        val atom = Jsoup.parse("""
            <feed xmlns="http://www.w3.org/2005/Atom">
              <title>Example news</title>
              <entry><title>Most recent</title><link href="/first"/><updated>2026-11-24T00:00:00Z</updated>
                <summary type="html">Brief &amp; useful.</summary>
                <content type="html"><![CDATA[<p>A full body with enough public text to count as an article.
                This sentence completes the example.</p>
                <figure><picture><source data-srcset="illustrations/harbor.webp 1x">
                <img alt="Harbor" onerror="alert(1)"></picture><figcaption>A harbor at sunset.</figcaption></figure>
                <img src="https://127.0.0.1/private.jpg"><script>no</script>]]></content>
              </entry>
              <entry><title>Excerpt</title><link href="/second"/><updated>2026-11-23T00:00:00Z</updated>
                <summary>Only a short explanation.</summary>
              </entry>
              <entry><title>Private address</title><link href="https://127.0.0.1/article"/></entry>
            </feed>
        """.trimIndent(), url.toString(), Parser.xmlParser())
        val feed = parseFeed(atom, url, FeedSource("example", "Example news", url.toString()))
        assertEquals(listOf("Most recent", "Excerpt"), feed.articles.map { it.title })
        assertEquals("Brief & useful.", feed.articles.first().excerpt)
        assertEquals("https://example.org/first", feed.articles.first().url)
        assertTrue(feed.articles.first().hasFullText)
        val fullHtml = feed.articles.first().html.orEmpty()
        assertFalse(fullHtml.contains("<script>"))
        assertFalse(fullHtml.contains("onerror"))
        val blocks = extractArticle(Jsoup.parseBodyFragment(fullHtml, feed.articles.first().url), url.host).blocks
        assertEquals(ArticleImage("https://example.org/illustrations/harbor.webp", "Harbor"), blocks[1].image)
        assertEquals("A harbor at sunset.", blocks[2].text)
        assertEquals(3, blocks.size)
        assertFalse(feed.articles.last().hasFullText)
    }
}
