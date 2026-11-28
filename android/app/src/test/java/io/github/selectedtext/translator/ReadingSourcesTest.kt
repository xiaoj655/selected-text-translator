package io.github.selectedtext.translator

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
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
            <head><meta name="referrer" content="same-origin"></head>
            <main>
              <article><h1>Long essay</h1><p>$firstParagraph</p>
              <img src="figures/sketch.jpg" alt="Sketch" referrerpolicy="no-referrer"></article>
              <section><p>$finalParagraph</p></section>
            </main>
        """.trimIndent()
        val sourceUrl = publicArticleUrl("[Open the essay](https://example.com/long-essay)")
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(JSONObject().put("data", JSONObject()
                .put("statusCode", 200).put("errorMessage", JSONObject.NULL).put("html", html)
                .put("redirectedUrl", "https://publisher.example.org/long-essay")
                .put("metadata", JSONObject().put("title", "Long essay"))).toString()))
            val importer = IqsArticleImporter(OkHttpClient.Builder().followRedirects(false).build(), server.url("/readpage/scrape"))
            val article = importer.fetch(sourceUrl, "test-iqs-key")
            assertEquals("Long essay", article.title)
            assertTrue(article.blocks.sumOf { it.text.length } > 50_000)
            assertEquals(ArticleImage("https://publisher.example.org/figures/sketch.jpg", "Sketch",
                referrerPolicy = ImageReferrerPolicy.NONE),
                article.blocks.single { it.image != null }.image)
            assertEquals(finalParagraph, article.blocks.last().text)
            assertEquals(sourceUrl.toString(), article.sourceUrl)
            assertEquals("https://publisher.example.org/", article.mediaSourceOrigin)
            val request = server.takeRequest()
            assertEquals("test-iqs-key", request.getHeader("X-API-Key"))
            assertEquals(sourceUrl.toString(), JSONObject(request.body.readUtf8()).getString("url"))
        }
    }

    @Test
    fun iqsDoesNotSaveAPsycheRecommendationAsText() = runBlocking {
        val recommendation = "This paragraph is a preview of a different story recommended by the publisher."
        val html = "<article class=\"group/card\"><p>$recommendation</p></article>"
        val sourceUrl = publicArticleUrl("https://psyche.co/ideas/published-story")
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(JSONObject().put("data", JSONObject()
                .put("statusCode", 200).put("html", html).put("text", recommendation)).toString()))
            val importer = IqsArticleImporter(OkHttpClient(), server.url("/readpage/scrape"))
            val failure = runCatching { importer.fetch(sourceUrl, "test-iqs-key") }.exceptionOrNull()
            assertTrue(failure is IqsImportException)
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
                <content type="html"><![CDATA[<meta name="referrer" content="same-origin">
                <p>A full body with enough public text to count as an article.
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
        assertEquals(ArticleImage("https://example.org/illustrations/harbor.webp", "Harbor",
            referrerPolicy = ImageReferrerPolicy.SAME_ORIGIN), blocks[1].image)
        assertEquals("A harbor at sunset.", blocks[2].text)
        assertEquals(3, blocks.size)
        assertFalse(feed.articles.last().hasFullText)
    }

    @Test
    fun feedRetainsResponsePolicyAndDoesNotClaimAnotherPublishersOrigin() = runBlocking {
        val initial = "https://links.example.org/feed.xml"
        val final = "https://news.example.org/feed.xml"
        val articleHtml = """
            <p>This full article contains a photo and enough prose for it to be imported into the reading workspace.</p>
            <img src="https://images.example.org/photo.png" referrerpolicy="origin">
        """.trimIndent()
        val xml = """
            <rss version="2.0"><channel><title>News feed</title>
              <item><title>Local story</title><link>https://news.example.org/local</link>
                <content><![CDATA[$articleHtml]]></content></item>
              <item><title>Outside story</title><link>https://links.example.org/outside</link>
                <content><![CDATA[$articleHtml]]></content></item>
            </channel></rss>
        """.trimIndent()
        val client = OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
            val request = chain.request()
            val response = Response.Builder().request(request).protocol(Protocol.HTTP_1_1).message("Fixture")
            if (request.url.toString() == initial) {
                response.code(302).header("Location", final).body("".toResponseBody()).build()
            } else {
                response.code(200).header("Referrer-Policy", "same-origin")
                    .body(xml.toResponseBody("application/rss+xml".toMediaType())).build()
            }
        }.build()
        val articles = FeedClient(client).fetch(FeedSource("news", "News", initial)).articles
        val policies = articles.associate { article ->
            val body = Jsoup.parseBodyFragment(article.html.orEmpty(), article.url)
            article.title to extractArticle(body, "news.example.org").blocks.single { it.image != null }.image?.referrerPolicy
        }
        assertEquals(mapOf("Local story" to ImageReferrerPolicy.SAME_ORIGIN,
            "Outside story" to ImageReferrerPolicy.NONE), policies)
    }
}
