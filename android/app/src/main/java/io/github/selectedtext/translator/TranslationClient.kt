package io.github.selectedtext.translator

import android.content.Context
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

class ProviderException(message: String) : Exception(message)

class TranslationClient internal constructor(
    private val http: OkHttpClient,
    private val contracts: ModelContracts,
    private val allowLoopbackHttp: Boolean = BuildConfig.DEBUG,
) {
    constructor(context: Context) : this(
        createProviderHttpClient(),
        ModelContracts(context.assets.open("model-contracts.json").bufferedReader().use { it.readText() }),
    )

    suspend fun lookup(
        config: ProviderConfig,
        text: String,
        mode: LookupMode,
        onPartial: (String) -> Unit,
    ): LookupResult {
        val selectedText = text.trim()
        if (selectedText.isEmpty() || selectedText.length > MAX_INPUT_LENGTH) {
            throw ProviderException("请输入 1 至 12,000 字符的文字。")
        }
        val endpoint = normalizeEndpoint(config.baseUrl, allowLoopbackHttp)
        val apiKey = config.apiKey.trim()
        if (apiKey.isEmpty() || apiKey.any { it !in '!'..'~' }) {
            throw ProviderException("请在设置中检查 API Key。")
        }
        val model = selectModel(config, mode)
        val isMt = isQwenMt(model)
        val requestBody = contracts.buildRequest(model, selectedText, mode)
        val request = Request.Builder()
            .url(endpoint)
            .header("Authorization", "Bearer $apiKey")
            .post(requestBody.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWith(Result.failure(networkError(e)))
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching {
                        response.use {
                            val content = readResponse(it) { partial ->
                                if (isMt && continuation.isActive) onPartial(partial)
                            }
                            parseResult(content, selectedText, mode, isMt)
                        }
                    }.recoverCatching { error ->
                        throw when (error) {
                            is IOException -> networkError(error)
                            is JSONException -> ProviderException("模型返回的数据格式有误，请重试。")
                            else -> error
                        }
                    }
                    continuation.resumeWith(result)
                }
            })
        }
    }

    companion object {
        fun normalizeEndpoint(baseUrl: String): HttpUrl = normalizeEndpoint(baseUrl, BuildConfig.DEBUG)

        internal fun normalizeEndpoint(baseUrl: String, allowLoopbackHttp: Boolean): HttpUrl {
            val url = baseUrl.trim().toHttpUrlOrNull()
                ?: throw ProviderException("请输入有效的 HTTPS API 地址。")
            val localDebug = allowLoopbackHttp && url.host in setOf("127.0.0.1", "localhost")
            if ((!url.isHttps && !localDebug) || url.username.isNotEmpty() || url.password.isNotEmpty() ||
                url.query != null || url.fragment != null
            ) {
                throw ProviderException("请输入有效的 HTTPS API 地址，去掉地址中的凭据、查询参数和片段标识。")
            }
            val path = url.encodedPath.trimEnd('/')
            val endpointPath = if (path.endsWith("/chat/completions")) path else "$path/chat/completions"
            return url.newBuilder().encodedPath(endpointPath).build()
        }
    }
}

internal fun createProviderHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(25, TimeUnit.SECONDS)
    .callTimeout(35, TimeUnit.SECONDS)
    .followRedirects(false)
    .retryOnConnectionFailure(false)
    .build()

internal class ModelContracts(json: String) {
    private val contracts = JSONObject(json)
    private val translation = contracts.getJSONObject("translation").toString()
    private val guide = contracts.getJSONObject("guide").toString()
    private val qwenMt = contracts.getJSONObject("qwenMt").toString()
    private val streamingQwenMtModels = contracts.getJSONArray("streamingQwenMtModels").strings().toSet()

