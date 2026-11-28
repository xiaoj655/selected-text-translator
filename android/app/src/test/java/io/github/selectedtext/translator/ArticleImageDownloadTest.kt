package io.github.selectedtext.translator

import java.io.IOException
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ArticleImageDownloadTest {
    private val asset = "https://cdn.example.org/figure.png?format=webp"
    private val article = "https://publisher.example.org/articles/some-story?private=query#selection"
    private val origin = "https://publisher.example.org/"
    private val image = byteArrayOf(1, 2, 3)

    @Test
    fun `public images need no referer`() = runBlocking {
        val server = Responses(ResponseSpec(200))
        assertArrayEquals(image, downloadArticleImage(asset, article, newCall = server.client::newCall))
        assertEquals(listOf(asset to null), server.requests)
    }

    @Test
    fun `only the blocked redirect target receives the article origin`() = runBlocking {
        val edge = "https://edge.example.org/image.png"
        val server = Responses(ResponseSpec(302, edge), ResponseSpec(403), ResponseSpec(200))
        assertArrayEquals(image, downloadArticleImage(asset, article, newCall = server.client::newCall))
        assertEquals(listOf(asset to null, edge to null, edge to origin), server.requests)
    }

    @Test
    fun `retry header stays on the same origin and is stripped on a later cross origin redirect`() = runBlocking {
        val resized = "https://cdn.example.org/resized.png"
        val other = "https://edge.example.org/image.png"
        val server = Responses(ResponseSpec(403), ResponseSpec(302, resized), ResponseSpec(302, other), ResponseSpec(403))
        val failure = runCatching { downloadArticleImage(asset, article, newCall = server.client::newCall) }.exceptionOrNull()
        assertTrue(failure is IOException)
        assertEquals(listOf(asset to null, asset to origin, resized to origin, other to null), server.requests)
    }

    @Test
    fun `a restrictive redirect or 403 policy stops a cross origin retry`() = runBlocking {
        val edge = "https://edge.example.org/image.png"
        val restrictedRedirect = Responses(
            ResponseSpec(302, edge, "origin, no-referrer, unsupported"), ResponseSpec(403),
        )
        val restrictedTarget = Responses(ResponseSpec(403, policy = "same-origin"))
        for (server in listOf(restrictedRedirect, restrictedTarget)) {
            val failure = runCatching { downloadArticleImage(asset, article, newCall = server.client::newCall) }.exceptionOrNull()
            assertTrue(failure is IOException)
        }
        assertEquals(listOf(asset to null, edge to null), restrictedRedirect.requests)
        assertEquals(listOf(asset to null), restrictedTarget.requests)
    }

    @Test
    fun `article policy governs the retry and same origin images can still recover`() = runBlocking {
        val sameOriginAsset = "$origin/image.png"
        val allowed = Responses(ResponseSpec(403), ResponseSpec(200))
        val forbidden = Responses(ResponseSpec(403))
        assertArrayEquals(image, downloadArticleImage(sameOriginAsset, article,
            ImageReferrerPolicy.SAME_ORIGIN, allowed.client::newCall))
        val failure = runCatching {
            downloadArticleImage(sameOriginAsset, article, ImageReferrerPolicy.NONE, forbidden.client::newCall)
        }.exceptionOrNull()
        assertTrue(failure is IOException)
        assertEquals(listOf(sameOriginAsset to null, sameOriginAsset to origin), allowed.requests)
        assertEquals(listOf(sameOriginAsset to null), forbidden.requests)
    }

    @Test
    fun `an invalid source or a different HTTP error cannot start the retry`() = runBlocking {
        val blocked = Responses(ResponseSpec(403))
        val other = Responses(ResponseSpec(404))
        val blockedFailure = runCatching {
            downloadArticleImage(asset, "https://127.0.0.1/article", newCall = blocked.client::newCall)
        }.exceptionOrNull()
        val missingFailure = runCatching { downloadArticleImage(asset, article, newCall = other.client::newCall) }.exceptionOrNull()
        assertTrue(blockedFailure is IOException)
        assertTrue(missingFailure is IOException)
        assertEquals(listOf(asset to null), blocked.requests)
        assertEquals(listOf(asset to null), other.requests)
    }

    private data class ResponseSpec(val status: Int, val location: String? = null, val policy: String? = null)

    private inner class Responses(vararg specs: ResponseSpec) {
        val requests = mutableListOf<Pair<String, String?>>()
        val client = OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
            val request: Request = chain.request()
            val spec = specs[requests.size]
            requests += request.url.toString() to request.header("Referer")
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(spec.status).message("fixture")
                .body(image.toResponseBody("image/webp".toMediaType()))
                .apply {
                    spec.location?.let { header("Location", it) }
                    spec.policy?.let { header("Referrer-Policy", it) }
                }
                .build()
        }.build()
    }
}
