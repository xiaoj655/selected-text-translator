package io.github.selectedtext.translator

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudSpeechClientTest {
    @Test
    fun sendsTheSelectedVoiceAndBuildsWaveFromPcmEvents() {
        MockWebServer().use { server ->
            server.enqueue(eventStream("""
                : heartbeat

                data: {"output":{"audio":{"data":"AQI="}}}

                data: {"output":{
                data: "audio":{"data":"AwQ="},
                data: "finish_reason":"stop"}}

            """.trimIndent() + "\n"))
            val client = CloudSpeechClient(endpoint = server.url("/speech"))
            val wave = runBlocking { client.synthesize("Hello, 世界。", "Custom Voice", "mock-key") }
            val request = server.takeRequest()
            assertEquals("/speech", request.path)
            assertEquals("Bearer mock-key", request.getHeader("Authorization"))
            assertEquals("enable", request.getHeader("X-DashScope-SSE"))
            val json = JSONObject(request.body.readUtf8())
            assertEquals("qwen3-tts-flash", json.getString("model"))
            val input = json.getJSONObject("input")
            assertEquals("Hello, 世界。", input.getString("text"))
            assertEquals("Custom Voice", input.getString("voice"))
            assertEquals("Auto", input.getString("language_type"))
            assertEquals("RIFF", wave.decodeToString(0, 4))
            assertEquals("WAVE", wave.decodeToString(8, 12))
            val header = ByteBuffer.wrap(wave).order(ByteOrder.LITTLE_ENDIAN)
            assertEquals(24_000, header.getInt(24))
            assertEquals(4, header.getInt(40))
            assertArrayEquals(byteArrayOf(1, 2, 3, 4), wave.copyOfRange(44, wave.size))
        }
    }

    @Test
    fun rejectsErrorsAndIncompleteAudio() {
        MockWebServer().use { server ->
            server.enqueue(eventStream("data: {\"code\":\"InvalidVoice\"}\n\n"))
            server.enqueue(eventStream("data: {\"output\":{\"audio\":{\"data\":\"AQI=\"}}}\n\n"))
            server.enqueue(eventStream("data: {\"output\":{\"finish_reason\":\"stop\"}}\n\n"))
            val client = CloudSpeechClient(endpoint = server.url("/speech"))
            for (attempt in 1..3) {
                assertThrows(IOException::class.java) {
                    runBlocking { client.synthesize("Test", "Aiden", "mock-key") }
                }
            }
        }
    }

    @Test
    fun rejectsRedirectsWithoutSendingTheKeyAgain() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", server.url("/redirect")))
            val client = CloudSpeechClient(endpoint = server.url("/speech"))
            assertThrows(IOException::class.java) {
                runBlocking { client.synthesize("Test", "Ryan", "mock-key") }
            }
            assertEquals(1, server.requestCount)
        }
    }

    @Test
    fun cancelsTheSynthesisWhileWaitingForAudio() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val client = CloudSpeechClient(endpoint = server.url("/speech"))
            val speech = launch(start = CoroutineStart.UNDISPATCHED) {
                client.synthesize("Test", "Jennifer", "mock-key")
                error("Playback must not start after cancellation.")
            }
            assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            speech.cancelAndJoin()
            assertTrue(speech.isCancelled)
        }
    }

    @Test
    fun reusesOnlyModelStudioCredentialsAndPrefersTheSpeechKey() {
        val provider = ProviderConfig(apiKey = "model-key")
        assertEquals("model-key", cloudSpeechApiKey(SpeechConfig(), provider))
        assertEquals("model-key", cloudSpeechApiKey(SpeechConfig(), provider.copy(baseUrl = provider.baseUrl + "/chat/completions")))
        val otherProvider = provider.copy(baseUrl = "https://api.example.com/v1")
        assertNull(cloudSpeechApiKey(SpeechConfig(), otherProvider))
        assertNull(cloudSpeechApiKey(SpeechConfig(), provider.copy(baseUrl = provider.baseUrl + "?token=secret")))
        val speech = SpeechConfig(apiKey = "private-speech-key")
        assertEquals("private-speech-key", cloudSpeechApiKey(speech, otherProvider))
        assertFalse(speech.toString().contains(speech.apiKey))
    }

    @Test
    fun acceptsVoiceIdsAndRejectsInvalidValues() {
        assertTrue(isCloudSpeechVoiceId("Voice ID"))
        assertFalse(isCloudSpeechVoiceId(" "))
        assertFalse(isCloudSpeechVoiceId("voice\nother"))
        assertFalse(isCloudSpeechVoiceId("a".repeat(121)))
    }

    private fun eventStream(body: String) =
        MockResponse().addHeader("Content-Type", "text/event-stream; charset=utf-8").setBody(body)
}
