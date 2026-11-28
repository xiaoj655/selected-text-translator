package io.github.selectedtext.translator

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date

@Composable
internal fun VocabularyScreen(
    state: VocabularyUiState,
    study: VocabularyViewModel,
    speaking: Boolean,
    speak: (String) -> Unit,
    stopSpeech: () -> Unit,
    modifier: Modifier,
) {
    LaunchedEffect(study) { study.load() }
    val session = state.session
    key(session?.card?.entry?.word) {
        Column(
            modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = 460.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (session == null) VocabularyOverview(state, study)
                else VocabularyPrompt(session, state.busy, speaking, study, speak, stopSpeech)
                state.error?.let { error -> Text(error, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@Composable
private fun VocabularyOverview(state: VocabularyUiState, study: VocabularyViewModel) {
    val plan = state.plan
    if (state.completed > 0) {
        val label = if (state.completed == 1) "word studied" else "words studied"
        Text("${state.completed} $label", style = MaterialTheme.typography.headlineMedium)
    }
    if (plan == null) {
        if (state.busy || state.error == null) CircularProgressIndicator()
        else OutlinedButton(onClick = study::load) { Text("Try again") }
        return
    }
    if (plan.cards.isEmpty()) {
        Text("You're caught up", style = MaterialTheme.typography.headlineSmall)
        val next = plan.nextReviewAt
        if (next != null) {
            val time = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(next))
            Text("Next review $time", color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = study::load, enabled = !state.busy) { Text("Check for reviews") }
        } else {
            Text("You've seen every word in the vocabulary list.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    val counts = buildList {
        if (plan.reviewCount > 0) add("${plan.reviewCount} to review")
        if (plan.newCount > 0) add("${plan.newCount} new")
    }
    Text("Study a short set", style = MaterialTheme.typography.headlineSmall)
    Text(counts.joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (plan.remainingDue > 0) {
        Text("${plan.remainingDue} more due after this set", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Button(onClick = study::start, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
        Text("Start studying")
    }
}

@Composable
private fun VocabularyPrompt(
    session: VocabularySession,
    busy: Boolean,
    speaking: Boolean,
    study: VocabularyViewModel,
    speak: (String) -> Unit,
    stopSpeech: () -> Unit,
) {
    val card = session.card
    val word = card.entry
    val label = if (card.isReview) "Review" else "New word"
    val source = if (card.fromHistory) " · From your lookups or saved words" else ""
    Text("$label · ${session.index + 1} of ${session.cards.size}$source", color = MaterialTheme.colorScheme.onSurfaceVariant)
    LinearProgressIndicator(
        progress = { (session.index + 1).toFloat() / session.cards.size },
        modifier = Modifier.fillMaxWidth(),
    )
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(word.word, Modifier.weight(1f), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold)
        IconButton(onClick = { speak(word.word) }) {
            Icon(
                painterResource(if (speaking) R.drawable.ic_stop else R.drawable.ic_volume),
                contentDescription = if (speaking) "Stop pronunciation" else "Listen to ${word.word}",
            )
        }
    }
    if (!session.revealed) {
        Text("Recall the meaning, then check your answer.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = study::reveal, modifier = Modifier.fillMaxWidth()) { Text("Show meaning") }
        return
    }
    Text(word.meaning, style = MaterialTheme.typography.titleLarge)
    Text(word.example, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
    if (card.isReview) {
        VocabularyRating("Remembered", busy) { stopSpeech(); study.rate(card, ReviewRating.REMEMBERED) }
        VocabularyRating("Forgot", busy) { stopSpeech(); study.rate(card, ReviewRating.FORGOT) }
    } else {
        VocabularyRating("Already knew", busy) { stopSpeech(); study.rate(card, FirstRating.KNOWN) }
        VocabularyRating("Looks familiar", busy) { stopSpeech(); study.rate(card, FirstRating.FAMILIAR) }
        VocabularyRating("New to me", busy) { stopSpeech(); study.rate(card, FirstRating.NEW) }
    }
}

@Composable
private fun VocabularyRating(label: String, busy: Boolean, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(label) }
}
