package io.github.selectedtext.translator

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class ReaderUiState(
    val loading: Boolean = true,
    val articles: List<ReadingArticle> = emptyList(),
    val libraryError: String? = null,
    val activeArticle: ReadingArticle? = null,
    val importing: Boolean = false,
    val importError: String? = null,
    val pendingUrl: String? = null,
    val result: ReaderResult? = null,
)

internal data class ReaderResult(
    val blockIndex: Int,
    val selection: ArticleSelection,
    val meaning: ArticleMeaning? = null,
    val meaningBusy: Boolean = false,
    val meaningError: String? = null,
    val grammar: ArticleSentenceAnalysis? = null,
    val grammarBusy: Boolean = false,
    val grammarError: String? = null,
    val isSaved: Boolean = false,
    val saveBusy: Boolean = false,
    val saveError: String? = null,
) {
    val saveText: String?
        get() = if (selection.kind == ArticleSelectionKind.SENTENCE) grammar?.paraphrase else meaning?.text
}

internal class ReaderViewModel(
    application: Application,
    private val restored: SavedStateHandle,
) : AndroidViewModel(application) {
    private val app = application as TranslatorApplication
    private val library = app.articles
    private val store = app.store
    private val client = TranslationClient(application)
    private val state = MutableStateFlow(ReaderUiState())
    val uiState = state.asStateFlow()

    private val positionWrites = Channel<Pair<String, ArticlePosition>>(Channel.UNLIMITED)
    private val pendingPositions = mutableMapOf<String, ArticlePosition>()
    private var loadJob: Job? = null
    private var importJob: Job? = null
    private var importRevision = 0
    private var selectionRevision = 0
    private var meaningJob: Job? = null
    private var grammarJob: Job? = null
    private var cachedMeaning: CachedMeaning? = null
    private var cachedGrammar: CachedGrammar? = null

    init {
        viewModelScope.launch {
            library.articles.collect { articles -> state.update { it.copy(articles = articles) } }
        }
        viewModelScope.launch {
            store.saved.collect { saved ->
                state.update { current -> current.copy(result = current.result?.withSavedStatus(saved)) }
            }
        }
        viewModelScope.launch {
            for ((id, position) in positionWrites) {
                try {
                    library.savePosition(id, position)
                    if (pendingPositions[id] == position) pendingPositions.remove(id)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    state.update { it.copy(libraryError = "Couldn't save your reading position.") }
                }
            }
        }
        load()
    }

    fun load() {
        if (loadJob?.isActive == true) return
        state.update { it.copy(loading = true, libraryError = null) }
        loadJob = viewModelScope.launch {
            try {
                library.load()
                if (state.value.activeArticle == null && !state.value.importing) {
                    val id = restored.get<String>(ARTICLE_KEY)
                    library.articles.value.firstOrNull { it.id == id }?.let(::open)
                }
                state.update { it.copy(loading = false) }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                state.update { it.copy(loading = false, libraryError = "Couldn't load your articles. Try again.") }
            }
        }
    }

    fun importUrl(url: String, fromShare: Boolean = false) {
        importArticle(url.takeIf { fromShare }) { library.importUrl(url) }
    }

    fun importText(text: String, title: String = "") {
        importArticle(null) { library.importText(text, title) }
    }

    private fun importArticle(sharedUrl: String?, request: suspend () -> ReadingArticle) {
        importJob?.cancel()
        val revision = ++importRevision
        state.update { it.copy(importing = true, importError = null, pendingUrl = sharedUrl) }
        importJob = viewModelScope.launch {
            try {
                val article = request()
                if (revision == importRevision) {
                    open(article)
                    state.update { it.copy(importing = false, pendingUrl = null) }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (revision == importRevision) {
                    val message = (error as? ArticleImportException)?.message ?: "Couldn't add the article. Try again."
                    state.update { it.copy(importing = false, importError = message) }
                }
            }
        }
    }

    fun clearImportError() {
        state.update { it.copy(importError = null, pendingUrl = null) }
    }

    fun open(article: ReadingArticle) {
        if (state.value.activeArticle?.id == article.id) return
        dismissResult()
        val stored = library.articles.value.firstOrNull { it.id == article.id } ?: article
        val position = pendingPositions[article.id] ?: stored.position
        restored[ARTICLE_KEY] = article.id
        state.update { it.copy(activeArticle = stored.copy(position = position)) }
    }

    fun closeArticle() {
        dismissResult()
        restored.remove<String>(ARTICLE_KEY)
        state.update { it.copy(activeArticle = null) }
    }

    fun savePosition(articleId: String, position: ArticlePosition) {
        if (pendingPositions[articleId] == position) return
        pendingPositions[articleId] = position
        positionWrites.trySend(articleId to position)
    }

    fun delete(articleId: String) {
        viewModelScope.launch {
            try {
                library.delete(articleId)
                pendingPositions.remove(articleId)
                if (state.value.activeArticle?.id == articleId) closeArticle()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                state.update { it.copy(libraryError = "Couldn't remove the article. Try again.") }
            }
        }
    }

    fun select(blockIndex: Int, selection: ArticleSelection) {
        val current = state.value
        if (current.activeArticle == null) return
        if (current.result?.let { it.blockIndex == blockIndex && it.selection == selection } == true) return
        dismissResult()
        state.update { it.copy(result = ReaderResult(blockIndex, selection)) }
        if (selection.kind == ArticleSelectionKind.WORD) retryMeaning() else analyzeSentence()
    }

    fun dismissResult() {
        selectionRevision++
        meaningJob?.cancel()
        grammarJob?.cancel()
        state.update { it.copy(result = null) }
    }

    fun retryMeaning() {
        val result = state.value.result ?: return
        if (result.selection.kind != ArticleSelectionKind.WORD || result.meaningBusy) return
        val revision = selectionRevision
        val cached = cachedMeaning?.takeIf { it.config == store.config.value && it.selection == result.selection }
        if (cached != null) {
            updateResult(revision) { it.copy(meaning = cached.meaning, meaningError = null).withSavedStatus(store.saved.value) }
            return
        }
        updateResult(revision) { it.copy(meaningBusy = true, meaningError = null) }
        meaningJob = viewModelScope.launch {
            try {
                store.load()
                val config = store.config.value
                val meaning = client.lookupArticle(config, result.selection)
                cachedMeaning = CachedMeaning(config, result.selection, meaning)
                updateResult(revision) { it.copy(meaning = meaning, meaningBusy = false).withSavedStatus(store.saved.value) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                updateResult(revision) {
                    it.copy(meaningBusy = false, meaningError = error.lookupMessage("Couldn't explain this word. Try again."))
                }
            }
        }
    }

    fun analyzeSentence() {
        val result = state.value.result ?: return
        if (result.grammarBusy || result.grammar != null) return
        val revision = selectionRevision
        updateResult(revision) { it.copy(grammarBusy = true, grammarError = null) }
        grammarJob = viewModelScope.launch {
            try {
                store.load()
                val config = store.config.value
                val sentence = result.selection.sentence
                val grammar = cachedGrammar?.takeIf { it.config == config && it.sentence == sentence }?.analysis
                    ?: client.analyzeArticleSentence(config, result.selection)
                cachedGrammar = CachedGrammar(config, sentence, grammar)
                updateResult(revision) { it.copy(grammar = grammar, grammarBusy = false).withSavedStatus(store.saved.value) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                updateResult(revision) {
                    it.copy(grammarBusy = false, grammarError = error.lookupMessage("Couldn't analyze the sentence. Try again."))
                }
            }
        }
    }

    fun retryGrammar() = analyzeSentence()

    fun saveExpression() {
        val result = state.value.result ?: return
        val text = result.saveText ?: return
        if (result.isSaved || result.saveBusy) return
        val revision = selectionRevision
        updateResult(revision) { it.copy(saveBusy = true, saveError = null) }
        viewModelScope.launch {
            try {
                store.saveExpression(result.selection.text, text)
                updateResult(revision) { it.copy(saveBusy = false).withSavedStatus(store.saved.value) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                updateResult(revision) {
                    it.copy(saveBusy = false, saveError = error.message ?: "Couldn't save the expression. Try again.")
                }
            }
        }
    }

    private fun updateResult(revision: Int, transform: (ReaderResult) -> ReaderResult) {
        state.update { current ->
            if (revision == selectionRevision) current.copy(result = current.result?.let(transform)) else current
        }
    }

    private fun ReaderResult.withSavedStatus(entries: List<SavedExpression>): ReaderResult {
        val text = saveText
        val saved = text != null && entries.any { it.source == selection.text && it.result == text }
        return copy(isSaved = saved)
    }

    private fun Exception.lookupMessage(fallback: String) = if (this is ProviderException) message ?: fallback else fallback

    private data class CachedMeaning(val config: ProviderConfig, val selection: ArticleSelection, val meaning: ArticleMeaning)

    private data class CachedGrammar(val config: ProviderConfig, val sentence: String, val analysis: ArticleSentenceAnalysis)

    private companion object {
        const val ARTICLE_KEY = "readingArticleId"
    }
}
