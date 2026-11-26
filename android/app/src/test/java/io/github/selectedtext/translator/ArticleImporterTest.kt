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
    fun `reads the requested Psyche story and skips recommendations and preloaded stories`() {
        val url = "https://psyche.co/notes-to-self/coming-home"
        val opening = "I am returning to the neighbourhood where I spent my childhood."
        val ending = "It will take a while to find my place in the familiar streets again."
        val document = Jsoup.parse("""
            <head><meta property="og:title" content="Coming home | Psyche Notes to Self"></head>
            <main>
              <div data-index="0">
                <h1>Coming home</h1>
                <div class="article-content text-copy">
                  <p>$opening</p>
                  <article class="group/card"><p>A recommended article with enough text to be mistaken for the main story.</p></article>
                  <figure><img src="/illustrations/home.jpg"></figure>
                  <p>$ending</p>
                </div>
              </div>
              <div data-index="1">
                <h1>A different story</h1>
                <div class="article-content text-copy"><p>${"Another article is loaded to enable continuous reading. ".repeat(5)}</p></div>
              </div>
            </main>
        """.trimIndent(), url)

        val article = extractArticle(document, "psyche.co")
        assertEquals("Coming home", article.title)
        assertEquals(listOf(
            ArticleBlock(opening),
            ArticleBlock("", image = ArticleImage("https://psyche.co/illustrations/home.jpg")),
            ArticleBlock(ending),
        ), article.blocks)
    }

    @Test
    fun `keeps public article images and captions in reading order`() {
        val url = "https://news.example.org/essays/story.html"
        val article = extractArticle(Jsoup.parse("""
            <article>
              <p>The opening paragraph introduces the subject of this article.</p>
              <figure>
                <img src="data:image/gif;base64,placeholder" data-src="../photos/ridge.jpg"
                     alt="North ridge" width="900" height="600">
                <figcaption>The ridge at sunrise.</figcaption>
              </figure>
              <picture>
                <source srcset="https://assets.example.org/w=640,q=80/trail.webp 640w, /large.webp 1280w">
                <img alt="Mountain trail">
              </picture>
              <p>Before <img srcset="http://assets.example.org/map.jpg 1x, //assets.example.org/map.webp 2x"> after.</p>
              <img src="https://assets.example.org/hidden.jpg" hidden>
              <img src="https://assets.example.org/pixel.gif" width="1" height="1">
              <img src="https://127.0.0.1/private.jpg">
            </article>
        """.trimIndent(), url), "news.example.org")

        assertEquals(listOf(
            ArticleBlock("The opening paragraph introduces the subject of this article."),
            ArticleBlock("", image = ArticleImage("https://news.example.org/photos/ridge.jpg", "North ridge", 1.5f)),
            ArticleBlock("The ridge at sunrise."),
            ArticleBlock("", image = ArticleImage("https://assets.example.org/w=640,q=80/trail.webp", "Mountain trail")),
            ArticleBlock("Before"),
            ArticleBlock("", image = ArticleImage("https://assets.example.org/map.webp")),
            ArticleBlock("after."),
        ), article.blocks)
    }

    @Test
    fun `restores the reading position after adding images to a saved article`() {
        val opening = ArticleBlock("Opening paragraph.")
        val current = ArticleBlock("The reader stopped at this paragraph.")
        val closing = ArticleBlock("Closing paragraph.")
        val image = ArticleBlock("", image = ArticleImage("https://news.example.org/figure.jpg"))
        val previous = ReadingArticle("saved", "Saved article", "https://news.example.org/story",
            listOf(opening, current, closing), position = ArticlePosition(2, 27))

        assertEquals(ArticlePosition(3, 27), positionWithImages(previous, listOf(opening, image, current, closing)))
        val edited = ArticleBlock("This paragraph changed on the original page.")
        assertEquals(ArticlePosition(3, 0), positionWithImages(previous, listOf(opening, image, edited, closing)))
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
