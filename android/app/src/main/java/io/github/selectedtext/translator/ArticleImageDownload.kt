package io.github.selectedtext.translator

import java.io.IOException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.Response

internal suspend fun downloadArticleImage(
    imageUrl: String,
    sourceUrl: String?,
    sourcePolicy: ImageReferrerPolicy = ImageReferrerPolicy.ORIGIN,
    newCall: (Request) -> Call,
): ByteArray {
    var url = publicArticleUrl(imageUrl)
    var retryOrigin = articleOrigin(sourceUrl)?.toHttpUrl()
    var referrer: HttpUrl? = null
    var policy = sourcePolicy
    repeat(MAX_IMAGE_REDIRECTS + 1) {
        var response = requestImage(url, referrer, newCall)
        val availableOrigin = retryOrigin
        if (response is ImageResponse.Blocked && availableOrigin != null &&
            minOf(policy, response.policy).permits(availableOrigin, url)
        ) {
            retryOrigin = null
            referrer = availableOrigin
            response = requestImage(url, referrer, newCall)
        }
        when (response) {
            is ImageResponse.Content -> return response.bytes
            is ImageResponse.Blocked -> throw IOException("Image request returned HTTP 403.")
            is ImageResponse.Redirect -> {
                val next = publicArticleUrl(url.resolve(response.location)?.toString().orEmpty())
                policy = minOf(policy, response.policy)
                // A referrer added to the retry may continue only on its current host.
                referrer = referrer?.takeIf { next.hasSameOrigin(url) && policy.permits(it, next) }
                url = next
            }
        }
    }
    throw IOException("Too many image redirects.")
}

private suspend fun requestImage(url: HttpUrl, referrer: HttpUrl?, newCall: (Request) -> Call): ImageResponse =
    suspendCancellableCoroutine { continuation ->
        val request = Request.Builder().url(url)
            .header("Accept", "image/*")
            .header("User-Agent", "Selected Article Reader (Android)")
            .apply { referrer?.let { header("Referer", it.toString()) } }
            .build()
        val call = newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resumeWith(Result.failure(e))
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (continuation.isActive) {
                        continuation.resumeWith(runCatching { readImage(it) })
                    }
                }
            }
        })
    }

private fun readImage(response: Response): ImageResponse {
    if (response.code in IMAGE_REDIRECTS) {
        val location = response.header("Location") ?: throw IOException("Missing image redirect location.")
        return ImageResponse.Redirect(location, response.imageReferrerPolicy())
    }
    if (response.code == 403) return ImageResponse.Blocked(response.imageReferrerPolicy())
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
    return ImageResponse.Content(source.readByteArray())
}

internal fun articleOrigin(sourceUrl: String?): String? = sourceUrl?.let {
    try {
        publicArticleUrl(it).newBuilder().encodedPath("/").query(null).build().toString()
    } catch (_: ArticleImportException) {
        null
    }
}

internal fun HttpUrl.hasSameOrigin(other: HttpUrl) = scheme == other.scheme && host == other.host && port == other.port

internal enum class ImageReferrerPolicy(val value: String) {
    NONE("no-referrer"), SAME_ORIGIN("same-origin"), ORIGIN("origin");

    fun permits(origin: HttpUrl, target: HttpUrl): Boolean = when (this) {
        NONE -> false
        SAME_ORIGIN -> origin.hasSameOrigin(target)
        ORIGIN -> true
    }
}

internal fun imageReferrerPolicy(value: String): ImageReferrerPolicy =
    value.split(',').asReversed().firstNotNullOfOrNull {
        when (it.trim()) {
            "no-referrer" -> ImageReferrerPolicy.NONE
            "same-origin" -> ImageReferrerPolicy.SAME_ORIGIN
            "no-referrer-when-downgrade", "origin", "origin-when-cross-origin",
            "strict-origin", "strict-origin-when-cross-origin", "unsafe-url" -> ImageReferrerPolicy.ORIGIN
            else -> null
        }
    } ?: ImageReferrerPolicy.ORIGIN

internal fun Response.imageReferrerPolicy() = imageReferrerPolicy(headers("Referrer-Policy").joinToString(","))

private sealed interface ImageResponse {
    data class Blocked(val policy: ImageReferrerPolicy) : ImageResponse
    data class Redirect(val location: String, val policy: ImageReferrerPolicy) : ImageResponse
    data class Content(val bytes: ByteArray) : ImageResponse
}

private const val MAX_IMAGE_BYTES = 10L * 1024 * 1024
private const val MAX_IMAGE_REDIRECTS = 5
private val IMAGE_REDIRECTS = setOf(301, 302, 303, 307, 308)
