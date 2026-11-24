package io.github.selectedtext.translator

internal const val MAX_INPUT_LENGTH = 12_000

data class ProviderConfig(
    val baseUrl: String = "https://dashscope.aliyuncs.com/compatible-mode/v1",
    val apiKey: String = "",
    val translationModel: String = "qwen-mt-flash",
    val learningModel: String = "qwen-plus",
) {
    val isConfigured: Boolean
        get() = baseUrl.isNotBlank() && translationModel.isNotBlank() && apiKey.isNotBlank()

    override fun toString(): String = "ProviderConfig(baseUrl=$baseUrl, translationModel=$translationModel, learningModel=$learningModel)"
}

enum class LookupMode { TRANSLATE, GUIDE }

data class LookupResult(
    val text: String,
    val phonetic: String = "",
    val hints: List<String> = emptyList(),
    val explanation: String = "",
    val example: String = "",
)

data class SavedExpression(val id: String, val source: String, val result: String)

enum class LookupPage { LOOKUP, SETTINGS, SAVED }

data class LookupUiState(
    val input: String = "",
    val mode: LookupMode = LookupMode.TRANSLATE,
    val result: LookupResult? = null,
    val partial: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val configured: Boolean = false,
    val config: ProviderConfig = ProviderConfig(),
    val settingsError: String? = null,
    val page: LookupPage = LookupPage.LOOKUP,
    val saved: List<SavedExpression> = emptyList(),
    val isSaved: Boolean = false,
    val speaking: Boolean = false,
    val notice: String? = null,
    val requestRevision: Int = 0,
)

interface LookupActions {
    fun input(value: String)
    fun paste()
    fun lookup(mode: LookupMode)
    fun copy(text: String)
    fun speak(text: String)
    fun saveExpression()
    fun open(page: LookupPage)
    fun saveSettings(config: ProviderConfig)
    fun removeExpression(id: String)
    fun close()
    fun clearNotice()
}
