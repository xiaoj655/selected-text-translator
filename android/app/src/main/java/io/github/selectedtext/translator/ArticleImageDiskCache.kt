package io.github.selectedtext.translator

import java.io.File
import java.io.IOException
import java.security.MessageDigest

internal class ArticleImageDiskCache(
    private val directory: File,
    private val maxBytes: Long = 64L * 1024 * 1024,
    private val maxEntryBytes: Long = 10L * 1024 * 1024,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var cleanedTemporaryFiles = false

    @Synchronized
    fun read(key: String): ByteArray? {
        cleanTemporaryFiles()
        val file = fileFor(key)
        return try {
            if (!file.isFile) return null
            if (file.length() !in 1..maxEntryBytes) {
                file.delete()
                return null
            }
            file.readBytes().also { file.setLastModified(now()) }
        } catch (_: IOException) {
            null
        }
    }

    @Synchronized
    fun write(key: String, bytes: ByteArray) {
        if (bytes.isEmpty() || bytes.size > minOf(maxBytes, maxEntryBytes)) return
        cleanTemporaryFiles()
        var temporary: File? = null
        try {
            if (!directory.isDirectory && !directory.mkdirs()) return
            temporary = File.createTempFile("image-", ".tmp", directory)
            temporary.writeBytes(bytes)
            val file = fileFor(key)
            if (!temporary.renameTo(file)) return
            file.setLastModified(now())
            val files = directory.listFiles().orEmpty().filter { CACHE_NAME.matches(it.name) }
            var size = files.sumOf { it.length() }
            for (entry in files.sortedBy { it.lastModified() }) {
                if (size <= maxBytes) break
                val length = entry.length()
                if (entry.delete()) size -= length
            }
        } catch (_: IOException) {
            // A full or unavailable cache must not prevent an image from being shown.
        } finally {
            temporary?.delete()
        }
    }

    @Synchronized
    fun remove(key: String) {
        fileFor(key).delete()
    }

    private fun cleanTemporaryFiles() {
        if (cleanedTemporaryFiles) return
        directory.listFiles().orEmpty()
            .filter { it.name.startsWith("image-") && it.name.endsWith(".tmp") }
            .forEach { it.delete() }
        cleanedTemporaryFiles = true
    }

    private fun fileFor(key: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        return File(directory, digest.joinToString("") { "%02x".format(it) })
    }

    private companion object {
        val CACHE_NAME = Regex("[0-9a-f]{64}")
    }
}
