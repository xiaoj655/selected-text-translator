package io.github.selectedtext.translator

import android.content.Context
import java.io.IOException
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONException

internal class VocabularyRepository(context: Context, private val translatorStore: TranslatorStore) {
    private val preferences = context.getSharedPreferences("vocabulary-study", Context.MODE_PRIVATE)
    private val bank by lazy {
        context.assets.open("study-words.json").bufferedReader().use { parseStudyWords(it.readText()) }
    }
    private val bankWords by lazy { bank.map(StudyWord::word).toSet() }
    private val mutex = Mutex()
    private val recordingScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var progress: VocabularyProgress? = null

    private suspend fun savedWords(): Set<String> {
        translatorStore.load()
        return translatorStore.saved.value.mapNotNull { vocabularyWord(it.source) }.toSet()
    }

    suspend fun plan(): VocabularyPlan = withProgress { current ->
        buildVocabularyPlan(bank, current, savedWords(), System.currentTimeMillis())
    }

    fun recordLookup(text: String) {
        val word = vocabularyWord(text) ?: return
        val now = System.currentTimeMillis()
        val zone = ZoneId.systemDefault()
        recordingScope.launch {
            try {
                withProgress { current ->
                    if (word !in bankWords) return@withProgress
                    val previous = current.lookups[word]
                    val lookup = recordWordLookup(previous, now, zone)
                    if (lookup != previous) write(current.copy(lookups = current.lookups + (word to lookup)))
                }
            } catch (_: IOException) {
                // A study storage failure must not affect a successful translation.
            } catch (_: JSONException) {
                // The study page presents its own load error.
            } catch (_: IllegalArgumentException) {
                // Keep the reader usable if the study word asset is invalid.
            }
        }
    }

    suspend fun rate(card: VocabularyCard, rating: FirstRating): Boolean = rate(card) { _, now ->
        if (card.isReview) null else initialWordProgress(rating, now)
    }

    suspend fun rate(card: VocabularyCard, rating: ReviewRating): Boolean = rate(card) { previous, now ->
        val dueAt = previous?.dueAt ?: return@rate null
        if (dueAt > now) null else reviewWordProgress(previous, rating, now)
    }

    private suspend fun rate(card: VocabularyCard, update: (WordProgress?, Long) -> WordProgress?): Boolean =
        withProgress { current ->
            val word = card.entry.word
            val previous = current.words[word]
            if (previous != card.progress || word !in bankWords) return@withProgress false
            val next = update(previous, System.currentTimeMillis()) ?: return@withProgress false
            val startingTier = current.startingTier ?: initialVocabularyTier(bank, current, savedWords())
            write(current.copy(words = current.words + (word to next), startingTier = startingTier))
            true
        }

    private suspend fun <T> withProgress(action: suspend (VocabularyProgress) -> T): T =
        mutex.withLock {
            withContext(Dispatchers.IO) {
                val current = progress ?: parseVocabularyProgress(preferences.getString("progress-v1", "{}") ?: "{}")
                    .also { progress = it }
                action(current)
            }
        }

    private fun write(value: VocabularyProgress) {
        if (!preferences.edit().putString("progress-v1", serializeVocabularyProgress(value)).commit()) {
            throw IOException("Unable to save vocabulary progress.")
        }
        progress = value
    }
}
