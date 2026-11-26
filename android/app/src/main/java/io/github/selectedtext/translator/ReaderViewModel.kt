package io.github.selectedtext.translator

import android.app.Application
import android.content.Context
import androidx.core.content.edit
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

internal val readerFontSizes = listOf(16, 18, 20, 22, 24, 26)
internal const val defaultReaderFontSize = 20

internal data class ReaderUiState(
    val loading: Boolean = true,
    val articles: List<ReadingArticle> = emptyList(),
    val libraryError: String? = null,
    val activeArticle: ReadingArticle? = null,
    val importing: Boolean = false,
    val importError: String? = null,
    val pendingUrl: String? = null,
    val directImportAvailable: Boolean = false,
    val reloadingArticle: Boolean = false,
    val articleReloadError: String? = null,
    val savingIqsKey: Boolean = false,
    val iqsSettingsMessage: String? = null,
    val iqsSettingsError: Boolean = false,
    val pastedDraft: String = "",
    val fontSize: Int = defaultReaderFontSize,
    val feeds: List<FeedSource> = emptyList(),
    val optionalFeeds: List<FeedSource> = emptyList(),
    val feedArticles: List<FeedArticle> = emptyList(),
    val feedErrors: Map<String, String> = emptyMap(),
    val feedMessage: String? = null,
    val refreshingFeeds: Boolean = false,
    val addingFeed: Boolean = false,
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
    val guided: Boolean = false,
    val guide: LookupResult? = null,
    val guideBusy: Boolean = false,
    val guideError: String? = null,
    val answerRevealed: Boolean = false,
    val isSaved: Boolean = false,
    val saveBusy: Boolean = false,
    val saveError: String? = null,
) {
    val saveText: String?
        get() = when {
            guided -> guide?.text?.takeIf { answerRevealed }
            selection.kind == ArticleSelectionKind.SENTENCE -> grammar?.paraphrase
            else -> meaning?.text
        }
}

