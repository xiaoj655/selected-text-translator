package io.github.selectedtext.translator

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class AndroidUpdate internal constructor(
    val versionName: String,
    val versionCode: Int,
    internal val apkUrl: HttpUrl,
    internal val sha256: String,
    internal val bytes: Long,
)

class AndroidUpdateException(message: String, cause: Throwable? = null) : IOException(message, cause)

class AndroidUpdateClient internal constructor(
    private val http: OkHttpClient,
    private val applicationId: String,
    private val installedVersionName: String,
    private val installedVersionCode: Int,
    private val cacheDir: File,
    private val verifyApk: (File, AndroidUpdate) -> Unit,
) {
    constructor(context: Context) : this(
        createUpdateHttpClient(),
        context.packageName,
        BuildConfig.VERSION_NAME,
        BuildConfig.VERSION_CODE,
        context.cacheDir,
        { file, update -> verifyPackage(context.applicationContext, file, update) },
    )

    suspend fun checkForUpdate(): AndroidUpdate? {
        val installedVersion = ReleaseVersion.parse(installedVersionName) ?: throw invalidMetadata()
        var page = 1
        var latest: ReleaseAssets? = null
        do {
            val url = RELEASES_API.newBuilder()
                .addQueryParameter("per_page", "100")
                .addQueryParameter("page", page.toString())
                .build()
            val (candidate, hasNextPage) = request(url) { response, body ->
                val releases = JSONArray(body.readLimitedText(MAX_RELEASE_LIST_BYTES))
                val best = (0 until releases.length()).mapNotNull { index ->
                    readRelease(releases.getJSONObject(index), installedVersion)
                }.maxByOrNull { it.version }
                best to response.headers("Link").any { NEXT_PAGE_LINK.containsMatchIn(it) }
            }
            val selected = latest
            if (candidate != null && (selected == null || candidate.version > selected.version)) {
                latest = candidate
            }
            page++
        } while (hasNextPage)

        val release = latest ?: return null
        return request(release.metadataUrl) { _, body ->
            val metadata = JSONObject(body.readLimitedText(MAX_METADATA_BYTES))
            val versionCode = metadata.optLong("versionCode", -1)
            val expectedHash = metadata.optString("sha256")
            val bytes = metadata.optLong("bytes", -1)
            if (metadata.optString("applicationId") != applicationId ||
                metadata.optString("versionName") != release.versionName ||
                metadata.optString("fileName") != release.apkUrl.pathSegments.last() ||
                versionCode !in (installedVersionCode.toLong() + 1)..Int.MAX_VALUE.toLong() ||
                !SHA256.matches(expectedHash) || bytes !in 1..MAX_APK_BYTES ||
                (release.bytes != null && release.bytes != bytes) ||
                (release.digest != null && release.digest != "sha256:$expectedHash")
            ) throw invalidMetadata()
            AndroidUpdate(release.versionName, versionCode.toInt(), release.apkUrl, expectedHash, bytes)
        }
    }

    suspend fun download(update: AndroidUpdate): File = request(update.apkUrl) { _, body ->
        if (body.contentLength() >= 0 && body.contentLength() != update.bytes) throw integrityError()
        val directory = File(cacheDir, "updates")
        if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) throw storageError()
        val temporary = try {
            File.createTempFile("update-", ".apk", cacheDir)
        } catch (error: IOException) {
            throw storageError(error)
        }
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val bytes = ByteArray(DEFAULT_BUFFER_SIZE)
            var received = 0L
            val output = try {
                temporary.outputStream().buffered()
            } catch (error: IOException) {
                throw storageError(error)
            }
            output.use { file ->
                val input = body.byteStream()
                while (true) {
                    val length = input.read(bytes)
                    if (length == -1) break
                    received += length
                    if (received > update.bytes) throw integrityError()
                    try {
                        file.write(bytes, 0, length)
                    } catch (error: IOException) {
                        throw storageError(error)
                    }
                    digest.update(bytes, 0, length)
                }
            }
            if (received != update.bytes || digest.digest().toByteString().hex() != update.sha256) {
                throw integrityError()
            }
            verifyApk(temporary, update)
            val apk = File(directory, "update-${update.versionCode}.apk")
            if (!temporary.renameTo(apk)) throw storageError()
            File(directory, "update-$installedVersionCode.apk").delete()
            apk
        } finally {
            temporary.delete()
        }
    }

    private fun readRelease(release: JSONObject, installedVersion: ReleaseVersion): ReleaseAssets? {
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) return null
        val tag = release.getString("tag_name")
        if (!tag.startsWith("android-v")) return null
        val versionName = tag.removePrefix("android-v")
        val version = ReleaseVersion.parse(versionName) ?: return null
        if (version <= installedVersion) return null
        val assets = release.getJSONArray("assets")
        val apkName = "selected-text-translator-android-$versionName.apk"
        val apk = assets.findNamedAsset(apkName) ?: return null
        val metadata = assets.findNamedAsset(UPDATE_METADATA_FILE) ?: return null
        return ReleaseAssets(
            version,
            versionName,
            apk.officialAssetUrl(tag, apkName),
            metadata.officialAssetUrl(tag, UPDATE_METADATA_FILE),
            apk.optLong("size", -1).takeIf { it > 0 },
            apk.optString("digest", "").takeUnless { it.isEmpty() || it == "null" },
        )
    }

    private suspend fun <T> request(url: HttpUrl, read: (Response, ResponseBody) -> T): T =
        suspendCancellableCoroutine { continuation ->
            val request = Request.Builder().url(url).apply {
                if (url.host == RELEASES_API.host) header("Accept", "application/vnd.github+json")
            }.build()
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWith(Result.failure(toUpdateError(e)))
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching {
                        response.use {
                            if (!it.isSuccessful) throw responseError(it)
                            read(it, it.body ?: throw invalidMetadata())
                        }
                    }.recoverCatching { throw toUpdateError(it) }
                    continuation.resumeWith(result)
                }
            })
        }
}

