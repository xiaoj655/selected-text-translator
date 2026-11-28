package io.github.selectedtext.translator

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class VocabularySession(
    val cards: List<VocabularyCard>,
    val index: Int = 0,
    val revealed: Boolean = false,
) {
    val card: VocabularyCard get() = cards[index]
}

internal data class VocabularyUiState(
    val plan: VocabularyPlan? = null,
    val session: VocabularySession? = null,
    val completed: Int = 0,
    val busy: Boolean = false,
    val error: String? = null,
)

internal class VocabularyViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as TranslatorApplication).vocabulary
    private val current = MutableStateFlow(VocabularyUiState())
    val state = current.asStateFlow()

    fun load() {
        if (current.value.session != null) return
        runOperation("Couldn't load vocabulary. Try again.") {
            val plan = repository.plan()
            current.update { it.copy(plan = plan) }
        }
    }

    fun start() {
        if (current.value.session != null) return
        runOperation("Couldn't start studying. Try again.") {
            val plan = repository.plan()
            val session = plan.cards.takeIf { it.isNotEmpty() }?.let { VocabularySession(it) }
            current.update { it.copy(plan = plan, session = session, completed = 0) }
        }
    }

    fun reveal() {
        current.update { it.copy(session = it.session?.copy(revealed = true)) }
    }

    fun rate(card: VocabularyCard, rating: FirstRating) = rate(card) { repository.rate(card, rating) }

    fun rate(card: VocabularyCard, rating: ReviewRating) = rate(card) { repository.rate(card, rating) }

    private fun rate(card: VocabularyCard, write: suspend () -> Boolean) {
        val session = current.value.session ?: return
        if (!session.revealed || session.card != card) return
        runOperation("Couldn't save your answer. Try again.") {
            if (!write()) {
                current.update { it.copy(plan = null, session = null, error = "The study plan changed. Load it again.") }
                return@runOperation
            }
            val next = session.index + 1
            if (next == session.cards.size) {
                current.update { it.copy(session = null, plan = null, completed = next) }
                val plan = repository.plan()
                current.update { it.copy(plan = plan) }
            } else {
                current.update { it.copy(session = session.copy(index = next, revealed = false)) }
            }
        }
    }

    private fun runOperation(message: String, action: suspend () -> Unit) {
        if (current.value.busy) return
        current.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                action()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                current.update { it.copy(error = message) }
            } finally {
                current.update { it.copy(busy = false) }
            }
        }
    }
}
