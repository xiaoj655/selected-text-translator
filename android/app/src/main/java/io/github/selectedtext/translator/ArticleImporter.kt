package io.github.selectedtext.translator

import java.io.IOException
import java.io.InterruptedIOException
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.NodeTraversor
import org.jsoup.select.NodeVisitor

internal class ArticleImporter(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> =
                // OkHttp uses these same checked addresses for its sockets.
                Dns.SYSTEM.lookup(hostname).filter(::isPublicArticleAddress).ifEmpty {
                    throw UnknownHostException("This page resolves to a private network.")
                }
        })
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .build(),
) {
    suspend fun fetch(value: String): ReadingArticle = withTimeoutOrNull(25_000L) {
        val original = publicArticleUrl(value)
        var url = original
        repeat(MAX_REDIRECTS + 1) {
            val page = request(url)
            if (page is Page.Content) return@withTimeoutOrNull page.article.copy(sourceUrl = original.toString())
            val redirect = (page as Page.Redirect).location
            url = publicArticleUrl(url.resolve(redirect)?.toString().orEmpty())
        }
        throw ArticleImportException("This page redirects too many times. Try its final link.")
    } ?: throw ArticleImportException("This page took too long to load. Try again or paste the article text.")

    private suspend fun request(url: HttpUrl): Page = suspendCancellableCoroutine { continuation ->
        val request = Request.Builder().url(url)
            .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9")
            .header("User-Agent", "Selected Article Reader (Android)")
            .build()
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resumeWith(Result.failure(networkError(e)))
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resumeWith(runCatching { response.use { readPage(it, url) } }
                    .recoverCatching { error -> throw if (error is IOException) networkError(error) else error })
            }
        })
    }

    private fun readPage(response: Response, url: HttpUrl): Page {
        if (response.code in REDIRECT_CODES) {
            val location = response.header("Location") ?: throw ArticleImportException("This page has an invalid redirect.")
            return Page.Redirect(location)
        }
        if (!response.isSuccessful) {
            throw ArticleImportException("This site returned HTTP ${response.code}. Open the page in your browser or paste the text.")
        }
        val body = response.body ?: throw noArticleText()
        val type = body.contentType()
        val plainText = type?.type == "text" && type.subtype == "plain"
        val html = type == null || type.type == "text" && type.subtype == "html" ||
            type.type == "application" && type.subtype == "xhtml+xml"
        if (!plainText && !html) throw ArticleImportException("Open a web article or paste its text to read it here.")
        val source = body.source()
        if (body.contentLength() > MAX_PAGE_BYTES || source.request(MAX_PAGE_BYTES + 1L)) {
            throw ArticleImportException("This page is too large to import. Paste the article text instead.")
        }
        val bytes = source.readByteArray()
        val article = if (plainText) {
            pastedArticle(bytes.toString(type.charset(Charsets.UTF_8) ?: Charsets.UTF_8), url.host)
        } else {
            val document = Jsoup.parse(bytes.inputStream(), type?.charset()?.name(), url.toString())
            extractArticle(document, url.host)
        }
        return Page.Content(article)
    }

    private sealed interface Page {
        data class Content(val article: ReadingArticle) : Page
        data class Redirect(val location: String) : Page
    }
}

internal class ArticleImportException(message: String, cause: Throwable? = null) : IOException(message, cause)

internal fun publicArticleUrl(value: String): HttpUrl {
    val url = value.trim().takeIf { it.length <= 4096 && it.startsWith("https://", ignoreCase = true) }
        ?.toHttpUrlOrNull()
    val host = url?.host?.trimEnd('.').orEmpty()
    if (url == null || url.port != 443 || url.username.isNotEmpty() || url.password.isNotEmpty() ||
        '.' !in host || ':' in host || host.last().isDigit() || host == "localhost" ||
        LOCAL_HOST_SUFFIXES.any(host::endsWith)
    ) throw ArticleImportException("Enter a public HTTPS article link.")
    return url.newBuilder().fragment(null).build()
}