private const val GITHUB_REPOSITORY = "xiaoj655/selected-text-translator"
private const val UPDATE_METADATA_FILE = "update.json"
private const val MAX_RELEASE_LIST_BYTES = 4_000_000L
private const val MAX_METADATA_BYTES = 16_384L
private const val MAX_APK_BYTES = 64L * 1024 * 1024
private val RELEASES_API = "https://api.github.com/repos/$GITHUB_REPOSITORY/releases".toHttpUrl()
private val DOWNLOAD_BASE = "https://github.com/$GITHUB_REPOSITORY/releases/download/".toHttpUrl()
private val RELEASE_ASSET_HOSTS = setOf("release-assets.githubusercontent.com", "objects.githubusercontent.com")
private val NEXT_PAGE_LINK = Regex("(?:^|,)\\s*<[^>]+>;\\s*rel=\"next\"")
private val SHA256 = Regex("[0-9a-f]{64}")
private val VERSION = Regex("([0-9]+)\\.([0-9]+)\\.([0-9]+)")

internal fun createUpdateHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .callTimeout(5, TimeUnit.MINUTES)
    .followRedirects(false)
    .addInterceptor { chain ->
        val original = chain.request()
        var response = chain.proceed(original)
        repeat(4) {
            if (!response.isRedirect) return@addInterceptor response
            val destination = response.header("Location")?.let(response.request.url::resolve)
            response.close()
            if (original.url.host != DOWNLOAD_BASE.host || destination == null ||
                !destination.isHttps || destination.port != 443 || destination.host !in RELEASE_ASSET_HOSTS ||
                destination.username.isNotEmpty() || destination.password.isNotEmpty()
            ) throw invalidMetadata()
            response = chain.proceed(original.newBuilder().url(destination).build())
        }
        if (response.isRedirect) {
            response.close()
            throw invalidMetadata()
        }
        response
    }
    .build()

