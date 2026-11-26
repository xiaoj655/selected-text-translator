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
import java.io.IOException
import java.net.Proxy
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dispatcher
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import kotlin.math.roundToInt

internal fun articleImageHeight(widthPx: Int, aspectRatio: Float?): Int {
    val ratio = aspectRatio?.takeIf { it.isFinite() && it > 0 }?.coerceIn(0.5f, 3f) ?: (4f / 3f)
    return (widthPx / ratio).roundToInt()
}

@Composable
internal fun ArticleImageContent(image: ArticleImage, sourceUrl: String?) {
    val network = (LocalContext.current.applicationContext as TranslatorApplication).articleNetwork
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val density = LocalDensity.current
        val width = with(density) { maxWidth.roundToPx() }
        val height = articleImageHeight(width, image.aspectRatio)
        val heightDp = with(density) { height.toDp() }
        val request = remember(image.url, sourceUrl, width, height) {
            ImageRequest(image.url, articleOrigin(sourceUrl), maxOf(width, height).coerceIn(1, MAX_DECODED_EDGE))
        }
        var retry by remember(request) { mutableIntStateOf(0) }
        var bitmap by remember(request, retry) { mutableStateOf(ArticleImageLoader.cached(request)) }
        var failed by remember(request, retry) { mutableStateOf(false) }
        LaunchedEffect(request, retry) {
            if (bitmap == null) {
                bitmap = ArticleImageLoader.load(request, network)
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
                } else {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
        }
    }
}

private fun articleOrigin(sourceUrl: String?): String? = sourceUrl?.let {
    try {
        publicArticleUrl(it).newBuilder().encodedPath("/").query(null).build().toString()
    } catch (_: ArticleImportException) {
        null
    }
}

private data class ImageRequest(val url: String, val referrer: String?, val targetEdge: Int)

private object ArticleImageLoader {
    private val http = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .dns(publicArticleDns)
        .followRedirects(false)
        .followSslRedirects(false)
        .dispatcher(Dispatcher().apply { maxRequests = 4 })
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private val cache = object : LruCache<ImageRequest, Bitmap>(16 * 1024 * 1024) {
        override fun sizeOf(key: ImageRequest, value: Bitmap): Int = value.allocationByteCount
    }

    fun cached(image: ImageRequest): Bitmap? = cache.get(image)

    suspend fun load(image: ImageRequest, network: ArticleNetwork): Bitmap? = withTimeoutOrNull(20_000L) {
        try {
            var url = publicArticleUrl(image.url)
            repeat(MAX_IMAGE_REDIRECTS + 1) {
                when (val response = request(url, image, network)) {
                    is ImageResponse.Content -> {
                        cache.put(image, response.bitmap)
                        return@withTimeoutOrNull response.bitmap
                    }
                    is ImageResponse.Redirect -> {
                        url = publicArticleUrl(url.resolve(response.location)?.toString().orEmpty())
                    }
                }
            }
            null
        } catch (_: IOException) {
            null
        }
    }

    private suspend fun request(url: HttpUrl, image: ImageRequest, network: ArticleNetwork): ImageResponse = suspendCancellableCoroutine { continuation ->
        val request = Request.Builder().url(url)
            .header("Accept", "image/*")
            .header("User-Agent", "Selected Article Reader (Android)")
            .apply { image.referrer?.let { header("Referer", it) } }
            .build()
        val call = network.client(http).newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resumeWith(Result.failure(e))
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (continuation.isActive) {
                        continuation.resumeWith(runCatching { read(it, image.targetEdge) })
                    }
                }
            }
        })
    }

    private fun read(response: Response, targetEdge: Int): ImageResponse {
        if (response.code in IMAGE_REDIRECTS) {
            val location = response.header("Location") ?: throw IOException("Missing image redirect location.")
            return ImageResponse.Redirect(location)
        }
        if (!response.isSuccessful) throw IOException("Image request returned HTTP ${response.code}.")
        val body = response.body ?: throw IOException("Missing image data.")
        val type = body.contentType()
        val binary = type?.type == "application" && type.subtype == "octet-stream"
        if (type != null && type.type != "image" && !binary) {
            throw IOException("Response is not an image.")
        }
        val source = body.source()
        if (body.contentLength() > MAX_IMAGE_BYTES || source.request(MAX_IMAGE_BYTES + 1L)) {
            throw IOException("Image response is too large.")
        }
        return ImageResponse.Content(decode(source.readByteArray(), targetEdge))
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
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: throw IOException("Couldn't decode image.")
    }

    private sealed interface ImageResponse {
        data class Redirect(val location: String) : ImageResponse
        data class Content(val bitmap: Bitmap) : ImageResponse
    }
}

private const val MAX_IMAGE_BYTES = 10L * 1024 * 1024
private const val MAX_SOURCE_PIXELS = 40_000_000L
private const val MAX_DECODED_EDGE = 2048
private const val MAX_IMAGE_REDIRECTS = 5
private val IMAGE_REDIRECTS = setOf(301, 302, 303, 307, 308)
