package io.github.selectedtext.translator

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.io.File
import java.io.IOException
import java.net.Proxy
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import kotlin.math.roundToInt

internal fun articleImageHeight(widthPx: Int, aspectRatio: Float?): Int {
    val ratio = aspectRatio?.takeIf { it.isFinite() && it > 0 }?.coerceIn(0.5f, 3f) ?: (4f / 3f)
    return (widthPx / ratio).roundToInt()
}

@Composable
internal fun ArticleImageContent(image: ArticleImage, sourceUrl: String?, eInkMode: Boolean) {
    val loader = (LocalContext.current.applicationContext as TranslatorApplication).articleImages
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val density = LocalDensity.current
        val width = with(density) { maxWidth.roundToPx() }
        val height = articleImageHeight(width, image.aspectRatio)
        val heightDp = with(density) { height.toDp() }
        val request = remember(image, sourceUrl, width, height) {
            ImageRequest(image.url, articleOrigin(sourceUrl), maxOf(width, height).coerceIn(1, MAX_DECODED_EDGE), image.referrerPolicy)
        }
        var retry by remember(request) { mutableIntStateOf(0) }
        var bitmap by remember(request, retry) { mutableStateOf(loader.cached(request)) }
        var failed by remember(request, retry) { mutableStateOf(false) }
        LaunchedEffect(request, retry) {
            if (bitmap == null) {
                bitmap = loader.load(request)
                failed = bitmap == null
            }
        }
        val loaded = bitmap
        val frame = Modifier.fillMaxWidth().height(heightDp)
        if (loaded != null) {
            val display = remember(loaded) { loaded.asImageBitmap() }
            Box(frame, contentAlignment = Alignment.Center) {
                Image(
                    bitmap = display,
                    contentDescription = image.alt.ifBlank { null },
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            }
        } else {
            Box(
                frame.background(MaterialTheme.colorScheme.surfaceContainer),
                contentAlignment = Alignment.Center,
            ) {
                if (failed) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        if (heightDp >= 96.dp) {
                            Text(
                                image.alt.ifBlank { "Image unavailable" },
                                Modifier.padding(horizontal = 12.dp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center,
                            )
                        }
                        TextButton(onClick = { retry++ }) { Text("Retry image") }
                    }
                } else if (eInkMode) {
                    Text(
                        "Loading image…",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
        }
    }
}

internal data class ImageRequest(
    val url: String,
    val referrer: String?,
    val targetEdge: Int,
    val referrerPolicy: ImageReferrerPolicy = ImageReferrerPolicy.ORIGIN,
) {
    val diskKey: String get() {
        val key = "$url\n${referrer.orEmpty()}"
        return if (referrerPolicy == ImageReferrerPolicy.ORIGIN) key else "$key\n${referrerPolicy.value}"
    }
}

internal class ArticleImageLoader(cacheDirectory: File, private val network: ArticleNetwork) {
    private val http = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .dns(publicArticleDns)
        .followRedirects(false)
        .followSslRedirects(false)
        .dispatcher(Dispatcher().apply { maxRequests = 4 })
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private val cache = object : LruCache<ImageRequest, Bitmap>(
        (Runtime.getRuntime().maxMemory() / 4).coerceIn(8L * 1024 * 1024, 64L * 1024 * 1024).toInt(),
    ) {
        override fun sizeOf(key: ImageRequest, value: Bitmap): Int = value.allocationByteCount
    }
    private val disk = ArticleImageDiskCache(File(cacheDirectory, "article-images"))
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val loadSlots = Semaphore(2)
    private val inFlight = mutableMapOf<ImageRequest, Deferred<Bitmap?>>()

    fun cached(image: ImageRequest): Bitmap? = cache.get(image)

    suspend fun load(image: ImageRequest): Bitmap? {
        cached(image)?.let { return it }
        // A lazy list can dispose an image while it is loading. Keep the bounded request
        // alive so returning to the item shares the work and can use its cached result.
        val pending = synchronized(inFlight) {
            cached(image)?.let { return it }
            inFlight[image] ?: scope.async(start = CoroutineStart.LAZY) {
                try {
                    loadUncached(image)?.also { cache.put(image, it) }
                } finally {
                    synchronized(inFlight) { inFlight.remove(image) }
                }
            }.also { inFlight[image] = it }
        }
        pending.start()
        return pending.await()
    }

    private suspend fun loadUncached(image: ImageRequest): Bitmap? = withTimeoutOrNull(20_000L) {
        // Limit disk reads and decoding too, including work retained during fast scrolling.
        loadSlots.withPermit {
            try {
                disk.read(image.diskKey)?.let { bytes ->
                    try {
                        return@withPermit decode(bytes, image.targetEdge)
                    } catch (_: IOException) {
                        disk.remove(image.diskKey)
                    }
                }
                val bytes = downloadArticleImage(image.url, image.referrer, image.referrerPolicy) { network.client(http).newCall(it) }
                decode(bytes, image.targetEdge).also { disk.write(image.diskKey, bytes) }
            } catch (_: IOException) {
                null
            }
        }
    }

    private fun decode(bytes: ByteArray, targetEdge: Int): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val width = bounds.outWidth
        val height = bounds.outHeight
        if (width <= 0 || height <= 0 || width.toLong() * height > MAX_SOURCE_PIXELS) {
            throw IOException("Invalid image dimensions.")
        }
        val longestEdge = maxOf(width, height)
        var sampleSize = 1
        while (longestEdge / sampleSize > MAX_DECODED_EDGE || longestEdge / (2 * sampleSize) >= targetEdge) {
            sampleSize *= 2
        }
        val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: throw IOException("Couldn't decode image.")
        val edge = maxOf(bitmap.width, bitmap.height)
        if (edge <= targetEdge) return bitmap
        val scaled = Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width.toLong() * targetEdge / edge).toInt().coerceAtLeast(1),
            (bitmap.height.toLong() * targetEdge / edge).toInt().coerceAtLeast(1),
            true,
        )
        bitmap.recycle()
        return scaled
    }
}

private const val MAX_SOURCE_PIXELS = 40_000_000L
private const val MAX_DECODED_EDGE = 2048
