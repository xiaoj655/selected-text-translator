package io.github.selectedtext.translator

import android.media.AudioAttributes
import android.media.MediaDataSource
import android.media.MediaPlayer
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

internal suspend fun playCloudSpeech(wave: ByteArray, onStart: () -> Unit) {
    val player = MediaPlayer()
    try {
        suspendCancellableCoroutine { playback ->
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource(WaveDataSource(wave))
            player.setOnPreparedListener {
                if (playback.isActive) {
                    try {
                        it.start()
                        onStart()
                    } catch (error: Exception) {
                        playback.resumeWithException(error)
                    }
                }
            }
            player.setOnCompletionListener { if (playback.isActive) playback.resume(Unit) }
            player.setOnErrorListener { _, _, _ ->
                if (playback.isActive) playback.resumeWithException(IOException("Unable to play cloud speech."))
                true
            }
            player.prepareAsync()
        }
    } finally {
        player.release()
    }
}

private class WaveDataSource(private val data: ByteArray) : MediaDataSource() {
    override fun getSize(): Long = data.size.toLong()

    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (size == 0) return 0
        if (position >= data.size) return -1
        val start = position.toInt()
        val length = minOf(data.size - start, size)
        data.copyInto(buffer, offset, start, start + length)
        return length
    }

    override fun close() = Unit
}
