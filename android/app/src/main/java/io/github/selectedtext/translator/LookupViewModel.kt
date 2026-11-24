package io.github.selectedtext.translator

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class LookupViewModel(application: Application, private val restored: SavedStateHandle) : AndroidViewModel(application) {
    private val store = (application as TranslatorApplication).store
    private val client = TranslationClient(application)
    private val _state = MutableStateFlow(
        LookupUiState(input = restored[INPUT_KEY] ?: "", page = restored[PAGE_KEY] ?: LookupPage.LOOKUP),
    )
    val state = _state.asStateFlow()

    private val results = mutableMapOf<LookupMode, LookupResult>()
    private var resultConfig: ProviderConfig? = null
    private var request: Job? = null
    private var settingsWrite: Job? = null
    private var connectionCheck: Job? = null
    private var pendingMode: LookupMode? = null
    private var settingsParent: LookupPage = restored[SETTINGS_PARENT_KEY] ?: LookupPage.LOOKUP

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
                _state.update { it.copy(error = "No text was shared. Select some text or paste it into Selected.") }
            }
            text.length > MAX_INPUT_LENGTH -> {
                edit("")
                showInputLimit()
            }
            fromShare && WEB_LINK.matches(text.trim()) -> {
                edit("")
                _state.update { it.copy(error = "To translate, select text on the webpage and share it.") }
            }
            else -> {
                edit(text)
                lookup(LookupMode.TRANSLATE)
            }
        }
    }

    private fun showInputLimit() {
        _state.update { it.copy(error = "Keep the text within 50,000 characters.") }
    }

    fun lookup(mode: LookupMode) {
        val current = _state.value
        val text = current.input.trim()
        if (text.isEmpty()) {
            _state.update { it.copy(error = "Type or paste text to translate.") }
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
                updateRequest(revision) { it.copy(busy = false, error = "Set up a model to continue.") }
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
                ensureActive()
                results[mode] = result
                updateRequest(revision) {
                    it.copy(result = result, partial = "", busy = false, isSaved = containsResult(it.saved, it.input, result))
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: ProviderException) {
                updateRequest(revision) { it.copy(busy = false, partial = "", error = error.message) }
            } catch (_: Exception) {
                updateRequest(revision) { it.copy(busy = false, partial = "", error = "Lookup failed. Try again.") }
            }
        }
    }

    private fun updateRequest(revision: Int, transform: (LookupUiState) -> LookupUiState) {
        _state.update { if (it.requestRevision == revision) transform(it) else it }
    }

    fun stopLookup() {
        if (!_state.value.busy) return
        request?.cancel()
        pendingMode = null
        val previous = results.entries.lastOrNull()
        _state.update {
            it.copy(
                mode = previous?.key ?: it.mode,
                result = previous?.value,
                partial = "",
                busy = false,
                error = null,
                isSaved = containsResult(it.saved, it.input, previous?.value),
                requestRevision = it.requestRevision + 1,
            )
        }
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
        if (page != LookupPage.SETTINGS) clearConnectionTest()
        if (page == LookupPage.SETTINGS && current.page != LookupPage.SETTINGS) {
            settingsParent = current.page
            restored[SETTINGS_PARENT_KEY] = current.page
            if (current.page == LookupPage.LOOKUP && !current.configured && current.input.isNotBlank() && pendingMode == null) {
                pendingMode = current.mode
            }
        }
        restored[PAGE_KEY] = page
        _state.update { it.copy(page = page, settingsError = null, notice = null) }
    }

    fun back() = open(if (_state.value.page == LookupPage.SETTINGS) settingsParent else LookupPage.LOOKUP)

    fun saveSettings(config: ProviderConfig) {
        if (settingsWrite?.isActive == true) return
        val clean = cleanConfig(config)
        val problem = settingsProblem(clean)
        if (problem != null) {
            _state.update { it.copy(settingsError = problem) }
            return
        }

        settingsWrite = viewModelScope.launch {
            try {
                store.saveConfig(clean)
                val resume = pendingMode.takeIf { settingsParent == LookupPage.LOOKUP }
                pendingMode = null
                if (resultConfig != null && resultConfig != clean) clearLookup()
                back()
                _state.update { it.copy(config = clean, configured = clean.isConfigured) }
                if (resume != null) lookup(resume) else notice("Settings saved")
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                _state.update { it.copy(settingsError = "Unable to save settings. Try again.") }
            }
        }
    }

    fun testConnection(config: ProviderConfig) {
        if (connectionCheck?.isActive == true) return
        val clean = cleanConfig(config)
        val problem = settingsProblem(clean) ?: "Enter an API Key to test the connection.".takeIf { clean.apiKey.isBlank() }
        if (problem != null) {
            _state.update { it.copy(connectionTest = ModelConnectionTest(false, problem, failed = true)) }
            return
        }

        _state.update { it.copy(settingsError = null, connectionTest = ModelConnectionTest(true)) }
        connectionCheck = viewModelScope.launch {
            val test = try {
                ModelConnectionTest(false, client.testConnection(clean))
            } catch (error: CancellationException) {
                throw error
            } catch (error: ProviderException) {
                ModelConnectionTest(false, error.message, failed = true)
            } catch (_: Exception) {
                ModelConnectionTest(false, "Couldn't test the connection. Try again.", failed = true)
            }
            ensureActive()
            _state.update { it.copy(connectionTest = test) }
        }
    }

    fun clearConnectionTest() {
        connectionCheck?.cancel()
        connectionCheck = null
        _state.update { it.copy(connectionTest = null) }
    }

    private fun cleanConfig(config: ProviderConfig) = config.copy(
        baseUrl = config.baseUrl.trim(),
        apiKey = config.apiKey.trim(),
        translationModel = config.translationModel.trim(),
        learningModel = config.learningModel.trim(),
    )

    private fun settingsProblem(config: ProviderConfig): String? = when {
        runCatching { TranslationClient.normalizeEndpoint(config.baseUrl) }.isFailure -> "Enter a valid HTTPS API URL."
        config.translationModel.isBlank() -> "Enter a translation model name."
        config.learningModel.contains("qwen-mt", ignoreCase = true) -> "Guided explanations need a general-purpose model."
        config.apiKey.any { it !in '!'..'~' } -> "Check the API key format."
        else -> null
    }

    fun saveExpression() {
        val current = _state.value
        val result = current.result ?: return
        if (current.isSaved) return
        viewModelScope.launch {
            try {
                store.saveExpression(current.input.trim(), result.text)
                notice("Saved")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                notice(error.message ?: "Unable to save the expression. Try again.")
            }
        }
    }

    fun removeExpression(id: String) {
        viewModelScope.launch {
            try {
                store.removeExpression(id)
                notice("Removed")
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                notice("Unable to remove the expression. Try again.")
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
        const val PAGE_KEY = "workspacePage"
        const val SETTINGS_PARENT_KEY = "settingsParent"
        val WEB_LINK = Regex("^(?:https?://|www\\.)\\S+$", RegexOption.IGNORE_CASE)
    }
}
