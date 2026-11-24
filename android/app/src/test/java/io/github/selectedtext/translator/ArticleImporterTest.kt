package io.github.selectedtext.translator

import java.net.InetAddress
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.jsoup.Jsoup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ArticleImporterTest {
    @Test
    fun `recognizes browser shares and keeps meaningful URL punctuation`() {
        assertEquals("https://news.example.org/story?q=one",
            sharedArticleUrl("https://news.example.org/story?q=one#bottom"))
        assertEquals("https://news.example.org/a_(b)",
            sharedArticleUrl("An interesting story\n(https://news.example.org/a_(b))."))
        assertEquals("https://news.example.org/reading",
            sharedArticleUrl("[A reading list](HTTPS://news.example.org/reading)"))
        assertNull(sharedArticleUrl("Read https://news.example.org/story to keep going."))
        assertNull(sharedArticleUrl("https://news.example.org/a\nhttps://news.example.org/b"))
    }

    @Test
    fun `extracts headings and paragraph text from an article`() {
        val article = extractArticle(Jsoup.parse("""
            <html>
              <head><title>Publisher · A better way to read</title></head>
              <body>
                <nav>Home Topics Subscribe</nav>
                <main>
                  <article>
                    <h1>A better way to read</h1>
                    <p>A useful opening paragraph includes <em>one</em> inline element.</p>
                    <h2>The next part</h2>
                    <aside>Sponsored content</aside>
                    <p hidden>Hidden content.</p>
                    <p>The next paragraph uses a nonbreaking&nbsp;space.</p>
                  </article>
                </main>
                <footer>Contact</footer>
              </body>
            </html>
        """.trimIndent()), "news.example.org")

        assertEquals("A better way to read", article.title)
        assertEquals(listOf(
            ArticleBlock("A useful opening paragraph includes one inline element."),
            ArticleBlock("The next part", heading = true),
            ArticleBlock("The next paragraph uses a nonbreaking space."),
        ), article.blocks)
    }

    @Test
    fun `reads older table layouts and paragraph breaks`() {
        val article = extractArticle(Jsoup.parse("""
            <html>
              <head><title>An older essay</title></head>
              <body>
                <table><tr><td><font>
                  An older writing site uses tables to position the text.<br><br>
                  After two line breaks, the next paragraph continues.
                </font></td></tr></table>
              </body>
            </html>
        """.trimIndent()), "news.example.org")

        assertEquals("An older essay", article.title)
        assertEquals(listOf(
            ArticleBlock("An older writing site uses tables to position the text."),
            ArticleBlock("After two line breaks, the next paragraph continues."),
        ), article.blocks)
    }

    @Test
    fun `pasted text keeps its paragraphs and uses the first line as the default title`() {
        val article = pastedArticle("  The opening line.\r\n\r\n  Then it continues.  ")

        assertEquals("The opening line.", article.title)
        assertEquals(listOf(ArticleBlock("The opening line."), ArticleBlock("Then it continues.")), article.blocks)
        assertNull(article.sourceUrl)
        assertEquals(listOf(ArticleBlock("The opening line.")),
            pastedArticle("A title\n\nThe opening line.", "A title").blocks)
        assertThrows(ArticleImportException::class.java) { pastedArticle(" \n\t ") }
    }

    @Test
    fun `refuses a redirect that leaves public HTTPS before making another request`() {
        val requests = mutableListOf<String>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            requests.add(request.url.toString())
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(302).message("Found")
                .header("Location", "http://news.example.org/article")
                .body("".toResponseBody()).build()
        }.build()

        assertThrows(ArticleImportException::class.java) {
            runBlocking { ArticleImporter(client).fetch("https://news.example.org/article") }
        }
        assertEquals(listOf("https://news.example.org/article"), requests)
    }

    @Test
    fun `allows public addresses and filters local and special-use destinations`() {
        fun check(address: String) = isPublicArticleAddress(InetAddress.getByName(address))

        assertTrue(check("8.8.8.8"))
        assertTrue(check("2606:4700:4700::1111"))
        for (address in listOf("127.0.0.1", "100.64.0.8", "169.254.0.1", "192.168.1.1",
            "198.18.0.1", "::1", "::ffff:192.168.0.1", "fc00::1", "fe80::1", "2001:db8::1")) {
            assertFalse(address, check(address))
        }
        for (link in listOf("https://192.168.1.1", "https://localhost", "https://any.home.arpa",
            "https://news.example.org:444", "https://someone@news.example.org", "http://news.example.org")) {
            assertThrows(link, ArticleImportException::class.java) { publicArticleUrl(link) }
        }
    }
}