internal class ReaderViewModel(
    application: Application,
    private val restored: SavedStateHandle,
) : AndroidViewModel(application) {
    private val app = application as TranslatorApplication
    private val library = app.articles
    private val feedRepository = FeedRepository(app)
    private val store = app.store
    val iqsApiKey = store.iqsApiKey
    private val client = TranslationClient(application)
    private val preferences = app.getSharedPreferences("reading-preferences", Context.MODE_PRIVATE)
    private val state = MutableStateFlow(ReaderUiState(
        fontSize = preferences.getInt(FONT_SIZE_KEY, defaultReaderFontSize)
            .takeIf(readerFontSizes::contains) ?: defaultReaderFontSize,
    ))
    val uiState = state.asStateFlow()

    private data class PositionWrite(val article: ReadingArticle, val position: ArticlePosition)

    private val positionWrites = Channel<PositionWrite>(Channel.UNLIMITED)
    private val pendingPositions = mutableMapOf<String, PositionWrite>()
    private var loadJob: Job? = null
    private var importJob: Job? = null
    private var importRevision = 0
    private var selectionRevision = 0
    private var meaningJob: Job? = null
    private var grammarJob: Job? = null
    private var guideJob: Job? = null
    private var feedJob: Job? = null
    private var loadedFeeds = false
    private var cachedMeaning: CachedMeaning? = null
    private var cachedGrammar: CachedGrammar? = null

    init {
        viewModelScope.launch {
            feedRepository.state.collect { feeds ->
                state.update { current ->
                    current.copy(
                        feeds = feeds.sources,
                        optionalFeeds = feeds.optional.filter { suggested -> feeds.sources.none { it.url == suggested.url } },
                        feedArticles = feeds.articles.values.flatten().sortedByDescending { it.publishedAt ?: Long.MIN_VALUE },
                        feedErrors = feeds.errors,
                    )
                }
            }
        }
        viewModelScope.launch {
            library.articles.collect { articles -> state.update { it.copy(articles = articles) } }
        }
        viewModelScope.launch {
            store.saved.collect { saved ->
                state.update { current -> current.copy(result = current.result?.withSavedStatus(saved)) }
            }
        }
        viewModelScope.launch {
            var previous = store.config.value
            store.config.collect { config ->
                if (previous != config) {
                    cachedMeaning = null
                    cachedGrammar = null
                    if (previous.isConfigured) dismissResult()
                    previous = config
                }
            }
        }
        viewModelScope.launch {
            for (write in positionWrites) {
                try {
                    library.savePosition(write.article, write.position)
                    val id = write.article.id
                    if (pendingPositions[id] === write) pendingPositions.remove(id)
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

    fun importUrl(url: String, fromShare: Boolean = false, direct: Boolean = false) {
        importArticle(url.takeIf { fromShare }) {
            store.load()
            val key = iqsApiKey.value.takeUnless { direct }.orEmpty()
            library.importUrl(url, iqsApiKey = key)
        }
    }

    fun importText(text: String, title: String = "") {
        importArticle(null) { library.importText(text, title) }
    }

    fun reloadArticle(article: ReadingArticle) {
        if (article.sourceUrl == null || article.hasImages || state.value.importing) return
        importArticle(null, reload = true) { library.reloadImages(article) }
    }

    fun openFeedArticle(article: FeedArticle) {
        val body = article.html
        if (body != null) {
            importArticle(article.url) { library.importFeedArticle(article.url, article.title, body) }
        } else {
            importUrl(article.url, fromShare = true)
        }
    }

    fun loadFeeds() {
        if (loadedFeeds) return
        runFeedOperation {
            feedRepository.load()
            loadedFeeds = true
            feedRepository.refresh()
        }
    }

    fun refreshFeeds(sourceId: String?) = runFeedOperation {
        feedRepository.refresh(sourceId?.let(::setOf))
    }

    fun retryFeeds(sourceIds: Set<String>) = runFeedOperation {
        feedRepository.refresh(sourceIds)
    }

    fun addFeed(url: String, onAdded: (String) -> Unit) = runFeedOperation(adding = true) {
        onAdded(feedRepository.add(url).id)
    }

    fun removeFeed(id: String) = runFeedOperation {
        feedRepository.remove(id)
    }

    fun clearFeedMessage() {
        state.update { it.copy(feedMessage = null) }
    }

    private fun runFeedOperation(adding: Boolean = false, operation: suspend () -> Unit) {
        if (feedJob?.isActive == true) return
        state.update { it.copy(addingFeed = adding, refreshingFeeds = !adding, feedMessage = null) }
        feedJob = viewModelScope.launch {
            try {
                operation()
            } catch (error: CancellationException) {
                throw error
            } catch (error: FeedException) {
                state.update { it.copy(feedMessage = error.message ?: "Couldn't load the feed.") }
            } catch (_: Exception) {
                state.update { it.copy(feedMessage = "Couldn't load the feed. Try again.") }
            } finally {
                state.update { it.copy(addingFeed = false, refreshingFeeds = false) }
            }
        }
    }

    fun editPastedDraft(text: String) {
        state.update { it.copy(pastedDraft = text) }
    }

    fun changeFontSize(size: Int) {
        if (size !in readerFontSizes) return
        preferences.edit { putInt(FONT_SIZE_KEY, size) }
        state.update { it.copy(fontSize = size) }
    }

    fun saveIqsKey(value: String) {
        if (state.value.savingIqsKey) return
        val key = value.trim()
        if (key.length > 4096 || key.any { it !in '!'..'~' }) {
            state.update { it.copy(iqsSettingsMessage = "Enter a valid IQS API key.", iqsSettingsError = true) }
            return
        }
        state.update { it.copy(savingIqsKey = true, iqsSettingsMessage = null, iqsSettingsError = false) }
        viewModelScope.launch {
            try {
                store.saveIqsApiKey(key)
                state.update { it.copy(savingIqsKey = false, iqsSettingsMessage = if (key.isEmpty()) "IQS key cleared" else "IQS key saved") }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                state.update { it.copy(savingIqsKey = false, iqsSettingsMessage = "Couldn't save the IQS key.", iqsSettingsError = true) }
            }
        }
    }

    fun clearIqsSettingsMessage() {
        state.update { it.copy(iqsSettingsMessage = null, iqsSettingsError = false) }
    }

    private fun importArticle(sharedUrl: String?, reload: Boolean = false, request: suspend () -> ReadingArticle) {
        importJob?.cancel()
        val revision = ++importRevision
        state.update {
            it.copy(importing = true, importError = null, pendingUrl = sharedUrl, directImportAvailable = false,
                reloadingArticle = reload, articleReloadError = null)
        }
        importJob = viewModelScope.launch {
            try {
                val article = request()
                if (revision == importRevision) {
                    open(article)
                    state.update { it.copy(importing = false, pendingUrl = null, pastedDraft = "", reloadingArticle = false) }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (revision == importRevision) {
                    val message = (error as? ArticleImportException)?.message ?: if (reload) {
                        "Couldn't reload images. Try again."
                    } else "Couldn't add the article. Try again."
                    state.update {
                        if (reload) it.copy(importing = false, reloadingArticle = false, articleReloadError = message)
                        else it.copy(importing = false, importError = message, directImportAvailable = error is IqsImportException)
                    }
                }
            }
        }
    }

    fun clearImportError() {
        state.update { it.copy(importError = null, pendingUrl = null, directImportAvailable = false) }
    }

    fun cancelImport() {
        importRevision++
        importJob?.cancel()
        state.update {
            it.copy(importing = false, importError = null, pendingUrl = null, directImportAvailable = false, reloadingArticle = false)
        }
    }

    fun open(article: ReadingArticle) {
        val stored = library.articles.value.firstOrNull { it.id == article.id } ?: article
        val active = state.value.activeArticle
        if (active?.id == stored.id && active.blocks === stored.blocks) return
        dismissResult()
        restored[ARTICLE_KEY] = article.id
        state.update { it.copy(activeArticle = stored.copy(position = readingPosition(stored)), articleReloadError = null) }
    }

    fun closeArticle() {
        if (state.value.reloadingArticle) cancelImport()
        dismissResult()
        restored.remove<String>(ARTICLE_KEY)
        state.update { it.copy(activeArticle = null, articleReloadError = null) }
    }

    fun readingPosition(article: ReadingArticle): ArticlePosition = pendingPositions[article.id]
        ?.takeIf { it.article.blocks === article.blocks }?.position
        ?: library.articles.value.firstOrNull { it.id == article.id && it.blocks === article.blocks }?.position
        ?: article.position

    fun savePosition(article: ReadingArticle, position: ArticlePosition) {
        if (library.articles.value.none { it.id == article.id && it.blocks === article.blocks }) return
        val pending = pendingPositions[article.id]
        if (pending?.article?.blocks === article.blocks && pending.position == position) return
        val write = PositionWrite(article, position)
        pendingPositions[article.id] = write
        positionWrites.trySend(write)
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

    fun select(blockIndex: Int, selection: ArticleSelection, guided: Boolean = false) {
        val current = state.value
        if (current.activeArticle == null) return
        if (current.result?.let { it.blockIndex == blockIndex && it.selection == selection && it.guided == guided } == true) return
        dismissResult()
        state.update { it.copy(result = ReaderResult(blockIndex, selection, guided = guided)) }
        if (guided) retryGuide() else if (selection.kind != ArticleSelectionKind.SENTENCE) retryMeaning()
        analyzeSentence()
    }

    fun dismissResult() {
        selectionRevision++
        meaningJob?.cancel()
        grammarJob?.cancel()
        guideJob?.cancel()
        state.update { it.copy(result = null) }
    }

    fun retryMeaning() {
        val result = state.value.result ?: return
        if (result.guided || result.selection.kind == ArticleSelectionKind.SENTENCE || result.meaningBusy) return
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

    fun retryGuide() {
        val result = state.value.result ?: return
        if (!result.guided || result.guideBusy || result.guide != null) return
        val revision = selectionRevision
        updateResult(revision) { it.copy(guideBusy = true, guideError = null) }
        guideJob = viewModelScope.launch {
            try {
                store.load()
                val guide = client.guideArticle(store.config.value, result.selection)
                updateResult(revision) { it.copy(guide = guide, guideBusy = false) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                updateResult(revision) {
                    it.copy(guideBusy = false, guideError = error.lookupMessage("Couldn't prepare hints. Try again."))
                }
            }
        }
    }

    fun revealAnswer() {
        val result = state.value.result ?: return
        if (!result.guided || result.guide == null || result.answerRevealed) return
        updateResult(selectionRevision) { it.copy(answerRevealed = true).withSavedStatus(store.saved.value) }
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
        const val FONT_SIZE_KEY = "font-size"
    }
}
