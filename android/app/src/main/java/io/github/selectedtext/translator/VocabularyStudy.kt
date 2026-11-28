package io.github.selectedtext.translator

import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.math.abs
import org.json.JSONArray
import org.json.JSONObject

internal data class StudyWord(val word: String, val tier: Int, val meaning: String, val example: String)

internal enum class FirstRating { KNOWN, FAMILIAR, NEW }

internal enum class ReviewRating { REMEMBERED, FORGOT }

internal data class WordProgress(
    val firstRating: FirstRating,
    val dueAt: Long?,
    val intervalDays: Int,
    val firstSeenAt: Long = 0,
)

internal data class WordLookup(val count: Int, val lastLookupAt: Long)

internal data class VocabularyProgress(
    val words: Map<String, WordProgress> = emptyMap(),
    val lookups: Map<String, WordLookup> = emptyMap(),
    val startingTier: Int? = null,
)

internal data class VocabularyCard(val entry: StudyWord, val progress: WordProgress? = null, val fromHistory: Boolean = false) {
    val isReview: Boolean get() = progress != null
}

internal data class VocabularyPlan(
    val cards: List<VocabularyCard>,
    val nextReviewAt: Long?,
    val remainingDue: Int,
) {
    val reviewCount: Int = cards.count(VocabularyCard::isReview)
    val newCount: Int = cards.size - reviewCount
}

private const val MINUTE_MS = 60_000L
private const val DAY_MS = 24 * 60 * MINUTE_MS
private const val DIFFICULTY_SAMPLE_SIZE = 12
private val reviewIntervals = listOf(1, 3, 7, 14, 30)
private val englishWord = Regex("[a-z]+(?:['-][a-z]+)*")

internal fun vocabularyWord(text: String): String? =
    text.trim().lowercase(Locale.ROOT).takeIf { it.length in 1..64 && englishWord.matches(it) }

internal fun parseStudyWords(json: String): List<StudyWord> {
    val rows = JSONArray(json)
    val words = List(rows.length()) { index ->
        val row = rows.getJSONArray(index)
        val word = row.getString(0)
        val tier = row.getInt(1)
        val meaning = row.getString(2)
        val example = row.getString(3)
        require(vocabularyWord(word) == word && tier in 1..4 && meaning.isNotBlank() && example.isNotBlank())
        StudyWord(word, tier, meaning, example)
    }
    require(words.isNotEmpty() && words.distinctBy(StudyWord::word).size == words.size)
    return words
}

internal fun recordWordLookup(previous: WordLookup?, now: Long, zone: ZoneId): WordLookup {
    if (previous == null) return WordLookup(1, now)
    if (now <= previous.lastLookupAt) return previous
    val previousDay = Instant.ofEpochMilli(previous.lastLookupAt).atZone(zone).toLocalDate()
    val day = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val count = if (day != previousDay && previous.count < Int.MAX_VALUE) previous.count + 1 else previous.count
    return WordLookup(count, now)
}

internal fun initialWordProgress(rating: FirstRating, now: Long): WordProgress = when (rating) {
    FirstRating.KNOWN -> WordProgress(rating, null, 0, now)
    FirstRating.FAMILIAR -> WordProgress(rating, now + DAY_MS, 1, now)
    FirstRating.NEW -> WordProgress(rating, now + 10 * MINUTE_MS, 0, now)
}

internal fun reviewWordProgress(previous: WordProgress, rating: ReviewRating, now: Long): WordProgress {
    if (rating == ReviewRating.FORGOT) return previous.copy(dueAt = now + 10 * MINUTE_MS, intervalDays = 0)
    val interval = reviewIntervals.firstOrNull { it > previous.intervalDays } ?: reviewIntervals.last()
    return previous.copy(dueAt = now + interval * DAY_MS, intervalDays = interval)
}

internal fun initialVocabularyTier(
    bank: List<StudyWord>,
    progress: VocabularyProgress,
    savedWords: Set<String>,
): Int {
    val priorTiers = bank.filter { it.word in savedWords || it.word in progress.lookups }
        .map(StudyWord::tier).sorted()
    return if (priorTiers.size < 3) 2 else priorTiers[(priorTiers.size - 1) / 2].coerceIn(1, 3)
}

private fun difficulty(bank: List<StudyWord>, progress: VocabularyProgress, savedWords: Set<String>): Int {
    val ratings = bank.groupBy(StudyWord::tier).mapValues { (_, entries) ->
        entries.mapNotNull { progress.words[it.word] }
            .sortedByDescending(WordProgress::firstSeenAt)
            .take(DIFFICULTY_SAMPLE_SIZE)
    }
    fun hasSignal(tier: Int, rating: FirstRating): Boolean {
        val tierRatings = ratings[tier].orEmpty()
        return tierRatings.size >= 4 && tierRatings.count { it.firstRating == rating } * 4 >= tierRatings.size * 3
    }

    var tier = progress.startingTier ?: initialVocabularyTier(bank, progress, savedWords)
    while (tier > 1 && hasSignal(tier, FirstRating.NEW) && !hasSignal(tier - 1, FirstRating.KNOWN)) tier--
    while (tier < 4 && hasSignal(tier, FirstRating.KNOWN) && !hasSignal(tier + 1, FirstRating.NEW)) tier++
    return tier
}

