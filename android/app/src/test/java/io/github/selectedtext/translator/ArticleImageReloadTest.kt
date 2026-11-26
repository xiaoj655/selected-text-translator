package io.github.selectedtext.translator

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ArticleImageReloadTest {
    private val opening = ArticleBlock("The opening paragraph.")
    private val image = ArticleBlock("", image = ArticleImage("https://news.example.org/figure.jpg"))
    private val saved = ReadingArticle("saved", "Example article", "https://news.example.org/article", listOf(opening))
    private val withImages = saved.copy(blocks = listOf(opening, image))

    @Test
    fun `uses cached feed images without fetching the page`() = runBlocking {
        val result = findArticleWithImages(
            cached = { withImages },
            direct = { error("The direct request shouldn't run when the cache has images.") },
            iqs = { error("IQS shouldn't run when the cache has images.") },
        )

        assertSame(withImages, result)
    }

    @Test
    fun `falls back to configured IQS if the original page cannot be opened`() = runBlocking {
        val result = findArticleWithImages(
            cached = { null },
            direct = { throw ArticleImportException("Couldn't open this page.") },
            iqs = { withImages },
        )

        assertSame(withImages, result)
    }

    @Test
    fun `falls back to configured IQS if direct import only finds text`() = runBlocking {
        val result = findArticleWithImages(
            cached = { saved },
            direct = { saved },
            iqs = { withImages },
        )

        assertSame(withImages, result)
    }

    @Test
    fun `cancelling a request does not trigger IQS`() {
        var triedIqs = false
        assertThrows(CancellationException::class.java) {
            runBlocking {
                findArticleWithImages(
                    cached = { null },
                    direct = { throw CancellationException("Reload cancelled") },
                    iqs = {
                        triedIqs = true
                        withImages
                    },
                )
            }
        }

        assertFalse(triedIqs)
    }

    @Test
    fun `reports the original failure when no image source is available`() {
        val directFailure = ArticleImportException("Couldn't open this page.")
        val error = assertThrows(ArticleImportException::class.java) {
            runBlocking {
                findArticleWithImages(
                    cached = { saved },
                    direct = { throw directFailure },
                )
            }
        }

        assertTrue(error === directFailure || error.cause === directFailure)
    }

    @Test
    fun `inserts recovered images without losing paragraphs absent from the feed`() {
        val savedOnly = ArticleBlock("This paragraph is only in the saved full article.")
        val closing = ArticleBlock("The article closes here.")
        val savedBlocks = listOf(opening, savedOnly, closing)
        val recoveredBlocks = listOf(opening, image, closing)

        assertEquals(listOf(opening, savedOnly, image, closing), restoreArticleImageBlocks(savedBlocks, recoveredBlocks))
    }
}
