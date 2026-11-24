package io.github.selectedtext.translator

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import java.net.Proxy
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.parser.Parser
import org.jsoup.safety.Safelist

internal data class FeedSource(
    val id: String,
    val name: String,
    val url: String,
    val custom: Boolean = false,
    val summaryContainsBody: Boolean = false,
)

internal data class FeedArticle(
    val sourceId: String,
    val url: String,
    val title: String,
    val excerpt: String,
    val publishedAt: Long?,
    val html: String? = null,
) {
    val hasFullText get() = html != null

    fun publishedLabel(): String? = publishedAt?.let {
        Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).toLocalDate().format(articleDateFormat)
    }
}

internal data class FeedSnapshot(
    val sources: List<FeedSource> = emptyList(),
    val optional: List<FeedSource> = emptyList(),
    val articles: Map<String, List<FeedArticle>> = emptyMap(),
    val errors: Map<String, String> = emptyMap(),
)

internal class FeedException(message: String, cause: Throwable? = null) : IOException(message, cause)

internal class FeedRepository(context: Context) {
    private val assets = context.assets
    private val directory = File(context.filesDir, "reading-feeds")
    private val subscriptions = AtomicFile(File(directory, "subscriptions.json"))
    private val lock = Mutex()
    private val snapshot = MutableStateFlow(FeedSnapshot())
    val state = snapshot.asStateFlow()
    private val client = FeedClient()
    private var loaded = false

    suspend fun load() = withContext(Dispatchers.IO) {
        lock.withLock {
            if (loaded) return@withLock
            val catalog = assets.open("reading-source-catalog.json").bufferedReader().use { JSONObject(it.readText()) }
            val builtIn = catalog.getJSONArray("builtIn").objects().map { it.toFeedSource() }
            val optional = catalog.getJSONArray("optional").objects().map { it.toFeedSource() }
            val sources = builtIn + readJson(subscriptions).orEmptyObjects().map { it.toFeedSource(custom = true) }
            val articles = sources.associate { source ->
                source.id to readJson(cacheFile(source)).orEmptyObjects().map { it.toFeedArticle(source.id) }
            }
            snapshot.value = FeedSnapshot(sources, optional, articles)
            loaded = true
        }
    }

