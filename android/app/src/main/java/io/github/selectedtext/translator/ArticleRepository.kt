package io.github.selectedtext.translator

import android.content.Context
import android.util.AtomicFile
import androidx.core.content.edit
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup

internal class ArticleRepository(context: Context) {
    private val directory = File(context.filesDir, "articles")
    private val positions = context.getSharedPreferences("article-positions", Context.MODE_PRIVATE)
    private val importer = ArticleImporter()
    private val iqsImporter = IqsArticleImporter()
    private val mutations = Mutex()
    private val entries = MutableStateFlow<List<ReadingArticle>>(emptyList())
    val articles = entries.asStateFlow()
    private var loaded = false

    suspend fun load() = withContext(Dispatchers.IO) {
        mutations.withLock { loadLocked() }
    }

    suspend fun importUrl(url: String, iqsApiKey: String = ""): ReadingArticle {
        val source = publicArticleUrl(url)
        val original = source.toString()
        load()
        entries.value.firstOrNull { it.sourceUrl == original }?.let { return it }
        val article = fetchWebArticle(source, iqsApiKey)
        return insert(article.copy(sourceUrl = original))
    }

    suspend fun reimportArticle(article: ReadingArticle, iqsApiKey: String): ReadingArticle {
        val url = article.sourceUrl ?: throw ArticleImportException("This article has no original page.")
        val refreshed = fetchWebArticle(publicArticleUrl(url), iqsApiKey)
        return replaceArticle(article.id) { current ->
            if (current.blocks == refreshed.blocks) {
                return@replaceArticle if (current.title == refreshed.title) current else current.copy(title = refreshed.title)
            }
            current.copy(
                title = refreshed.title,
                blocks = refreshed.blocks,
                position = reimportPosition(current, refreshed.blocks),
            )
        }
    }

    private suspend fun fetchWebArticle(source: HttpUrl, iqsApiKey: String): ReadingArticle {
        if (iqsApiKey.isBlank()) return importer.fetch(source.toString())
        if (isPsycheArticle(source)) {
            try {
                return importer.fetch(source.toString())
            } catch (_: ArticleImportException) {
                // Use IQS when direct parsing of the source page is unavailable.
            }
        }
        return iqsImporter.fetch(source, iqsApiKey)
    }

    suspend fun importFeedArticle(url: String, title: String, html: String): ReadingArticle {
        val source = publicArticleUrl(url)
        val original = source.toString()
        load()
        entries.value.firstOrNull { it.sourceUrl == original }?.let { return it }
        val article = withContext(Dispatchers.Default) {
            extractArticle(Jsoup.parseBodyFragment(html, original), source.host)
        }
        return insert(article.copy(title = title.ifBlank { article.title }, sourceUrl = original))
    }

    suspend fun importText(text: String, title: String = "") = insert(pastedArticle(text, title))

    suspend fun reloadImages(article: ReadingArticle): ReadingArticle {
        val url = article.sourceUrl ?: throw ArticleImportException("This article has no original page.")
        val refreshed = importer.fetch(url)
        if (!refreshed.hasImages) throw ArticleImportException("Couldn't find images on the original page.")
        return replaceArticle(article.id) { current ->
            if (current.hasImages) return@replaceArticle current
            current.copy(blocks = refreshed.blocks, position = positionWithImages(current, refreshed.blocks))
        }
    }

    private suspend fun replaceArticle(id: String, replace: (ReadingArticle) -> ReadingArticle): ReadingArticle =
        withContext(Dispatchers.IO) {
            mutations.withLock {
                loadLocked()
                val current = entries.value.firstOrNull { it.id == id }
                    ?: throw ArticleImportException("This article was removed.")
                val updated = replace(current)
                if (updated === current) return@withLock current
                write(updated)
                storePosition(id, updated.position)
                entries.value = entries.value.map { if (it.id == id) updated else it }
                updated
            }
        }

    private fun reimportPosition(current: ReadingArticle, blocks: List<ArticleBlock>): ArticlePosition {
        val position = current.position
        if (position.index == 0) return position
        val index = position.index - 1
        val previous = current.blocks.getOrNull(index) ?: return ArticlePosition()
        if (blocks.getOrNull(index) == previous) return position
        val matches = blocks.indices.filter { blocks[it] == previous }
        return matches.singleOrNull()?.let { ArticlePosition(it + 1, position.offset) } ?: ArticlePosition()
    }

