package io.github.selectedtext.translator

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ArticleImageDiskCacheTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun `reuses downloaded bytes across loader instances and display sizes`() {
        val directory = temporary.newFolder()
        val small = ImageRequest("https://example.org/photo.jpg", "https://example.org/", 480)
        val large = small.copy(targetEdge = 1080)
        val bytes = byteArrayOf(1, 2, 3)
        ArticleImageDiskCache(directory).write(small.diskKey, bytes)

        assertArrayEquals(bytes, ArticleImageDiskCache(directory).read(large.diskKey))
        assertNull(ArticleImageDiskCache(directory).read(small.copy(referrer = "https://other.example/").diskKey))
    }

    @Test
    fun `evicts the least recently read image to keep a bounded disk cache`() {
        val directory = temporary.newFolder()
        var time = 1_000L
        val cache = ArticleImageDiskCache(directory, maxBytes = 8, now = { time++ })
        cache.write("first", ByteArray(4) { 1 })
        cache.write("second", ByteArray(4) { 2 })
        cache.read("first")
        cache.write("third", ByteArray(4) { 3 })

        assertArrayEquals(ByteArray(4) { 1 }, cache.read("first"))
        assertNull(cache.read("second"))
        assertArrayEquals(ByteArray(4) { 3 }, cache.read("third"))
        assertEquals(8L, directory.listFiles().orEmpty().sumOf { it.length() })
    }

    @Test
    fun `ignores empty or oversized downloads and removes corrupt cache entries`() {
        val directory = temporary.newFolder()
        val cache = ArticleImageDiskCache(directory, maxBytes = 8, maxEntryBytes = 4)
        cache.write("oversized", ByteArray(5))
        cache.write("empty", ByteArray(0))
        assertEquals(0, directory.listFiles().orEmpty().size)

        cache.write("valid", byteArrayOf(1, 2))
        val entry = directory.listFiles()!!.single()
        entry.writeBytes(ByteArray(5))
        assertNull(cache.read("valid"))
        assertFalse(entry.exists())
    }

    @Test
    fun `can replace and discard an image without leaving temporary files`() {
        val directory = temporary.newFolder()
        val cache = ArticleImageDiskCache(directory)
        cache.write("same-image", byteArrayOf(1))
        cache.write("same-image", byteArrayOf(2, 3))
        assertArrayEquals(byteArrayOf(2, 3), cache.read("same-image"))
        assertEquals(1, directory.listFiles().orEmpty().size)

        cache.remove("same-image")
        assertNull(cache.read("same-image"))
        assertEquals(0, directory.listFiles().orEmpty().size)
    }

    @Test
    fun `a missing or unavailable cache directory does not prevent loading`() {
        val missing = File(temporary.newFolder(), "not-created")
        assertNull(ArticleImageDiskCache(missing).read("image"))
        assertFalse(missing.exists())

        val unavailable = temporary.newFile()
        val cache = ArticleImageDiskCache(unavailable)
        cache.write("image", byteArrayOf(1))
        assertNull(cache.read("image"))
        cache.remove("image")
        assertEquals(0L, unavailable.length())
    }

    @Test
    fun `cleans files left by an interrupted write when the cache is next used`() {
        val directory = temporary.newFolder()
        val original = ArticleImageDiskCache(directory)
        original.write("downloaded", byteArrayOf(1, 2))
        val interrupted = File(directory, "image-interrupted.tmp").apply { writeBytes(ByteArray(8)) }

        assertArrayEquals(byteArrayOf(1, 2), ArticleImageDiskCache(directory).read("downloaded"))
        assertFalse(interrupted.exists())
        assertEquals(1, directory.listFiles().orEmpty().size)
    }
}
