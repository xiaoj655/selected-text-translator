package io.github.selectedtext.translator

import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup

internal class IqsImportException(message: String) : ArticleImportException(message)

internal class IqsArticleImporter(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(55, TimeUnit.SECONDS)
        .callTimeout(60, TimeUnit.SECONDS)
        .build(),
    private val endpoint: HttpUrl = "https://cloud-iqs.aliyuncs.com/readpage/scrape".toHttpUrl(),
) {
    suspend fun fetch(url: HttpUrl, apiKey: String): ReadingArticle = suspendCancellableCoroutine { continuation ->
        val payload = JSONObject().put("url", url.toString()).put("maxAge", 0)
            .put("formats", JSONArray(listOf("html", "text")))
            .put("readability", JSONObject().put("readabilityMode", "article"))
        val request = Request.Builder().url(endpoint)
            .header("X-API-Key", apiKey)
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resumeWith(Result.failure(iqsNetworkError(e)))
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resumeWith(runCatching { response.use { readArticle(it, url) } }.recoverCatching { error ->
                    throw when (error) {
                        is IqsImportException -> error
                        is IOException -> iqsNetworkError(error)
                        else -> IqsImportException("IQS returned unreadable article data.")
                    }
                })
            }
        })
    }

    private fun readArticle(response: Response, originalUrl: HttpUrl): ReadingArticle {
        val body = response.body?.source() ?: throw iqsResponseError(response.code, "")
        if (body.request(4 * 1024 * 1024 + 1L)) throw IqsImportException("The IQS response was too large.")
        val json = try {
            JSONObject(body.readUtf8())
        } catch (_: org.json.JSONException) {
            throw iqsResponseError(response.code, "")
        }
        val error = json.string("errorCode")
        if (!response.isSuccessful || error.isNotBlank()) throw iqsResponseError(response.code, error)
        val data = json.optJSONObject("data") ?: throw IqsImportException("IQS returned no article.")
        if (data.optInt("statusCode", 200) !in 200..299 || data.string("errorMessage").isNotBlank()) {
            throw IqsImportException("IQS couldn't open the target page.")
        }
        val metadata = data.optJSONObject("metadata")
        val link = data.string("redirectedUrl").ifBlank {
            metadata?.string("redirectedUrl")?.ifBlank { metadata.string("url") }.orEmpty()
        }
        val finalUrl = originalUrl.resolve(link)?.let { runCatching { publicArticleUrl(it.toString()) }.getOrNull() } ?: originalUrl
        val title = metadata?.string("title")?.trim()?.take(200).orEmpty()
        val html = data.string("html")
        val article = html.takeIf(String::isNotBlank)?.let {
            try {
                extractArticle(Jsoup.parse(it, finalUrl.toString()), finalUrl.host, alreadyExtracted = true)
            } catch (error: MissingPsycheArticleException) {
                throw IqsImportException(error.message.orEmpty())
            } catch (_: ArticleImportException) {
                null
            }
        } ?: try {
            pastedArticle(data.string("text"), title)
        } catch (error: ArticleImportException) {
            throw IqsImportException(error.message ?: "IQS couldn't find readable article text.")
        }
        return article.copy(title = title.ifBlank { article.title }, sourceUrl = originalUrl.toString())
    }
}

private fun JSONObject.string(name: String): String = (opt(name) as? String).orEmpty()

private fun iqsNetworkError(error: IOException): IqsImportException =
    if (error is InterruptedIOException) IqsImportException("IQS timed out while parsing this page.")
    else IqsImportException("Couldn't connect to Alibaba Cloud IQS.")

private fun iqsResponseError(status: Int, code: String): IqsImportException = IqsImportException(when {
    status == 401 || code == "InvalidAccessKeyId.NotFound" -> "IQS rejected the API key. Check Reading settings."
    status == 403 || code == "Retrieval.NotActivate" || code == "Retrieval.NotAuthorised" ->
        "Check the IQS service and key permissions in Alibaba Cloud."
    status == 429 -> "IQS reached its request limit. Try again later."
    code == "ReadPage.RequestTimeout" -> "IQS timed out while opening the page."
    code == "ReadPage.SecurityRestrict" -> "IQS couldn't access this page under the site's access rules."
    status in 200..299 -> "IQS returned unreadable article data."
    else -> "IQS couldn't parse this page (HTTP $status)."
})