    suspend fun savePosition(article: ReadingArticle, position: ArticlePosition) = withContext(Dispatchers.IO) {
        mutations.withLock {
            loadLocked()
            val current = entries.value.firstOrNull { it.id == article.id } ?: return@withLock
            if (current.blocks !== article.blocks) return@withLock
            val bounded = ArticlePosition(position.index.coerceIn(0, current.blocks.lastIndex + 1), position.offset.coerceAtLeast(0))
            if (current.position == bounded) return@withLock
            storePosition(current.id, bounded)
            entries.value = entries.value.map { if (it.id == current.id) it.copy(position = bounded) else it }
        }
    }

    suspend fun delete(id: String) = withContext(Dispatchers.IO) {
        mutations.withLock {
            loadLocked()
            if (entries.value.none { it.id == id }) return@withLock
            val file = fileFor(id)
            file.delete()
            if (file.baseFile.exists()) throw IOException("Couldn't remove the article.")
            positions.edit { remove(id) }
            entries.value = entries.value.filterNot { it.id == id }
        }
    }

    private suspend fun insert(item: ReadingArticle): ReadingArticle = withContext(Dispatchers.IO) {
        mutations.withLock {
            loadLocked()
            val duplicate = entries.value.firstOrNull {
                if (item.sourceUrl == null) it.sourceUrl == null && it.title == item.title && it.blocks == item.blocks
                else it.sourceUrl == item.sourceUrl
            }
            if (duplicate != null) return@withLock duplicate
            if (entries.value.size >= MAX_ARTICLES) throw IOException("Remove an article before adding another.")
            val article = item.copy(id = UUID.randomUUID().toString(), updatedAt = System.currentTimeMillis())
            write(article)
            entries.value = listOf(article) + entries.value
            article
        }
    }

    private fun loadLocked() {
        if (loaded) return
        val files = directory.listFiles().orEmpty()
        val ids = files.asSequence().map { it.name.removeSuffix(".bak") }
            .filter { ARTICLE_NAME.matches(it) }.map { it.removeSuffix(".json") }.distinct()
        entries.value = ids.mapNotNull { id -> runCatching { read(id) }.getOrNull() }
            .sortedByDescending { it.updatedAt }.toList()
        loaded = true
    }

    private fun fileFor(id: String) = AtomicFile(File(directory, "$id.json"))

    private fun storePosition(id: String, position: ArticlePosition) {
        positions.edit { putString(id, "${position.index}:${position.offset}") }
    }

    private fun read(id: String): ReadingArticle {
        val data = JSONObject(fileFor(id).readFully().toString(Charsets.UTF_8))
        val blocks = data.getJSONArray("blocks")
        val position = positions.getString(id, null)?.split(':', limit = 2).orEmpty()
        return ReadingArticle(
            id = id,
            title = data.getString("title"),
            sourceUrl = data.optString("sourceUrl").ifBlank { null },
            blocks = List(blocks.length()) { index ->
                val block = blocks.getJSONObject(index)
                val image = block.optJSONObject("image")?.let {
                    ArticleImage(it.getString("url"), it.optString("alt"),
                        it.optDouble("aspectRatio").toFloat().takeIf(Float::isFinite))
                }
                ArticleBlock(block.getString("text"), block.optBoolean("heading"), image)
            },
            position = ArticlePosition(
                (position.getOrNull(0)?.toIntOrNull() ?: 0).coerceIn(0, blocks.length()),
                (position.getOrNull(1)?.toIntOrNull() ?: 0).coerceAtLeast(0),
            ),
            updatedAt = data.getLong("updatedAt"),
        )
    }

    private fun write(article: ReadingArticle) {
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Couldn't save the article.")
        val blocks = JSONArray(article.blocks.map { block ->
            val data = JSONObject().put("text", block.text).put("heading", block.heading)
            block.image?.let { image ->
                data.put("image", JSONObject().put("url", image.url).put("alt", image.alt)
                    .put("aspectRatio", image.aspectRatio))
            }
            data
        })
        val data = JSONObject().put("title", article.title).put("sourceUrl", article.sourceUrl)
            .put("updatedAt", article.updatedAt).put("blocks", blocks)
        val file = fileFor(article.id)
        val stream = file.startWrite()
        try {
            stream.write(data.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: IOException) {
            file.failWrite(stream)
            throw error
        }
    }

    private companion object {
        const val MAX_ARTICLES = 100
        val ARTICLE_NAME = Regex("[0-9a-f-]{36}\\.json")
    }
}
