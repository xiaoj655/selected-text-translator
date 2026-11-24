package io.github.selectedtext.translator

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class LookupViewModel(application: Application, private val restored: SavedStateHandle) : AndroidViewModel(application) {
    private val store = (application as TranslatorApplication).store
    private val client = TranslationClient(application)
    private val _state = MutableStateFlow(LookupUiState(input = restored[INPUT_KEY] ?: ""))
    val state = _state.asStateFlow()

    private val results = mutableMapOf<LookupMode, LookupResult>()
    private var resultConfig: ProviderConfig? = null
    private var request: Job? = null
    private var settingsWrite: Job? = null
    private var pendingMode: LookupMode? = null

    init {
        viewModelScope.launch {
            store.load()
            store.config.collect { config ->
                _state.update { it.copy(config = config, configured = config.isConfigured) }
                if (resultConfig != null && resultConfig != config) clearLookup()
            }
        }
        viewModelScope.launch {
            store.saved.collect { entries ->
                _state.update { current -> current.copy(saved = entries, isSaved = containsResult(entries, current.input, current.result)) }
            }
        }
    }

    fun edit(value: String) {
        if (value == _state.value.input) return
        if (value.length > MAX_INPUT_LENGTH) {
            showInputLimit()
            return
        }
        pendingMode = null
        clearLookup()
        restored[INPUT_KEY] = value
        _state.update { it.copy(input = value, error = null) }
    }

    fun useIncoming(text: String?, fromShare: Boolean = false) {
        open(LookupPage.LOOKUP)
        when {
            text.isNullOrBlank() -> {
                edit("")
                _state.update { it.copy(error = "没有收到文字。可以选中文字再试，或到工作台粘贴。") }
            }
            text.length > MAX_INPUT_LENGTH -> {
                edit("")
                showInputLimit()
            }
            fromShare && WEB_LINK.matches(text.trim()) -> {
                edit("")
                _state.update { it.copy(error = "收到的是网页链接。请在网页中选择要翻译的文字再分享。") }
            }
            else -> {
                edit(text)
                lookup(LookupMode.TRANSLATE)
            }
        }
    }

    private fun showInputLimit() {
        _state.update { it.copy(error = "请把文字缩短到 12,000 字符以内。") }
    }

    fun lookup(mode: LookupMode) {
        val current = _state.value
        val text = current.input.trim()
        if (text.isEmpty()) {
            _state.update { it.copy(error = "请输入或粘贴要翻译的文字。") }
            return
        }
        if (current.mode == mode && current.busy) return

        request?.cancel()
        pendingMode = null
        val revision = current.requestRevision + 1
        _state.update {
            it.copy(mode = mode, result = null, partial = "", busy = true, isSaved = false, error = null, requestRevision = revision)
        }
        request = viewModelScope.launch {
            store.load()
            val config = store.config.value
            if (!config.isConfigured) {
                pendingMode = mode
                updateRequest(revision) { it.copy(busy = false, error = "先配置模型，保存后会继续这次查询。") }
                return@launch
            }
            if (resultConfig != config) {
                results.clear()
                resultConfig = config
            }

            try {
                val result = results[mode] ?: client.lookup(config, text, mode) { partial ->
                    updateRequest(revision) { it.copy(partial = partial) }
                }
                results[mode] = result
                updateRequest(revision) {
                    it.copy(result = result, partial = "", busy = false, isSaved = containsResult(it.saved, it.input, result))
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: ProviderException) {
                updateRequest(revision) { it.copy(busy = false, partial = "", error = error.message) }
            } catch (_: Exception) {
                updateRequest(revision) { it.copy(busy = false, partial = "", error = "查询失败，请重试。") }
            }
        }
    }

    private fun updateRequest(revision: Int, transform: (LookupUiState) -> LookupUiState) {
        _state.update { if (it.requestRevision == revision) transform(it) else it }
    }

    private fun clearLookup() {
        request?.cancel()
        results.clear()
        resultConfig = null
        _state.update {
            it.copy(
                mode = LookupMode.TRANSLATE,
                result = null,
                partial = "",
                busy = false,
                error = null,
                isSaved = false,
                requestRevision = it.requestRevision + 1,
            )
        }
    }

    fun open(page: LookupPage) {
        val current = _state.value
        if (page == LookupPage.SETTINGS && !current.configured && current.input.isNotBlank() && pendingMode == null) {
            pendingMode = current.mode
        }
        _state.update { it.copy(page = page, settingsError = null, notice = null) }
    }

    fun saveSettings(config: ProviderConfig) {
        if (settingsWrite?.isActive == true) return
        val clean = ProviderConfig(
            config.baseUrl.trim(), config.apiKey.trim(), config.translationModel.trim(), config.learningModel.trim(),
        )
        val problem = when {
            runCatching { TranslationClient.normalizeEndpoint(clean.baseUrl) }.isFailure -> "请输入有效的 HTTPS API 地址。"
            clean.translationModel.isBlank() -> "请输入翻译模型名称。"
            clean.learningModel.contains("qwen-mt", ignoreCase = true) -> "引导理解需要使用通用模型。"
            clean.apiKey.any { it !in '!'..'~' } -> "请检查 API Key 格式。"
            else -> null
        }
        if (problem != null) {
            _state.update { it.copy(settingsError = problem) }
            return
        }

        settingsWrite = viewModelScope.launch {
            try {
                store.saveConfig(clean)
                val resume = pendingMode
                pendingMode = null
                if (resultConfig != null && resultConfig != clean) clearLookup()
                open(LookupPage.LOOKUP)
                _state.update { it.copy(config = clean, configured = clean.isConfigured) }
                if (resume != null) lookup(resume) else notice("设置已保存")
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                _state.update { it.copy(settingsError = "保存设置失败，请重试。") }
            }
        }
    }

    fun saveExpression() {
        val current = _state.value
        val result = current.result ?: return
        if (current.isSaved) return
        viewModelScope.launch {
            try {
                store.saveExpression(current.input.trim(), result.text)
                notice("已收藏")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                notice(error.message ?: "无法收藏，请重试。")
            }
        }
    }

    fun removeExpression(id: String) {
        viewModelScope.launch {
            try {
                store.removeExpression(id)
                notice("已移除")
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                notice("无法移除，请重试。")
            }
        }
    }

    fun setSpeaking(speaking: Boolean) {
        _state.update { it.copy(speaking = speaking) }
    }

    fun notice(text: String?) {
        _state.update { it.copy(notice = text) }
    }

    private fun containsResult(entries: List<SavedExpression>, input: String, result: LookupResult?): Boolean {
        val text = result?.text ?: return false
        val source = input.trim()
        return entries.any { it.source == source && it.result == text }
    }

    private companion object {
        const val INPUT_KEY = "lookupInput"
        val WEB_LINK = Regex("^(?:https?://|www\\.)\\S+$", RegexOption.IGNORE_CASE)
    }
}