    fun buildRequest(model: String, text: String, mode: LookupMode): JSONObject {
        val isMt = isQwenMt(model)
        val template = when {
            mode == LookupMode.GUIDE -> guide
            isMt -> qwenMt
            else -> translation
        }
        val request = JSONObject(template).put("model", model)
        val messages = request.getJSONArray("messages")
        val userMessage = messages.getJSONObject(messages.length() - 1)
        if (mode == LookupMode.GUIDE) {
            val guideInput = JSONObject(userMessage.getString("content"))
                .put("selectedText", text)
                .put("selectionType", readingSelectionType(text))
            userMessage.put("content", guideInput.toString())
        } else {
            userMessage.put("content", text)
        }
        if (isMt) {
            request.put("stream", model.lowercase() in streamingQwenMtModels)
            val targetLanguage = if (CHINESE_CHAR.containsMatchIn(text)) "English" else "Chinese"
            request.getJSONObject("translation_options").put("target_lang", targetLanguage)
        } else if (model.startsWith("qwen", ignoreCase = true)) {
            request.put("enable_thinking", false)
        }
        return request
    }
}

private const val MAX_RESPONSE_BYTES = 512_000L
private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
private val CHINESE_CHAR = Regex("[\\u3400-\\u9fff]")
private val SINGLE_WORD = Regex("^[\\p{L}]+(?:['’\\-][\\p{L}]+)*$")
private val GUIDED_WORD = Regex("^[\\p{L}\\p{N}]+(?:['’\\-][\\p{L}\\p{N}]+)*$")
private val SENTENCE_END = Regex("[.!?。！？\n]")
private val WORD_SEPARATOR = Regex("[\\s\\p{Z}\uFEFF]+")

private fun isQwenMt(model: String): Boolean = model.contains("qwen-mt", ignoreCase = true)

private fun selectModel(config: ProviderConfig, mode: LookupMode): String {
    val translationModel = config.translationModel.trim()
    if (mode == LookupMode.TRANSLATE) {
        if (translationModel.isEmpty()) throw ProviderException("请在设置中选择翻译模型。")
        return translationModel
    }
    val learningModel = config.learningModel.trim().ifEmpty { translationModel }
    if (learningModel.isEmpty() || isQwenMt(learningModel)) {
        throw ProviderException("请在设置中为引导理解选择通用模型。")
    }
    return learningModel
}

private fun readingSelectionType(text: String): String = when {
    GUIDED_WORD.matches(text) -> "word"
    !SENTENCE_END.containsMatchIn(text) && text.split(WORD_SEPARATOR).size <= 12 -> "phrase"
    else -> "passage"
}

private fun readResponse(response: Response, onPartial: (String) -> Unit): String {
    if (!response.isSuccessful) throw responseError(response.code)
    val body = response.body ?: throw ProviderException("模型未返回内容，请重试。")
    if (body.contentType()?.let { it.type == "text" && it.subtype == "event-stream" } == true) {
        return readStream(body, onPartial)
    }
    val source = body.source()
    if (source.request(MAX_RESPONSE_BYTES + 1)) throw ProviderException("模型返回的内容过长，请缩短原文后重试。")
    val choice = JSONObject(source.readString(body.contentType()?.charset(Charsets.UTF_8) ?: Charsets.UTF_8)).firstChoice()
    val content = choice?.optJSONObject("message")?.opt("content")
    return when (content) {
        is String -> content
        is JSONArray -> (0 until content.length()).joinToString("") { index ->
            content.optJSONObject(index)?.string("text").orEmpty()
        }
        else -> throw ProviderException("模型未返回文本，请重试。")
    }.trim()
}