internal fun sharedArticleUrl(text: String): String? {
    if (text.length > MAX_SHARED_LINK_TEXT) return null
    val links = SHARED_LINK.findAll(text).take(2).toList()
    val last = links.singleOrNull() ?: return null
    if (text.substring(last.range.last + 1).trim().trimEnd('>', '"', '\'').isNotEmpty()) return null
    var url = last.value.trimEnd('.', ',', ';', '!', '"', '\'', '>', '。', '，', '！')
    for ((open, close) in listOf('(' to ')', '[' to ']', '{' to '}')) {
        while (url.endsWith(close) && url.count { it == close } > url.count { it == open }) {
            url = url.dropLast(1)
        }
    }
    return runCatching { publicArticleUrl(url).toString() }.getOrNull()
}

internal fun pastedArticle(text: String, title: String = ""): ReadingArticle {
    if (text.length > MAX_ARTICLE_TEXT) throw articleTooLong()
    val blocks = text.lineSequence().map(String::trim).filter(String::isNotEmpty)
        .flatMap { block -> splitArticleBlock(block).asSequence() }
        .map { ArticleBlock(it) }.toList()
    if (blocks.isEmpty()) throw ArticleImportException("Paste some article text to get started.")
    val suppliedTitle = title.trim()
    val resolvedTitle = suppliedTitle.ifBlank { abbreviatedTitle(blocks.first().text) }
    val body = if (blocks.size > 1 && blocks.first().text == suppliedTitle) blocks.drop(1) else blocks
    return ReadingArticle("", resolvedTitle.take(MAX_TITLE_LENGTH), null, body)
}

internal fun extractArticle(document: Document, host: String): ReadingArticle {
    val body = document.body()
    body.select(UNREADABLE_ELEMENTS).remove()
    val main = body.select("main,[role=main]").maxByOrNull(::contentScore) ?: body
    val article = main.select("article,[itemprop=articleBody]").map { it to contentScore(it) }.maxByOrNull { it.second }
    val content = article?.takeIf { it.second >= MIN_READABLE_TEXT }?.first ?: main
    val title = sequenceOf(
        content.selectFirst("h1")?.text(),
        document.selectFirst("meta[property=og:title]")?.attr("content"),
        main.selectFirst("h1")?.text(),
        document.title(),
    ).filterNotNull().map(String::trim).firstOrNull(String::isNotEmpty)?.take(MAX_TITLE_LENGTH) ?: host
    val blocks = readBlocks(content, title)
    if (blocks.filterNot { it.heading }.sumOf { it.text.length } < MIN_READABLE_TEXT) throw noArticleText()
    return ReadingArticle("", title, null, blocks)
}

private fun contentScore(element: Element): Int {
    val prose = element.select("p,blockquote,pre").sumOf { it.text().length }
    val links = element.select("a").sumOf { it.text().length }
    return maxOf(prose, element.ownText().length) - links
}

private fun readBlocks(content: Element, title: String): List<ArticleBlock> {
    val output = mutableListOf<ArticleBlock>()
    val text = StringBuilder()
    var heading = false
    var totalLength = 0

    fun flush() {
        val block = WHITESPACE.replace(text.toString(), " ").trim()
        text.clear()
        if (block.isEmpty() || heading && (block == title || block.take(MAX_TITLE_LENGTH) == title)) return
        totalLength += block.length
        if (totalLength > MAX_ARTICLE_TEXT) throw articleTooLong()
        splitArticleBlock(block).forEach { part -> output.add(ArticleBlock(part, heading)) }
    }
    NodeTraversor.traverse(object : NodeVisitor {
        override fun head(node: Node, depth: Int) {
            when {
                node is TextNode -> text.append(node.wholeText)
                node is Element && node.normalName() in HEADINGS -> {
                    flush()
                    heading = true
                }
                node is Element && (node.normalName() in BLOCK_ELEMENTS || node.normalName() == "br") -> flush()
            }
        }

        override fun tail(node: Node, depth: Int) {
            if (node !is Element) return
            val tag = node.normalName()
            if (tag in BLOCK_ELEMENTS || tag in HEADINGS) flush()
            if (tag in HEADINGS) heading = false
        }
    }, content)
    flush()
    return output
}

