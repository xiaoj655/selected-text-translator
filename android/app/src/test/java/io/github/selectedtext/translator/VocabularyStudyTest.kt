package io.github.selectedtext.translator

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VocabularyStudyTest {
    private val now = Instant.parse("2026-11-28T03:00:00Z").toEpochMilli()
    private val bank = listOf(
        listOf("cat", "house", "play", "talk", "happy", "walk", "help", "room"),
        listOf("adapt", "benefit", "contain", "demand", "explore", "feature", "gather", "handle"),
        listOf("affirm", "baffle", "convey", "deter", "enact", "feasible", "grapple", "hinder"),
        listOf("amass", "belie", "coalesce", "deride", "elicit", "frugal", "garner", "heed"),
    ).flatMapIndexed { index, tier -> tier.map { StudyWord(it, index + 1, "中文释义", "Example for $it.") } }

    @Test
    fun coldStartUsesMixedTiersAndCanLearnWithoutTranslationHistory() {
        val plan = buildVocabularyPlan(bank, VocabularyProgress(), emptySet(), now)

        assertEquals(listOf(2, 2, 2, 1, 3), plan.cards.map { it.entry.tier })
        assertEquals(0, plan.reviewCount)
        assertEquals(5, plan.newCount)
        assertEquals(plan, buildVocabularyPlan(bank.reversed(), VocabularyProgress(), emptySet(), now))
        assertNull(plan.nextReviewAt)
    }

    @Test
    fun historySeedsTheLowerMedianAndSavedWordWinsTheTierBoost() {
        val progress = VocabularyProgress(lookups = mapOf(
            "affirm" to WordLookup(7, now),
            "amass" to WordLookup(8, now),
            "belie" to WordLookup(9, now),
            "unlisted" to WordLookup(15, now),
        ))
        val plan = buildVocabularyPlan(bank, progress, setOf("deter"), now)

        assertEquals(listOf(3, 3, 3, 2, 4), plan.cards.map { it.entry.tier })
        assertEquals("deter", plan.cards.first().entry.word)
        assertTrue(plan.cards.first().fromHistory)
        assertEquals(2, buildVocabularyPlan(bank, progress.copy(startingTier = 2), setOf("deter"), now).cards[1].entry.tier)
    }

    @Test
    fun introductionsAdaptBothWaysAndRepeatedRatingsDoNotChangeTheirSignal() {
        val tierTwo = bank.filter { it.tier == 2 }.take(4)
        val known = tierTwo.associate { it.word to initialWordProgress(FirstRating.KNOWN, now) }
        val unfamiliar = tierTwo.associate { it.word to initialWordProgress(FirstRating.NEW, now) }
        val familiar = tierTwo.associate { it.word to initialWordProgress(FirstRating.FAMILIAR, now) }

        assertEquals(3, buildVocabularyPlan(bank, VocabularyProgress(known), emptySet(), now).cards.first().entry.tier)
        assertEquals(1, buildVocabularyPlan(bank, VocabularyProgress(unfamiliar), emptySet(), now).cards.first().entry.tier)
        assertEquals(2, buildVocabularyPlan(bank, VocabularyProgress(familiar), emptySet(), now).cards.first().entry.tier)

        val reviewed = unfamiliar.mapValues { (_, item) -> reviewWordProgress(item, ReviewRating.REMEMBERED, now) }
        assertTrue(reviewed.values.all { it.firstRating == FirstRating.NEW })
        assertEquals(1, buildVocabularyPlan(bank, VocabularyProgress(reviewed), emptySet(), now).cards.first().entry.tier)
    }

    @Test
    fun recentIntroductionsReplaceAnOlderDifficultySignal() {
        val earlier = listOf("assist", "attend", "avoid", "behave", "borrow", "confirm", "consider", "depend", "earn", "expect", "follow", "improve")
        val recent = listOf("include", "inspect", "involve", "maintain", "observe", "perform", "protect", "reduce", "reflect")
        val expandedBank = bank + (earlier + recent).map { StudyWord(it, 2, "中文释义", "Example for $it.") }
        val ratings = earlier.associateWith { initialWordProgress(FirstRating.NEW, now - 86_400_000L) } +
            recent.associateWith { initialWordProgress(FirstRating.KNOWN, now - 1) }
        val initial = VocabularyProgress(ratings, startingTier = 2)
        val beforeReviewsDue = buildVocabularyPlan(expandedBank, initial, emptySet(), now - 2)
        assertEquals(3, beforeReviewsDue.cards.first { !it.isReview }.entry.tier)
        assertEquals(now - 86_400_000L, reviewWordProgress(ratings.getValue("assist"), ReviewRating.REMEMBERED, now).firstSeenAt)
    }

    @Test
    fun plansPrioritizeDueWordsWithoutBlockingAllNewWords() {
        val overdue = bank.take(7).mapIndexed { index, word ->
            word.word to WordProgress(FirstRating.NEW, now - index.toLong(), 0)
        }.toMap()
        val future = mapOf("adapt" to initialWordProgress(FirstRating.NEW, now))
        val alreadyKnown = mapOf("handle" to initialWordProgress(FirstRating.KNOWN, now))
        val plan = buildVocabularyPlan(bank, VocabularyProgress(overdue + future + alreadyKnown), emptySet(), now)

        assertEquals(6, plan.reviewCount)
        assertEquals(2, plan.newCount)
        assertEquals(1, plan.remainingDue)
        assertEquals("help", plan.cards.first().entry.word)
        assertTrue(plan.cards.take(6).all(VocabularyCard::isReview))
        assertTrue(plan.cards.drop(6).none(VocabularyCard::isReview))
        assertFalse(plan.cards.any { it.entry.word in future || it.entry.word in alreadyKnown })
        assertEquals(future["adapt"]?.dueAt, plan.nextReviewAt)
    }

    @Test
    fun ratingIntervalsAndLookupDatesSurvivePersistence() {
        val day = 86_400_000L
        val zone = ZoneId.of("Asia/Shanghai")
        val firstLookup = recordWordLookup(null, now, zone)
        val sameDay = recordWordLookup(firstLookup, now + 3_600_000, zone)
        assertEquals(1, sameDay.count)
        assertEquals(now + 3_600_000, sameDay.lastLookupAt)
        val repeated = recordWordLookup(firstLookup, now + day, zone)
        assertEquals(2, repeated.count)
        val new = initialWordProgress(FirstRating.NEW, now)
        val familiar = initialWordProgress(FirstRating.FAMILIAR, now)
        val known = initialWordProgress(FirstRating.KNOWN, now)
        assertEquals(now + 600_000L, new.dueAt)
        assertEquals(now + day, familiar.dueAt)
        assertNull(known.dueAt)
        assertEquals(now + 3 * day, reviewWordProgress(familiar, ReviewRating.REMEMBERED, now).dueAt)
        assertEquals(now + 600_000L, reviewWordProgress(familiar, ReviewRating.FORGOT, now).dueAt)
        assertEquals(30, reviewWordProgress(familiar.copy(intervalDays = 30), ReviewRating.REMEMBERED, now).intervalDays)

        val progress = VocabularyProgress(
            mapOf("adapt" to new, "benefit" to familiar, "handle" to known),
            mapOf("adapt" to repeated),
            startingTier = 2,
        )
        assertEquals(progress, parseVocabularyProgress(serializeVocabularyProgress(progress)))
    }

    @Test
    fun bankAndLookupsAcceptOnlyCanonicalSingleWords() {
        assertEquals("adapt", vocabularyWord(" Adapt "))
        assertNull(vocabularyWord("adapt quickly"))
        assertNull(vocabularyWord("中文"))
        val word = parseStudyWords("""[["adapt",2,"适应","People adapt quickly."]]""").single()
        assertEquals(StudyWord("adapt", 2, "适应", "People adapt quickly."), word)
    }
}
