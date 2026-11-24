package io.github.selectedtext.translator

import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

class TranslationClientTest {
    @Test
    fun streamsQwenTranslationAndSendsOnlySelectedText(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse()
                .setHeader("Content-Type", "text/event-stream; charset=utf-8")
                .setBody("data: ${streamChunk("思考")}\n\ndata: ${streamChunk("一下")}\n\ndata: [DONE]\n\n"))
            val previews = mutableListOf<String>()

            val result = client().lookup(config(server), "  Think about it.  ", LookupMode.TRANSLATE) { previews.add(it) }

            assertEquals("思考一下", result.text)
            assertEquals(listOf("思考", "思考一下"), previews)
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/compatible-mode/v1/chat/completions", request.path)
            assertEquals("Bearer mock-key", request.getHeader("Authorization"))
            val payload = JSONObject(request.body.readUtf8())
            assertEquals("Think about it.", payload.getJSONArray("messages").getJSONObject(0).getString("content"))
            assertEquals("Chinese", payload.getJSONObject("translation_options").getString("target_lang"))
            assertTrue(payload.getBoolean("stream"))
        }
    }

    @Test
    fun readsOrdinaryQwenJsonWhenTheServiceDoesNotStream(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("Hello"))
            val result = client().lookup(config(server), "你好", LookupMode.TRANSLATE) {}

            assertEquals("Hello", result.text)
            val payload = JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8())
            assertEquals("English", payload.getJSONObject("translation_options").getString("target_lang"))
        }
    }

    @Test
    fun usesGeneralModelForTranslationAndGuidedReading(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("""{"translation":"犹豫的","phonetic":"/rɪˈlʌktənt/"}"""))
            server.enqueue(jsonResponse("""{
                "guideType":"term","phonetic":"/rɪˈlʌktənt/",
                "hints":["Notice her pause.","She feels unsure.","Think about a difficult choice."],
                "answer":{"meaning":"Not eager to do something", "explanation":"She hesitates before agreeing.",
                          "example":"He was reluctant to leave."}
            }"""))
            val client = client()
            val config = config(server).copy(translationModel = "qwen-flash", learningModel = "")
            val translation = client.lookup(config, "reluctant", LookupMode.TRANSLATE) {}
            val guide = client.lookup(config, "reluctant", LookupMode.GUIDE) {}

            assertEquals("犹豫的", translation.text)
            assertEquals("/rɪˈlʌktənt/", translation.phonetic)
            assertEquals("Not eager to do something", guide.text)
            assertEquals(3, guide.hints.size)
            assertEquals("He was reluctant to leave.", guide.example)
            val translationPayload = JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8())
            assertFalse(translationPayload.getBoolean("enable_thinking"))
            assertEquals("json_object", translationPayload.getJSONObject("response_format").getString("type"))
            val guidePayload = JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8())
            assertEquals("qwen-flash", guidePayload.getString("model"))
            val input = JSONObject(guidePayload.getJSONArray("messages").getJSONObject(1).getString("content"))
            assertEquals("reluctant", input.getString("selectedText"))
            assertEquals("word", input.getString("selectionType"))
            assertEquals("", input.getString("surroundingContext"))
        }
    }

    @Test
    fun redactsProviderErrorsAndChecksHttps(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401).setBody("mock-key rejected"))
            val error = runCatching {
                client().lookup(config(server), "Hello", LookupMode.TRANSLATE) {}
            }.exceptionOrNull()
            assertTrue(error is ProviderException)
            assertFalse(error?.message.orEmpty().contains("mock-key"))
            assertTrue(error?.message.orEmpty().contains("API Key"))
        }

        assertEquals("/v1/chat/completions", TranslationClient.normalizeEndpoint("https://example.com/v1///").encodedPath)
        assertEquals("/v1/chat/completions", TranslationClient.normalizeEndpoint("https://example.com/v1/chat/completions/").encodedPath)
        assertThrows(ProviderException::class.java) {
            TranslationClient.normalizeEndpoint("http://example.com/v1", allowLoopbackHttp = true)
        }
        assertThrows(ProviderException::class.java) {
            TranslationClient.normalizeEndpoint("http://127.0.0.1/v1", allowLoopbackHttp = false)
        }
        assertThrows(ProviderException::class.java) {
            TranslationClient.normalizeEndpoint("https://user:secret@example.com/v1")
        }
    }

    @Test
    fun cancellationStopsDeliveringStreamUpdates(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: ${streamChunk("想")}\n\ndata: ${streamChunk("一下")}\n\ndata: [DONE]\n\n"))
            val previews = mutableListOf<String>()
            val job = launch {
                val requestJob = coroutineContext.job
                client().lookup(config(server), "Think about it", LookupMode.TRANSLATE) {
                    previews.add(it)
                    requestJob.cancel()
                }
            }

            withTimeout(3_000) { job.join() }

            assertTrue(job.isCancelled)
            assertEquals(listOf("想"), previews)
        }
    }

    private fun config(server: MockWebServer) = ProviderConfig(
        baseUrl = server.url("/compatible-mode/v1").toString(),
        apiKey = "mock-key",
        translationModel = "qwen-mt-flash",
        learningModel = "qwen-flash",
    )

    private fun client() = TranslationClient(createProviderHttpClient(), ModelContracts(templates), allowLoopbackHttp = true)

    private fun jsonResponse(content: String) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(completion("message", content))

    private fun streamChunk(content: String): String = completion("delta", content)

    private fun completion(field: String, content: String): String {
        val choice = JSONObject().put(field, JSONObject().put("content", content))
        return JSONObject().put("choices", JSONArray().put(choice)).toString()
    }

    private val templates = """
        {
          "translation": {
            "stream": false,
            "response_format": { "type": "json_object" },
            "messages": [{"role":"system","content":"Translate."},{"role":"user","content":""}]
          },
          "guide": {
            "stream": false,
            "response_format": { "type": "json_object" },
            "messages": [{"role":"system","content":"Guide."},{"role":"user","content":"{\"selectedText\":\"\",\"surroundingContext\":\"\"}"}]
          },
          "qwenMt": {
            "translation_options": {"source_lang":"auto"},
            "messages": [{"role":"user","content":""}]
          },
          "streamingQwenMtModels": ["qwen-mt-flash","qwen-mt-lite"]
        }
    """.trimIndent()
}
