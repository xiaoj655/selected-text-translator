package io.github.selectedtext.translator

import android.content.Context
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
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
        if (text.length > MAX_INPUT_LENGTH || selectedText.isEmpty()) {
            throw ProviderException("Enter 1 to 50,000 characters.")
        }
        val model = selectModel(config, mode)
        val isMt = isQwenMt(model)
        val requestBudget = when {
            isMt -> QWEN_MT_REQUEST_BYTES
            mode == LookupMode.GUIDE -> GUIDE_REQUEST_BYTES
            else -> GENERAL_TRANSLATION_REQUEST_BYTES
        }
        val chunks = splitLookupText(selectedText, requestBudget)
        val targetLanguage = translationTargetLanguage(selectedText)
            .takeIf { mode == LookupMode.TRANSLATE && (isMt || chunks.size > 1) }
        if (chunks.size == 1) {
            return lookupChunk(config, model, selectedText, mode, targetLanguage, onPartial)
        }

        val translation = StringBuilder()
        val guides = mutableListOf<LookupGuidePart>()
        for ((index, chunk) in chunks.withIndex()) {
            currentCoroutineContext().ensureActive()
            val prefix = translation.toString()
            val result = try {
                lookupChunk(config, model, chunk.text, mode, targetLanguage) { partial -> onPartial(prefix + partial) }
            } catch (error: ProviderException) {
                throw ProviderException("Part ${index + 1} of ${chunks.size}: ${error.message}")
            }
            if (mode == LookupMode.GUIDE) guides += LookupGuidePart(chunk.text, result)
            translation.append(result.text).append(chunk.separator)
            if (mode == LookupMode.TRANSLATE) onPartial(translation.toString())
        }
        return LookupResult(text = translation.toString(), parts = guides)
    }

    private suspend fun lookupChunk(
        config: ProviderConfig,
        model: String,
        text: String,
        mode: LookupMode,
        targetLanguage: String?,
        onPartial: (String) -> Unit,
    ): LookupResult {
        val isMt = isQwenMt(model)
        val request = contracts.buildRequest(model, text, mode, targetLanguage)
        return complete(config, request, onPartial = if (isMt) onPartial else { _ -> }) { content ->
            parseResult(content, text, mode, isMt)
        }
    }

    internal suspend fun testConnection(config: ProviderConfig): String {
        val translationModel = selectModel(config, LookupMode.TRANSLATE)
        val learningModel = config.learningModel.trim().ifEmpty { translationModel }
        testModel(config, translationModel, "Translation model")
        if (isQwenMt(learningModel)) return "Translation model connected. Set a learning model for reading."
        if (learningModel != translationModel) testModel(config, learningModel, "Learning model")
        return "Translation and learning models connected."
    }

    private suspend fun testModel(config: ProviderConfig, model: String, label: String) {
        val request = if (isQwenMt(model)) {
            contracts.buildRequest(model, "Hello.", LookupMode.TRANSLATE)
        } else {
            JSONObject().put("model", model).put("stream", false).put(
                "messages",
                JSONArray().put(JSONObject().put("role", "user").put("content", "Reply with OK.")),
            ).apply { if (model.startsWith("qwen", ignoreCase = true)) put("enable_thinking", false) }
        }
        try {
            complete(config, request) { content ->
                if (content.isBlank()) throw ProviderException("The model returned no text. Try again.")
            }
        } catch (error: ProviderException) {
            throw ProviderException("$label: ${error.message}")
        }
    }

    internal suspend fun lookupArticle(config: ProviderConfig, selection: ArticleSelection): ArticleMeaning {
        validateArticleInput(selection.text)
        val model = selectLearningModel(config, "Choose a general-purpose learning model in Settings to look up articles.")
        return complete(config, contracts.buildArticleMeaningRequest(model, selection)) { content ->
            parseArticleMeaning(JSONObject(content), selection.kind == ArticleSelectionKind.WORD)
        }
    }

    internal suspend fun guideArticle(config: ProviderConfig, selection: ArticleSelection): LookupResult {
        validateArticleInput(selection.text)
        val model = selectLearningModel(config, "Choose a general-purpose learning model in Settings for Guided Reading.")
        return complete(config, contracts.buildArticleGuideRequest(model, selection)) { content ->
            parseResult(content, selection.text, LookupMode.GUIDE, isMt = false)
        }
    }

    internal suspend fun analyzeArticleSentence(
        config: ProviderConfig,
        selection: ArticleSelection,
    ): ArticleSentenceAnalysis {
        validateArticleInput(selection.sentence)
        val model = selectLearningModel(config, "Choose a general-purpose learning model in Settings for sentence analysis.")
        return complete(config, contracts.buildArticleAnalysisRequest(model, selection.sentence)) { content ->
            parseArticleSentenceAnalysis(JSONObject(content), selection.sentence)
        }
    }

    private suspend fun <T> complete(
        config: ProviderConfig,
        requestBody: JSONObject,
        onPartial: (String) -> Unit = {},
        parse: (String) -> T,
    ): T {
        val endpoint = normalizeEndpoint(config.baseUrl, allowLoopbackHttp)
        val apiKey = config.apiKey.trim()
        if (apiKey.isEmpty() || apiKey.any { it !in '!'..'~' }) {
            throw ProviderException("Check your API Key in Settings.")
        }
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
                                if (continuation.isActive) onPartial(partial)
                            }
                            parse(content)
                        }
                    }.recoverCatching { error ->
                        throw when (error) {
                            is IOException -> networkError(error)
                            is JSONException -> ProviderException("The model returned invalid data. Try again.")
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
                ?: throw ProviderException("Enter a valid HTTPS API URL.")
            val localDebug = allowLoopbackHttp && url.host in setOf("127.0.0.1", "localhost")
            if ((!url.isHttps && !localDebug) || url.username.isNotEmpty() || url.password.isNotEmpty() ||
                url.query != null || url.fragment != null
            ) {
                throw ProviderException("Enter an HTTPS API URL without credentials, query parameters, or a fragment.")
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
    private val translationByLanguage = contracts.getJSONObject("translationByLanguage")
    private val guide = contracts.getJSONObject("guide").toString()
    private val qwenMt = contracts.getJSONObject("qwenMt").toString()
    private val streamingQwenMtModels = contracts.getJSONArray("streamingQwenMtModels").strings().toSet()

    fun buildRequest(model: String, text: String, mode: LookupMode, targetLanguage: String? = null): JSONObject {
        val isMt = isQwenMt(model)
        val template = when {
            mode == LookupMode.GUIDE -> guide
            isMt -> qwenMt
            targetLanguage != null -> translationByLanguage.getJSONObject(targetLanguage).toString()
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
            request.getJSONObject("translation_options").put("target_lang", targetLanguage ?: translationTargetLanguage(text))
        } else if (model.startsWith("qwen", ignoreCase = true)) {
            request.put("enable_thinking", false)
        }
        return request
    }

    fun buildArticleMeaningRequest(model: String, selection: ArticleSelection): JSONObject =
        articleRequest("articleMeaning", model, articleMeaningInput(selection))

    fun buildArticleGuideRequest(model: String, selection: ArticleSelection): JSONObject =
        articleRequest("guide", model, articleMeaningInput(selection))

    fun buildArticleAnalysisRequest(model: String, sentence: String): JSONObject =
        articleRequest(
            "articleExplanation",
            model,
            JSONObject()
                .put("selectedText", sentence)
                .put("surroundingContext", "")
                .put("selectionType", readingSelectionType(sentence))
                .put("targetLanguage", "English"),
        )

    private fun articleRequest(template: String, model: String, input: JSONObject): JSONObject {
        val request = JSONObject(contracts.getJSONObject(template).toString()).put("model", model)
        request.getJSONArray("messages").getJSONObject(1).put("content", input.toString())
        if (model.startsWith("qwen", ignoreCase = true)) request.put("enable_thinking", false)
        return request
    }
}

private const val MAX_RESPONSE_BYTES = 512_000L
// Qwen-MT has a smaller context than general chat models. Bound the UTF-8 input conservatively.
private const val QWEN_MT_REQUEST_BYTES = 6_000
private const val GUIDE_REQUEST_BYTES = 8_000
private const val GENERAL_TRANSLATION_REQUEST_BYTES = 12_000
private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
private val CHINESE_CHAR = Regex("[\\u3400-\\u9fff]")
private val SINGLE_WORD = Regex("^[\\p{L}]+(?:['’\\-][\\p{L}]+)*$")
private val GUIDED_WORD = Regex("^[\\p{L}\\p{N}]+(?:['’\\-][\\p{L}\\p{N}]+)*$")
private val SENTENCE_END = Regex("[.!?。！？\n]")
private val WORD_SEPARATOR = Regex("[\\s\\p{Z}\uFEFF]+")

private fun isQwenMt(model: String): Boolean = model.contains("qwen-mt", ignoreCase = true)

private fun translationTargetLanguage(text: String): String = if (CHINESE_CHAR.containsMatchIn(text)) "English" else "Chinese"

private fun validateArticleInput(text: String) {
    if (text.isEmpty() || text.length > MAX_ARTICLE_LOOKUP_LENGTH) {
        throw ProviderException("Select up to 12,000 characters to look up.")
    }
}

private data class LookupChunk(val text: String, val separator: String)

private val LINE_BREAKS = charArrayOf('\n', '\r')
private val SENTENCE_BREAKS = charArrayOf('.', '!', '?', '。', '！', '？')

private fun splitLookupText(text: String, byteLimit: Int): List<LookupChunk> {
    val chunks = mutableListOf<LookupChunk>()
    var start = 0
    while (start < text.length) {
        val limit = utf8PrefixEnd(text, start, byteLimit)
        if (limit == text.length) {
            chunks.add(LookupChunk(text.substring(start), ""))
            break
        }
        val midpoint = start + (limit - start) / 2
        val lineEnd = text.lastIndexOfAny(LINE_BREAKS, limit - 1) + 1
        val sentenceEnd = text.lastIndexOfAny(SENTENCE_BREAKS, limit - 1) + 1
        val end = when {
            lineEnd > midpoint -> lineEnd
            sentenceEnd > midpoint -> sentenceEnd
            else -> (limit - 1 downTo midpoint).firstOrNull { text[it].isWhitespace() } ?: limit
        }
        var contentEnd = end
        while (contentEnd > start && text[contentEnd - 1].isWhitespace()) contentEnd--
        var nextStart = end
        while (nextStart < text.length && text[nextStart].isWhitespace()) nextStart++
        chunks.add(LookupChunk(text.substring(start, contentEnd), text.substring(contentEnd, nextStart)))
        start = nextStart
    }
    return chunks
}

private fun utf8PrefixEnd(text: String, start: Int, byteLimit: Int): Int {
    var end = start
    var bytes = 0
    while (end < text.length) {
        val codePoint = text.codePointAt(end)
        bytes += when {
            codePoint < 0x80 -> 1
            codePoint < 0x800 -> 2
            codePoint < 0x10000 -> 3
            else -> 4
        }
        if (bytes > byteLimit) break
        end += Character.charCount(codePoint)
    }
    return end
}

private fun selectModel(config: ProviderConfig, mode: LookupMode): String {
    val translationModel = config.translationModel.trim()
    if (mode == LookupMode.TRANSLATE) {
        if (translationModel.isEmpty()) throw ProviderException("Choose a translation model in Settings.")
        return translationModel
    }
    return selectLearningModel(config, "Choose a general-purpose learning model in Settings for Guided Reading.")
}

private fun selectLearningModel(config: ProviderConfig, message: String): String {
    val learningModel = config.learningModel.trim().ifEmpty { config.translationModel.trim() }
    if (learningModel.isEmpty() || isQwenMt(learningModel)) {
        throw ProviderException(message)
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
    val body = response.body ?: throw ProviderException("The model returned no content. Try again.")
    if (body.contentType()?.let { it.type == "text" && it.subtype == "event-stream" } == true) {
        return readStream(body, onPartial)
    }
    val source = body.source()
    if (source.request(MAX_RESPONSE_BYTES + 1)) throw ProviderException("The response was too long. Try selecting less text.")
    val choice = JSONObject(source.readString(body.contentType()?.charset(Charsets.UTF_8) ?: Charsets.UTF_8)).firstChoice()
    checkFinishReason(choice)
    val content = choice?.optJSONObject("message")?.opt("content")
    return when (content) {
        is String -> content
        is JSONArray -> (0 until content.length()).joinToString("") { index ->
            content.optJSONObject(index)?.string("text").orEmpty()
        }
        else -> throw ProviderException("The model returned no text. Try again.")
    }.trim()
}

private fun readStream(body: ResponseBody, onPartial: (String) -> Unit): String {
    val source = body.source()
    val content = StringBuilder()
    while (!source.exhausted()) {
        val delimiter = source.indexOf('\n'.code.toByte(), 0, MAX_RESPONSE_BYTES)
        if (delimiter < 0 && source.buffer.size >= MAX_RESPONSE_BYTES) {
            throw ProviderException("The response was too long. Try selecting less text.")
        }
        val line = source.readUtf8Line()?.trimStart() ?: break
        if (!line.startsWith("data:")) continue
        val data = line.substringAfter(':').trim()
        if (data == "[DONE]") break
        if (data.isEmpty()) continue
        val event = JSONObject(data)
        if (event.has("error")) throw ProviderException("The model service returned an error. Try again.")
        val choice = event.firstChoice()
        checkFinishReason(choice)
        val delta = choice?.optJSONObject("delta")?.opt("content") as? String
        val fullMessage = choice?.optJSONObject("message")?.opt("content") as? String
        when {
            !delta.isNullOrEmpty() -> content.append(delta)
            !fullMessage.isNullOrEmpty() -> content.replace(0, content.length, fullMessage)
            else -> continue
        }
        if (content.length > MAX_RESPONSE_BYTES) throw ProviderException("The response was too long. Try selecting less text.")
        onPartial(content.toString())
    }
    return content.toString().trim()
}

private fun checkFinishReason(choice: JSONObject?) {
    if (choice?.optString("finish_reason") == "length") {
        throw ProviderException("The model stopped before completing the response. Try selecting less text.")
    }
}

private fun parseResult(content: String, sourceText: String, mode: LookupMode, isMt: Boolean): LookupResult {
    if (content.isBlank()) throw ProviderException("The model returned no text. Try again.")
    if (isMt) return LookupResult(text = content)
    val result = JSONObject(content)
    if (mode == LookupMode.TRANSLATE) {
        val translation = result.string("translation").trim()
        if (translation.isEmpty()) throw ProviderException("The model returned no translation. Try again.")
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
        throw ProviderException("The learning model returned incomplete guidance. Try again.")
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
    ProviderException("The request timed out. Try again.")
} else {
    ProviderException("Could not reach the model service. Check your connection and API URL.")
}

private fun responseError(code: Int): ProviderException = ProviderException(when (code) {
    400 -> "The model rejected this request format. Check your model settings."
    401 -> "The model service rejected the API Key. Check it in Settings."
    403 -> "This API Key does not have access to the model."
    404 -> "Model or service not found. Check the API URL and model name."
    408, 504 -> "The request timed out. Try again."
    429 -> "The model service is rate limiting requests. Try again shortly."
    in 300..399 -> "The model service redirected the request. Enter its final API URL in Settings."
    in 500..599 -> "The model service is temporarily unavailable ($code). Try again shortly."
    else -> "The model request failed ($code). Try again."
})
