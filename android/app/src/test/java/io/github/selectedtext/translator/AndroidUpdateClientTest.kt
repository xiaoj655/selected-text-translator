package io.github.selectedtext.translator

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest
import okio.ByteString.Companion.toByteString

class AndroidUpdateClientTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `chooses the highest Android version across pages and follows GitHub asset redirect`() {
        val requestedMetadata = mutableListOf<String>()
        val client = client { request ->
            when (request.url.host) {
                "api.github.com" -> if (request.url.queryParameter("page") == "1") {
                    request.respond(JSONArray().put(release("8.0.0", prerelease = true)).put(release("0.2.0"))
                        .put(release("9.0.0", withMetadata = false)).toString(),
                        headers = mapOf("Link" to "<${request.url}>; rel=\"next\""))
                } else {
                    request.respond(JSONArray().put(release("0.10.0")).toString())
                }
                "github.com" -> {
                    requestedMetadata += request.url.encodedPath
                    request.respond("", code = 302, headers = mapOf(
                        "Location" to "https://release-assets.githubusercontent.com/metadata",
                    ))
                }
                "release-assets.githubusercontent.com" -> request.respond(metadata("0.10.0", 10).toString())
                else -> error("Unexpected URL ${request.url}")
            }
        }

        val update = runBlocking { client.checkForUpdate() }

        assertEquals("0.10.0", update?.versionName)
        assertEquals(10, update?.versionCode)
        assertEquals(listOf("/$REPOSITORY/releases/download/android-v0.10.0/update.json"), requestedMetadata)
    }

    @Test
    fun `ignores current and historical releases without update metadata`() {
        val releases = JSONArray()
            .put(release("0.1.2"))
            .put(release("0.1.1"))
            .put(release("1.0.0", withMetadata = false))
        val client = client { request ->
            assertEquals("api.github.com", request.url.host)
            request.respond(releases.toString())
        }
        assertNull(runBlocking { client.checkForUpdate() })
    }

    @Test
    fun `refuses update metadata that disagrees with the release digest`() {
        val badMetadata = metadata("0.2.0", 4).put("sha256", "f".repeat(64))
        val client = client { request ->
            when (request.url.host) {
                "api.github.com" -> request.respond(JSONArray().put(release("0.2.0")).toString())
                "github.com" -> request.respond(badMetadata.toString())
                else -> error("Unexpected URL ${request.url}")
            }
        }
        assertThrows(AndroidUpdateException::class.java) { runBlocking { client.checkForUpdate() } }
    }

    @Test
    fun `refuses redirects outside approved GitHub HTTPS asset hosts`() {
        val client = client { request ->
            when (request.url.host) {
                "api.github.com" -> request.respond(JSONArray().put(release("0.2.0")).toString())
                "github.com" -> request.respond("", code = 302, headers = mapOf(
                    "Location" to "http://release-assets.githubusercontent.com/metadata",
                ))
                else -> error("Unexpected request following an unsafe redirect")
            }
        }
        assertThrows(AndroidUpdateException::class.java) { runBlocking { client.checkForUpdate() } }
    }

    @Test
    fun `fails rate-limited update requests with an actionable error`() {
        val client = client { request ->
            request.respond("", code = 403, headers = mapOf("X-RateLimit-Remaining" to "0"))
        }
        val error = assertThrows(AndroidUpdateException::class.java) { runBlocking { client.checkForUpdate() } }
        assertTrue(error.message.orEmpty().contains("rate limit"))
    }

    @Test
    fun `publishes downloaded files to the installer cache only after verification`() {
        val client = client(verifyApk = { file, update ->
            assertEquals(4, update.versionCode)
            assertArrayEquals(APK.toByteArray(), file.readBytes())
            assertEquals(temporaryFolder.root, file.parentFile)
            assertTrue(File(temporaryFolder.root, "updates").list().orEmpty().isEmpty())
        }) { request -> apkResponse(request, APK) }

        val result = runBlocking { client.download(checkNotNull(client.checkForUpdate())) }

        assertArrayEquals(APK.toByteArray(), result.readBytes())
        assertEquals(File(temporaryFolder.root, "updates/update-4.apk"), result)
        assertEquals(listOf("updates"), temporaryFolder.root.list().orEmpty().toList())
    }

    @Test
    fun `rejects corrupted APK before verification and removes the temporary file`() {
        val tamperedApk = "X" + APK.drop(1)
        val client = client(verifyApk = { _, _ -> error("Corrupt file reached APK verification") }) { request ->
            apkResponse(request, tamperedApk)
        }

        val update = runBlocking { checkNotNull(client.checkForUpdate()) }
        val error = assertThrows(AndroidUpdateException::class.java) { runBlocking { client.download(update) } }

        assertTrue(error.message.orEmpty().contains("failed verification"))
        assertEquals(emptyList<File>(), temporaryFolder.root.walk().filter { it.isFile }.toList())
    }

    private fun client(
        verifyApk: (File, AndroidUpdate) -> Unit = { _, _ -> },
        responseFor: (Request) -> Response,
    ): AndroidUpdateClient {
        val http: OkHttpClient = createUpdateHttpClient().newBuilder()
            .addInterceptor { responseFor(it.request()) }
            .build()
        return AndroidUpdateClient(http, RELEASE_APPLICATION_ID, "0.1.2", 3, temporaryFolder.root, verifyApk)
    }

    private fun apkResponse(request: Request, content: String): Response = when {
        request.url.host == "api.github.com" -> request.respond(JSONArray().put(release("0.2.0")).toString())
        request.url.pathSegments.last() == "update.json" -> request.respond(metadata("0.2.0", 4).toString())
        else -> request.respond(content)
    }
}

private const val REPOSITORY = "xiaoj655/selected-text-translator"
private const val RELEASE_APPLICATION_ID = "io.github.selectedtext.translator"
private const val APK = "simulated APK bytes"
private val APK_SHA256 = MessageDigest.getInstance("SHA-256").digest(APK.toByteArray()).toByteString().hex()

private fun apkName(version: String) = "selected-text-translator-android-$version.apk"

private fun release(version: String, prerelease: Boolean = false, withMetadata: Boolean = true): JSONObject {
    val apk = releaseAsset(version, apkName(version))
        .put("size", APK.toByteArray().size)
        .put("digest", "sha256:$APK_SHA256")
    val assets = JSONArray().put(apk)
    if (withMetadata) assets.put(releaseAsset(version, "update.json"))
    return JSONObject().put("tag_name", "android-v$version").put("assets", assets).put("prerelease", prerelease)
}

private fun releaseAsset(version: String, name: String): JSONObject = JSONObject()
    .put("name", name)
    .put("state", "uploaded")
    .put("browser_download_url", "https://github.com/$REPOSITORY/releases/download/android-v$version/$name")

private fun metadata(version: String, versionCode: Int): JSONObject = JSONObject()
    .put("applicationId", RELEASE_APPLICATION_ID)
    .put("versionName", version)
    .put("versionCode", versionCode)
    .put("fileName", apkName(version))
    .put("bytes", APK.toByteArray().size)
    .put("sha256", APK_SHA256)

private fun Request.respond(body: String, code: Int = 200, headers: Map<String, String> = emptyMap()): Response =
    Response.Builder().request(this).protocol(Protocol.HTTP_1_1).code(code).message("Test response")
        .body(body.toResponseBody()).apply { headers.forEach { (name, value) -> header(name, value) } }.build()