internal fun studyWordChecksum(word: String): Int =
    word.fold(0) { hash, letter -> (hash * 31 + letter.code) % 65_521 }

internal fun buildVocabularyPlan(
    bank: List<StudyWord>,
    progress: VocabularyProgress,
    savedWords: Set<String>,
    now: Long,
): VocabularyPlan {
    val historyWords = savedWords + progress.lookups.keys
    val priorCards = bank.mapNotNull { word ->
        progress.words[word.word]?.takeIf { it.dueAt != null }?.let { VocabularyCard(word, it, word.word in historyWords) }
    }
    val dues = priorCards.filter { (it.progress?.dueAt ?: Long.MAX_VALUE) <= now }
        .sortedWith(compareBy({ it.progress?.dueAt }, { studyWordChecksum(it.entry.word) }, { it.entry.word }))
    val review = dues.take(6)
    val stableOrder = compareBy<StudyWord>({ studyWordChecksum(it.word) }, StudyWord::word)
    val available = bank.filter { it.word !in progress.words }.sortedWith(stableOrder)
    val newLimit = minOf(5, 8 - review.size, available.size)
    val nextReviewAt = priorCards.mapNotNull { it.progress?.dueAt?.takeIf { dueAt -> dueAt > now } }.minOrNull()
    if (newLimit == 0) return VocabularyPlan(review, nextReviewAt, dues.size - review.size)

    val tier = difficulty(bank, progress, savedWords)
    val introductions = bank.count { it.word in progress.words }
    val closestTiers = (1..4).sortedBy { abs(it - tier) }
    val probeTiers = closestTiers.filter { abs(it - tier) == 1 }
        .let { if (introductions % 2 == 1) it.reversed() else it }
    val probeCount = if (newLimit >= 3) minOf(2, newLimit - 1) else 0
    val selected = linkedSetOf<StudyWord>()
    val lookupOrder = compareByDescending<StudyWord> { it.word in savedWords }
        .thenByDescending { progress.lookups[it.word]?.count ?: 0 }
        .thenByDescending { progress.lookups[it.word]?.lastLookupAt ?: 0 }
        .then(stableOrder)

    fun fillFromTier(fromTier: Int, count: Int) {
        available.asSequence().filter { it.tier == fromTier && it !in selected }.take(count).forEach(selected::add)
    }

    available.filter { it.word in historyWords }.minWithOrNull(lookupOrder)?.let(selected::add)
    closestTiers.forEach { fillFromTier(it, newLimit - probeCount - selected.size) }
    repeat(probeCount) { index -> fillFromTier(probeTiers[index % probeTiers.size], 1) }
    closestTiers.forEach { fillFromTier(it, newLimit - selected.size) }
    val newWords = selected.map { VocabularyCard(it, fromHistory = it.word in historyWords) }
    return VocabularyPlan(review + newWords, nextReviewAt, dues.size - review.size)
}

internal fun parseVocabularyProgress(json: String): VocabularyProgress {
    val data = JSONObject(json)
    val words = data.optJSONObject("words") ?: JSONObject()
    val lookups = data.optJSONObject("lookups") ?: JSONObject()
    val wordProgress = words.keys().asSequence().mapNotNull { key ->
        val record = words.optJSONObject(key) ?: return@mapNotNull null
        val first = FirstRating.entries.firstOrNull { it.name.lowercase(Locale.ROOT) == record.optString("firstRating") }
            ?: return@mapNotNull null
        val recordDue = record.optLong("dueAt").takeIf { it > 0 }
        val due = if (first == FirstRating.KNOWN) null else recordDue ?: return@mapNotNull null
        val interval = record.optInt("intervalDays").coerceIn(0, reviewIntervals.last())
        val firstSeenAt = record.optLong("firstSeenAt").coerceAtLeast(0)
        key to WordProgress(first, due, interval, firstSeenAt)
    }.toMap()
    val lookupProgress = lookups.keys().asSequence().mapNotNull { key ->
        val record = lookups.optJSONObject(key) ?: return@mapNotNull null
        val count = record.optInt("count").takeIf { it > 0 } ?: return@mapNotNull null
        val lastLookupAt = record.optLong("lastLookupAt").takeIf { it > 0 } ?: return@mapNotNull null
        key to WordLookup(count, lastLookupAt)
    }.toMap()
    val startingTier = data.optInt("startingTier").takeIf { it in 1..3 }
    return VocabularyProgress(wordProgress, lookupProgress, startingTier)
}

internal fun serializeVocabularyProgress(progress: VocabularyProgress): String {
    val words = JSONObject()
    val lookups = JSONObject()
    progress.words.forEach { (word, record) ->
        words.put(word, JSONObject()
            .put("firstRating", record.firstRating.name.lowercase(Locale.ROOT))
            .put("dueAt", record.dueAt ?: JSONObject.NULL)
            .put("intervalDays", record.intervalDays)
            .put("firstSeenAt", record.firstSeenAt))
    }
    progress.lookups.forEach { (word, record) ->
        lookups.put(word, JSONObject().put("count", record.count).put("lastLookupAt", record.lastLookupAt))
    }
    return JSONObject().put("words", words).put("lookups", lookups)
        .put("startingTier", progress.startingTier ?: JSONObject.NULL).toString()
}
