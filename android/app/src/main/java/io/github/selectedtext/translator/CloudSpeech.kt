package io.github.selectedtext.translator

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
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
import okio.BufferedSource
import org.json.JSONObject

internal const val DEFAULT_CLOUD_SPEECH_VOICE = "Jennifer"
internal const val MAX_CLOUD_SPEECH_LENGTH = 600
internal val CLOUD_SPEECH_VOICES = listOf(DEFAULT_CLOUD_SPEECH_VOICE, "Aiden", "Katerina", "Ryan")

private const val DASHSCOPE_CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
private const val DASHSCOPE_SPEECH_URL =
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
private const val SAMPLE_RATE = 24_000
private const val MAX_AUDIO_BYTES = 12 * 1024 * 1024
private const val MAX_EVENT_BYTES = 4 * MAX_AUDIO_BYTES / 3 + 4096
private val JSON = "application/json".toMediaType()

internal fun isCloudSpeechVoiceId(value: String): Boolean =
    value.isNotBlank() && value.length <= 120 && value.none(Char::isISOControl)

internal fun isCloudSpeechApiKey(value: String): Boolean = value.isNotEmpty() && value.all { it in '!'..'~' }

internal fun cloudSpeechApiKey(speech: SpeechConfig, provider: ProviderConfig): String? {
    val speechKey = speech.apiKey.trim()
    if (speechKey.isNotEmpty()) return speechKey.takeIf(::isCloudSpeechApiKey)
    val endpoint = runCatching { TranslationClient.normalizeEndpoint(provider.baseUrl, allowLoopbackHttp = false) }
        .getOrNull()
    return provider.apiKey.trim().takeIf { endpoint?.toString() == DASHSCOPE_CHAT_URL && isCloudSpeechApiKey(it) }
}

internal class CloudSpeechClient(
    private val http: OkHttpClient = createProviderHttpClient().newBuilder().callTimeout(20, TimeUnit.SECONDS).build(),
    private val endpoint: HttpUrl = DASHSCOPE_SPEECH_URL.toHttpUrl(),
) {
    suspend fun synthesize(text: String, voice: String, apiKey: String): ByteArray {
        require(text.isNotBlank() && text.length <= MAX_CLOUD_SPEECH_LENGTH)
        require(isCloudSpeechVoiceId(voice) && isCloudSpeechApiKey(apiKey))
        val input = JSONObject().put("text", text).put("voice", voice).put("language_type", "Auto")
        val body = JSONObject().put("model", "qwen3-tts-flash").put("input", input)
        val request = Request.Builder().url(endpoint)
            .header("Authorization", "Bearer $apiKey")
            .header("X-DashScope-SSE", "enable")
            .post(body.toString().toRequestBody(JSON))
            .build()
        return suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching {
                        response.use {
                            val audio = it.body ?: throw IOException("Cloud speech returned no audio.")
                            if (!it.isSuccessful || audio.contentType()?.toString()?.substringBefore(';') != "text/event-stream") {
                                throw IOException("Cloud speech did not return an audio stream.")
                            }
                            readSpeechAudio(audio.source())
                        }
                    }
                    continuation.resumeWith(result)
                }
            })
        }
    }
}

private fun readSpeechAudio(source: BufferedSource): ByteArray {
    val pcm = ByteArrayOutputStream()
    val eventData = StringBuilder()
    while (!source.exhausted()) {
        val line = source.readUtf8LineStrict(MAX_EVENT_BYTES.toLong())
        if (line.startsWith("data:")) {
            if (eventData.length + line.length > MAX_EVENT_BYTES) throw IOException("Cloud speech audio was too large.")
            eventData.appendLine(line.substring(5).trimStart())
        } else if (line.isEmpty() && eventData.isNotEmpty()) {
            val event = JSONObject(eventData.toString())
            eventData.clear()
            if ((!event.isNull("code") && event.optString("code").isNotEmpty()) || event.optInt("status_code") >= 400) {
                throw IOException("Cloud speech synthesis failed.")
            }
            val output = event.optJSONObject("output") ?: continue
            val data = output.optJSONObject("audio")?.opt("data") as? String
            if (!data.isNullOrEmpty()) {
                val chunk = Base64.getDecoder().decode(data)
                if (pcm.size() + chunk.size > MAX_AUDIO_BYTES) throw IOException("Cloud speech audio was too large.")
                pcm.write(chunk)
            }
            if (output.optString("finish_reason") == "stop") return makeWave(pcm.toByteArray())
        }
    }
    throw IOException("Cloud speech ended before synthesis finished.")
}

private fun makeWave(pcm: ByteArray): ByteArray {
    if (pcm.isEmpty() || pcm.size % 2 != 0) throw IOException("Cloud speech returned invalid audio.")
    return ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
        .put("RIFF".toByteArray(Charsets.US_ASCII))
        .putInt(36 + pcm.size)
        .put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
        .putInt(16)
        .putShort(1)
        .putShort(1)
        .putInt(SAMPLE_RATE)
        .putInt(SAMPLE_RATE * 2)
        .putShort(2)
        .putShort(16)
        .put("data".toByteArray(Charsets.US_ASCII))
        .putInt(pcm.size)
        .put(pcm)
        .array()
}
