package io.github.selectedtext.translator

import android.app.Application
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.IOException
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class TranslatorApplication : Application() {
    internal val store by lazy { TranslatorStore(this) }
    internal val articleNetwork by lazy { ArticleNetwork(this) }
    internal val articles by lazy { ArticleRepository(this, articleNetwork) }
}

internal class TranslatorStore(context: Context) {
    private val preferences = context.getSharedPreferences("selected", Context.MODE_PRIVATE)
    private val mutations = Mutex()
    private val _config = MutableStateFlow(ProviderConfig())
    private val _iqsApiKey = MutableStateFlow("")
    private val _saved = MutableStateFlow(emptyList<SavedExpression>())
    private var loaded = false
    val config = _config.asStateFlow()
    val iqsApiKey = _iqsApiKey.asStateFlow()
    val saved = _saved.asStateFlow()

    suspend fun load() = withContext(Dispatchers.IO) {
        mutations.withLock { loadLocked() }
    }

    private fun loadLocked() {
        if (loaded) return
        val defaults = ProviderConfig()
        _config.value = ProviderConfig(
            baseUrl = preferences.getString("baseUrl", null) ?: defaults.baseUrl,
            apiKey = preferences.getString("encryptedApiKey", null)
                ?.let { encoded -> runCatching { KeyVault.decrypt(encoded) }.getOrDefault("") }
                .orEmpty(),
            translationModel = preferences.getString("translationModel", null) ?: defaults.translationModel,
            learningModel = preferences.getString("learningModel", null) ?: defaults.learningModel,
        )
        _saved.value = readExpressions()
        _iqsApiKey.value = preferences.getString("encryptedIqsApiKey", null)
            ?.let { encrypted -> runCatching { KeyVault.decrypt(encrypted) }.getOrDefault("") }.orEmpty()
        loaded = true
    }

    suspend fun saveIqsApiKey(key: String) = withContext(Dispatchers.IO) {
        mutations.withLock {
            loadLocked()
            val editor = preferences.edit()
            if (key.isBlank()) editor.remove("encryptedIqsApiKey")
            else editor.putString("encryptedIqsApiKey", KeyVault.encrypt(key))
            if (!editor.commit()) throw IOException("Unable to save the IQS key.")
            _iqsApiKey.value = key
        }
    }

    suspend fun saveConfig(config: ProviderConfig) = withContext(Dispatchers.IO) {
        mutations.withLock {
            loadLocked()
            val editor = preferences.edit()
                .putString("baseUrl", config.baseUrl)
                .putString("translationModel", config.translationModel)
                .putString("learningModel", config.learningModel)
            if (config.apiKey.isBlank()) {
                editor.remove("encryptedApiKey")
            } else if (config.apiKey != _config.value.apiKey) {
                editor.putString("encryptedApiKey", KeyVault.encrypt(config.apiKey))
            }
            if (!editor.commit()) throw IOException("Unable to save model settings.")
            _config.value = config
        }
    }

    suspend fun saveExpression(source: String, result: String) = withContext(Dispatchers.IO) {
        mutations.withLock {
            loadLocked()
            if (_saved.value.any { it.source == source && it.result == result }) return@withLock
            check(_saved.value.size < MAX_EXPRESSIONS) { "Remove some expressions to make room for more." }
            writeExpressions(listOf(SavedExpression(UUID.randomUUID().toString(), source, result)) + _saved.value)
        }
    }

    suspend fun removeExpression(id: String) = withContext(Dispatchers.IO) {
        mutations.withLock {
            loadLocked()
            writeExpressions(_saved.value.filterNot { it.id == id })
        }
    }

    private fun readExpressions(): List<SavedExpression> = runCatching {
        val values = JSONArray(preferences.getString("expressions", "[]"))
        List(values.length()) { index ->
            val entry = values.getJSONObject(index)
            SavedExpression(entry.getString("id"), entry.getString("text"), entry.getString("meaning"))
        }
    }.getOrDefault(emptyList())

    private fun writeExpressions(entries: List<SavedExpression>) {
        val data = JSONArray()
        entries.forEach { entry ->
            data.put(JSONObject().put("id", entry.id).put("text", entry.source).put("meaning", entry.result))
        }
        val json = data.toString()
        check(json.toByteArray().size <= MAX_EXPRESSIONS_BYTES) { "Remove some expressions to make room for more." }
        if (!preferences.edit().putString("expressions", json).commit()) throw IOException("Unable to save expressions.")
        _saved.value = entries
    }

    private companion object {
        const val MAX_EXPRESSIONS = 2_000
        const val MAX_EXPRESSIONS_BYTES = 4 * 1024 * 1024
    }
}

private object KeyVault {
    private const val KEY_ALIAS = "selected-model-api-key"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getKey(create = true))
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val ciphertext = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        return "$iv.$ciphertext"
    }

    fun decrypt(value: String): String {
        val (iv, ciphertext) = value.split('.', limit = 2)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getKey(create = false), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        return cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }

    private fun getKey(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        check(create) { "Missing local encryption key." }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }
}