    suspend fun refresh(ids: Set<String>? = null) = coroutineScope {
        load()
        snapshot.value.sources.filter { ids == null || it.id in ids }.map { source ->
            async {
                try {
                    val items = client.fetch(source).articles
                    withContext(Dispatchers.IO) {
                        lock.withLock {
                            val current = snapshot.value
                            if (source !in current.sources) return@withLock
                            writeCache(source, items)
                            snapshot.value = current.copy(
                                articles = current.articles + (source.id to items), errors = current.errors - source.id,
                            )
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    lock.withLock {
                        val current = snapshot.value
                        if (source in current.sources) {
                            snapshot.value = current.copy(errors = current.errors + (source.id to "Couldn't refresh this source."))
                        }
                    }
                }
            }
        }.awaitAll()
    }

    suspend fun add(value: String): FeedSource {
        load()
        val url = feedUrl(value).toString()
        fun checkDuplicate() {
            if (snapshot.value.sources.any { it.url == url }) throw FeedException("This feed is already added.")
        }
        checkDuplicate()
        val draft = FeedSource(UUID.randomUUID().toString(), "", url, custom = true)
        val feed = client.fetch(draft)
        val source = draft.copy(name = feed.name.ifBlank { feedUrl(url).host })
        return withContext(Dispatchers.IO) {
            lock.withLock {
                checkDuplicate()
                val current = snapshot.value
                if (current.sources.count { it.custom } >= 24) throw FeedException("Remove a subscription before adding another.")
                val sources = current.sources + source
                writeCache(source, feed.articles)
                writeSubscriptions(sources)
                snapshot.value = current.copy(sources = sources, articles = current.articles + (source.id to feed.articles))
                source
            }
        }
    }

    suspend fun remove(id: String) = withContext(Dispatchers.IO) {
        load()
        lock.withLock {
            val current = snapshot.value
            val source = current.sources.firstOrNull { it.id == id && it.custom } ?: return@withLock
            val sources = current.sources - source
            writeSubscriptions(sources)
            cacheFile(source).delete()
            snapshot.value = current.copy(sources = sources, articles = current.articles - id, errors = current.errors - id)
        }
    }

    private fun cacheFile(source: FeedSource) = AtomicFile(File(directory, "${source.id}.json"))

    private fun writeCache(source: FeedSource, items: List<FeedArticle>) {
        writeJson(cacheFile(source), JSONArray(items.map { article ->
            JSONObject().put("url", article.url).put("title", article.title).put("excerpt", article.excerpt)
                .put("publishedAt", article.publishedAt).put("html", article.html)
        }))
    }

    private fun writeSubscriptions(sources: List<FeedSource>) {
        writeJson(subscriptions, JSONArray(sources.filter { it.custom }.map { source ->
            JSONObject().put("id", source.id).put("name", source.name).put("url", source.url)
        }))
    }

    private fun writeJson(file: AtomicFile, json: JSONArray) {
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Couldn't save subscriptions.")
        val stream = file.startWrite()
        try {
            stream.write(json.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    private fun readJson(file: AtomicFile) = runCatching { JSONArray(file.readFully().toString(Charsets.UTF_8)) }.getOrNull()
}

internal class FeedClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .dns(publicArticleDns)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(7, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build(),
) {
    suspend fun fetch(source: FeedSource): FeedContent = withTimeoutOrNull(12_000L) {
        var url = feedUrl(source.url)
        repeat(6) {
            val response = request(url)
            if (response is FeedResponse.Content) return@withTimeoutOrNull parseFeed(response.xml, url, source)
            url = feedUrl(url.resolve((response as FeedResponse.Redirect).location)?.toString().orEmpty())
        }
        throw FeedException("This feed redirects too many times.")
    } ?: throw FeedException("This feed took too long to load.")

    private suspend fun request(url: HttpUrl): FeedResponse = suspendCancellableCoroutine { continuation ->
        val request = Request.Builder().url(url)
            .header("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml")
            .header("User-Agent", "Selected Article Reader (Android)")
            .build()
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resumeWith(Result.failure(FeedException("Couldn't connect to this feed.", e)))
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resumeWith(runCatching { response.use(::readResponse) })
            }
        })
    }

    private fun readResponse(response: Response): FeedResponse {
        if (response.code in listOf(301, 302, 303, 307, 308)) {
            return FeedResponse.Redirect(response.header("Location") ?: throw FeedException("This feed has an invalid redirect."))
        }
        if (!response.isSuccessful) throw FeedException("This feed returned HTTP ${response.code}.")
        val body = response.body ?: throw FeedException("This feed is empty.")
        val bytes = body.source()
        if (bytes.request(2 * 1024 * 1024 + 1L)) throw FeedException("This feed is too large.")
        return FeedResponse.Content(Jsoup.parse(bytes.readByteArray().inputStream(), body.contentType()?.charset()?.name(),
            response.request.url.toString(), Parser.xmlParser()))
    }

    private sealed interface FeedResponse {
        data class Content(val xml: Element) : FeedResponse
        data class Redirect(val location: String) : FeedResponse
    }
}

internal data class FeedContent(val name: String, val articles: List<FeedArticle>)

internal fun parseFeed(document: Element, url: HttpUrl, source: FeedSource): FeedContent {
    val root = document.children().firstOrNull()
    val channel = when (root?.normalName()?.substringAfterLast(':')) {
        "rss" -> root.field("channel")
        "feed" -> root
        else -> null
    } ?: throw FeedException("This URL did not return RSS or Atom.")
    val name = Jsoup.parse(channel.field("title")?.markup().orEmpty()).text().take(160)
    val seen = mutableSetOf<String>()
    val items = channel.children().asSequence()
        .filter { it.normalName().substringAfterLast(':') in setOf("item", "entry") }
        .take(500)
        .mapNotNull { item ->
            val title = Jsoup.parse(item.field("title")?.markup().orEmpty()).text().take(300)
            if (title.isBlank()) return@mapNotNull null
            val link = item.children().firstOrNull {
                it.normalName().substringAfterLast(':') == "link" && it.attr("rel") in setOf("", "alternate")
            } ?: return@mapNotNull null
            val address = url.resolve(link.attr("href").ifBlank { link.text() }) ?: return@mapNotNull null
            val safe = runCatching { publicArticleUrl(address.toString()).toString() }.getOrNull() ?: return@mapNotNull null
            if (!seen.add(safe)) return@mapNotNull null
            val summary = (item.field("description") ?: item.field("summary"))?.markup().orEmpty()
            val body = (item.field("encoded") ?: item.field("content"))?.markup().orEmpty()
                .ifBlank { if (source.summaryContainsBody) summary else "" }
            val html = body.takeIf { it.length <= 500_000 }?.let { Jsoup.clean(it, safe, Safelist.relaxed()) }
                ?.takeIf { Jsoup.parse(it).text().length >= 80 }
            val excerpt = Jsoup.parse(summary.ifBlank { html.orEmpty() }).text().take(360)
            val date = sequenceOf("published", "pubdate", "updated", "date").mapNotNull { item.field(it)?.text() }
                .mapNotNull(::parseFeedDate).firstOrNull()
            FeedArticle(source.id, safe, title, excerpt, date, html)
        }.sortedByDescending { it.publishedAt ?: Long.MIN_VALUE }.take(8).toList()
    return FeedContent(name, items)
}

private fun Element.field(name: String): Element? = children().firstOrNull { it.normalName().substringAfterLast(':') == name }
private fun Element.markup(): String = if (childrenSize() > 0) html() else wholeText()

private fun feedUrl(value: String): HttpUrl = try {
    publicArticleUrl(value)
} catch (error: ArticleImportException) {
    throw FeedException("Enter a public HTTPS RSS or Atom address.", error)
}

private fun parseFeedDate(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
    ?: runCatching { ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull()
    ?: runCatching { LocalDate.parse(value).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }.getOrNull()

private val articleDateFormat = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
private fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull(::optJSONObject)
private fun JSONArray?.orEmptyObjects() = this?.objects().orEmpty()
private fun JSONObject.toFeedSource(custom: Boolean = false) = FeedSource(
    getString("id"), getString("name"), getString("url"), custom, optBoolean("summaryContainsBody"),
)
private fun JSONObject.toFeedArticle(sourceId: String) = FeedArticle(
    sourceId, getString("url"), getString("title"), optString("excerpt"),
    optLong("publishedAt", Long.MIN_VALUE).takeUnless { it == Long.MIN_VALUE }, optString("html").ifBlank { null },
)