private data class ReleaseVersion(val major: Int, val minor: Int, val patch: Int) : Comparable<ReleaseVersion> {
    override fun compareTo(other: ReleaseVersion): Int =
        compareValuesBy(this, other, ReleaseVersion::major, ReleaseVersion::minor, ReleaseVersion::patch)

    companion object {
        fun parse(name: String): ReleaseVersion? {
            val match = VERSION.matchEntire(name) ?: return null
            val (major, minor, patch) = match.destructured
            return ReleaseVersion(
                major.toIntOrNull() ?: return null,
                minor.toIntOrNull() ?: return null,
                patch.toIntOrNull() ?: return null,
            )
        }
    }
}

private data class ReleaseAssets(
    val version: ReleaseVersion,
    val versionName: String,
    val apkUrl: HttpUrl,
    val metadataUrl: HttpUrl,
    val bytes: Long?,
    val digest: String?,
)

private fun JSONArray.findNamedAsset(name: String): JSONObject? {
    for (index in 0 until length()) {
        val asset = getJSONObject(index)
        if (asset.getString("name") == name && asset.optString("state") == "uploaded") return asset
    }
    return null
}

private fun JSONObject.officialAssetUrl(tag: String, filename: String): HttpUrl {
    val expected = DOWNLOAD_BASE.newBuilder().addPathSegment(tag).addPathSegment(filename).build()
    if (optString("browser_download_url") != expected.toString()) throw invalidMetadata()
    return expected
}

private fun ResponseBody.readLimitedText(maxBytes: Long): String {
    val source = source()
    if (contentLength() > maxBytes || source.request(maxBytes + 1)) throw invalidMetadata()
    return source.readUtf8()
}

private fun responseError(response: Response): AndroidUpdateException = when {
    response.code == 429 || response.code == 403 && response.header("X-RateLimit-Remaining") == "0" ->
        AndroidUpdateException("GitHub’s rate limit has been reached. Try again later.")
    else -> AndroidUpdateException("Updates are temporarily unavailable on GitHub. Try again later.")
}

private fun toUpdateError(error: Throwable): Throwable = when (error) {
    is AndroidUpdateException -> error
    is JSONException -> invalidMetadata(error)
    is IOException -> AndroidUpdateException("Unable to connect to GitHub. Check your connection and try again.", error)
    else -> error
}

private fun invalidMetadata(cause: Throwable? = null) =
    AndroidUpdateException("GitHub returned invalid update information. Try again later.", cause)

private fun integrityError() = AndroidUpdateException("The APK is incomplete or failed verification. Download it again.")

private fun storageError(cause: Throwable? = null) =
    AndroidUpdateException("Unable to save the APK. Check your available storage.", cause)

@Suppress("DEPRECATION")
private fun verifyPackage(context: Context, file: File, update: AndroidUpdate) {
    val packageManager = context.packageManager
    val signingFlags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
    else PackageManager.GET_SIGNATURES
    val installed = packageManager.getPackageInfo(context.packageName, signingFlags)
    val archive = packageManager.getPackageArchiveInfo(file.absolutePath, signingFlags)
    if (archive == null || archive.packageName != installed.packageName ||
        archive.versionName != update.versionName || archive.versionCodeCompat != update.versionCode.toLong() ||
        archive.versionCodeCompat <= installed.versionCodeCompat
    ) throw AndroidUpdateException("The APK’s app or version does not match the update.")
    val installedSigners = installed.currentSigners()
    val archiveSigners = archive.currentSigners()
    if (installedSigners.isEmpty() || installedSigners != archiveSigners) {
        throw AndroidUpdateException("The APK’s signature does not match the installed app.")
    }
}

@Suppress("DEPRECATION")
private val PackageInfo.versionCodeCompat: Long
    get() = if (Build.VERSION.SDK_INT >= 28) longVersionCode else versionCode.toLong()

@Suppress("DEPRECATION")
private fun PackageInfo.currentSigners(): Set<Signature> = if (Build.VERSION.SDK_INT >= 28) {
    signingInfo?.apkContentsSigners.orEmpty().toSet()
} else {
    signatures.orEmpty().toSet()
}
