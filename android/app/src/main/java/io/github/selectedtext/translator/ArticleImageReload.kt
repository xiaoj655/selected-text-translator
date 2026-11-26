package io.github.selectedtext.translator

import java.net.UnknownHostException
import javax.net.ssl.SSLException

internal suspend fun findArticleWithImages(
    cached: suspend () -> ReadingArticle?,
    direct: suspend () -> ReadingArticle,
    iqs: (suspend () -> ReadingArticle)? = null,
): ReadingArticle {
    var failure: ArticleImportException? = null
    var foundText = false
    val attempts = listOfNotNull(cached, direct, iqs)
    for (read in attempts) {
        val article = try {
            read()
        } catch (error: ArticleImportException) {
            failure = error
            null
        } ?: continue
        if (article.hasImages) return article
        foundText = true
    }
    val message = when {
        failure is IqsImportException -> failure.message ?: "IQS couldn't reload images."
        failure?.cause is UnknownHostException -> "Couldn't resolve the original site's address. Try opening it in your browser."
        failure?.cause is SSLException -> "Couldn't connect securely to the original site. Try opening it in your browser."
        foundText && failure == null -> "No images were found in the available article content."
        else -> "Couldn't load the original page to reload images. Try opening it in your browser."
    }
    throw ArticleImportException(message, failure)
}

internal fun restoreArticleImageBlocks(saved: List<ArticleBlock>, recovered: List<ArticleBlock>): List<ArticleBlock> {
    val savedIndices = saved.indices.groupBy { saved[it].text }
    val imagesBefore = mutableMapOf<Int, MutableList<ArticleBlock>>()
    val pending = mutableListOf<ArticleBlock>()
    var nextIndex = 0
    for (block in recovered) {
        if (block.image != null) {
            pending.add(block)
            continue
        }
        val indices = savedIndices[block.text] ?: continue
        val match = indices.binarySearch(nextIndex)
        val index = indices.getOrNull(if (match >= 0) match else -match - 1) ?: continue
        if (pending.isNotEmpty()) {
            imagesBefore.getOrPut(index, ::mutableListOf).addAll(pending)
            pending.clear()
        }
        nextIndex = index + 1
    }
    return buildList {
        val trailingImagesIndex = nextIndex.takeIf { it > 0 } ?: saved.size
        saved.forEachIndexed { index, block ->
            addAll(imagesBefore[index].orEmpty())
            if (index == trailingImagesIndex) addAll(pending)
            add(block)
        }
        if (trailingImagesIndex == saved.size) addAll(pending)
    }
}