private fun splitArticleBlock(text: String): List<String> {
    if (text.length <= MAX_BLOCK_LENGTH) return listOf(text)
    val blocks = mutableListOf<String>()
    var start = 0
    while (text.length - start > MAX_BLOCK_LENGTH) {
        val limit = start + MAX_BLOCK_LENGTH
        val breakAt = text.lastIndexOf(' ', limit)
        val end = when {
            breakAt >= start + MAX_BLOCK_LENGTH / 2 -> breakAt
            Character.isHighSurrogate(text[limit - 1]) -> limit - 1
            else -> limit
        }
        blocks.add(text.substring(start, end).trim())
        start = end
    }
    val last = text.substring(start).trim()
    if (last.isNotEmpty()) blocks.add(last)
    return blocks
}

private fun abbreviatedTitle(text: String): String {
    if (text.length <= 64) return text
    val prefix = text.take(63).trimEnd { it.isHighSurrogate() }
    val lastSpace = prefix.lastIndexOf(' ')
    return (if (lastSpace >= 40) prefix.take(lastSpace) else prefix) + "…"
}

internal fun isPublicArticleAddress(address: InetAddress): Boolean {
    val bytes = address.address
    fun octet(index: Int) = bytes[index].toInt() and 0xff
    val first = octet(0)
    val second = octet(1)
    val third = octet(2)
    if (bytes.size == 4) {
        return when {
            first == 0 || first == 10 || first == 127 || first >= 224 -> false
            first == 100 && second in 64..127 -> false
            first == 169 && second == 254 -> false
            first == 172 && second in 16..31 -> false
            first == 192 && (second == 168 || second == 0 && (third == 0 || third == 2) || second == 88 && third == 99) -> false
            first == 198 && (second in 18..19 || second == 51 && third == 100) -> false
            first == 203 && second == 0 && third == 113 -> false
            else -> true
        }
    }
    // Restrict IPv6 to globally routable addresses and exclude transition and special-use ranges.
    return first in 0x20..0x3f && !(first == 0x20 && second == 0x02) &&
        !(first == 0x20 && second == 0x01 && (third < 2 || third == 0x0d && octet(3) == 0xb8)) &&
        !(first == 0x3f && second == 0xff)
}

private fun networkError(error: IOException) = when (error) {
    is ArticleImportException -> error
    is InterruptedIOException -> ArticleImportException("This page took too long to load. Try again or paste the article text.", error)
    else -> ArticleImportException("Couldn't open this page. Check the link or paste the article text.", error)
}

private fun noArticleText() = ArticleImportException("Couldn't find readable article text on this page. Paste the article text instead.")
private fun articleTooLong() = ArticleImportException("This article is too long. Try pasting the portion you want to read.")

private const val MAX_PAGE_BYTES = 4 * 1024 * 1024L
private const val MAX_SHARED_LINK_TEXT = 8_192
private const val MAX_ARTICLE_TEXT = 240_000
private const val MAX_BLOCK_LENGTH = 3_000
private const val MAX_TITLE_LENGTH = 200
private const val MIN_READABLE_TEXT = 40
private const val MAX_REDIRECTS = 5
private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
private val LOCAL_HOST_SUFFIXES = listOf(".localhost", ".local", ".internal", ".test", ".invalid", ".example", ".home.arpa", ".onion")
private val SHARED_LINK = Regex("""https://[^\s<>"\u0000-\u001F]+""", RegexOption.IGNORE_CASE)
private val WHITESPACE = Regex("""[\s\u00a0]+""")
private val HEADINGS = setOf("h1", "h2", "h3", "h4", "h5", "h6")
private val BLOCK_ELEMENTS = setOf("address", "article", "blockquote", "caption", "dd", "div", "dl", "dt", "figcaption",
    "li", "main", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul")
private const val UNREADABLE_ELEMENTS = """
    script,style,noscript,svg,math,nav,aside,footer,form,dialog,iframe,template,canvas,
    button,input,textarea,select,video,audio,[hidden],[aria-hidden=true],
    [role=navigation],[role=contentinfo],[role=banner],[role=complementary]
"""