private fun readStream(body: ResponseBody, onPartial: (String) -> Unit): String {
    val source = body.source()
    val content = StringBuilder()
    while (!source.exhausted()) {
        val delimiter = source.indexOf('\n'.code.toByte(), 0, MAX_RESPONSE_BYTES)
        if (delimiter < 0 && source.buffer.size >= MAX_RESPONSE_BYTES) {
            throw ProviderException("模型返回的内容过长，请缩短原文后重试。")
        }
        val line = source.readUtf8Line()?.trimStart() ?: break
        if (!line.startsWith("data:")) continue
        val data = line.substringAfter(':').trim()
        if (data == "[DONE]") break
        if (data.isEmpty()) continue
        val event = JSONObject(data)
        if (event.has("error")) throw ProviderException("模型服务返回异常，请重试。")
        val choice = event.firstChoice()
        val delta = choice?.optJSONObject("delta")?.opt("content") as? String
        val fullMessage = choice?.optJSONObject("message")?.opt("content") as? String
        when {
            !delta.isNullOrEmpty() -> content.append(delta)
            !fullMessage.isNullOrEmpty() -> content.replace(0, content.length, fullMessage)
            else -> continue
        }
        if (content.length > MAX_RESPONSE_BYTES) throw ProviderException("模型返回的内容过长，请缩短原文后重试。")
        onPartial(content.toString())
    }
    return content.toString().trim()
}

private fun parseResult(content: String, sourceText: String, mode: LookupMode, isMt: Boolean): LookupResult {
    if (content.isBlank()) throw ProviderException("模型未返回文本，请重试。")
    if (isMt) return LookupResult(text = content)
    val result = JSONObject(content)
    if (mode == LookupMode.TRANSLATE) {
        val translation = result.string("translation").trim()
        if (translation.isEmpty()) throw ProviderException("模型未返回译文，请重试。")
        val phonetic = if (SINGLE_WORD.matches(sourceText)) result.string("phonetic").trim() else ""
        return LookupResult(text = translation, phonetic = phonetic)
    }

    val selectionType = readingSelectionType(sourceText)
    val isSentence = selectionType != "word" &&
        (result.string("guideType") == "sentence" || !result.has("guideType") && selectionType == "passage")
    val hints = result.optJSONArray("hints").strings().map { it.trim() }.filter { it.isNotEmpty() }
    val answer = result.optJSONObject("answer")
    val meaning = answer?.string("meaning")?.trim().orEmpty()
    val explanation = answer?.string("explanation")?.trim().orEmpty()
    val example = answer?.string("example")?.trim().orEmpty()
    val validHints = if (isSentence) hints.size in 1..3 else hints.size == 3
    if (!validHints || meaning.isEmpty() || explanation.isEmpty() || !isSentence && example.isEmpty()) {
        throw ProviderException("学习模型返回的引导内容不完整，请重试。")
    }
    return LookupResult(
        text = meaning,
        phonetic = if (selectionType == "word") result.string("phonetic").trim() else "",
        hints = hints,
        explanation = explanation,
        example = example,
    )
}

private fun JSONObject.firstChoice(): JSONObject? = optJSONArray("choices")?.optJSONObject(0)

private fun JSONObject.string(key: String): String = opt(key) as? String ?: ""

private fun JSONArray?.strings(): List<String> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { opt(it) as? String }
}

private fun networkError(error: IOException): ProviderException = if (error is InterruptedIOException) {
    ProviderException("请求超时，请重试。")
} else {
    ProviderException("无法连接模型服务，请检查网络和 API 地址。")
}

private fun responseError(code: Int): ProviderException = ProviderException(when (code) {
    400 -> "模型拒绝了请求，请确认它支持当前请求格式。"
    401 -> "模型服务拒绝了 API Key，请在设置中检查。"
    403 -> "当前 API Key 无权访问此模型。"
    404 -> "找不到模型或服务，请检查 API 地址和模型名称。"
    408, 504 -> "请求超时，请重试。"
    429 -> "模型服务限制了请求频率，请稍后重试。"
    in 300..399 -> "模型服务返回了重定向，请在设置中填写最终的 API 地址。"
    in 500..599 -> "模型服务暂时不可用（$code），请稍后重试。"
    else -> "模型请求失败（$code），请重试。"
})
