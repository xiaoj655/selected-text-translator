package io.github.selectedtext.translator

import java.text.BreakIterator
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

internal enum class ArticleSelectionKind { WORD, SENTENCE }

internal data class ArticleSelection(
    val text: String,
    val start: Int,
    val end: Int,
    val sentence: String,
    val sentenceStart: Int,
    val sentenceEnd: Int,
    val kind: ArticleSelectionKind,
)

internal data class ArticleMeaning(
    val text: String,
    val phonetic: String = "",
    val contextualAnalysis: String = "",
)

internal enum class ArticleGrammarRole { SUBJECT, VERB, OBJECT, COMPLEMENT }

internal data class ArticleGrammarSpan(val role: ArticleGrammarRole, val start: Int, val end: Int)

internal data class ArticleGrammarDetail(
    val text: String,
    val explanation: String,
    val structure: List<ArticleGrammarSpan> = emptyList(),
)

internal data class ArticleSentenceAnalysis(
    val paraphrase: String,
    val structure: List<ArticleGrammarSpan>,
    val details: List<ArticleGrammarDetail>,
)

private val WORD = Regex("[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*(?:['’‐‑-][\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*)*")
private val ABBREVIATION = Regex("""\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e|(?:[A-Z]\.)+[A-Z])\.$""")
private const val ARTICLE_CONTEXT_LIMIT = 2_400
private const val OCCURRENCE_CONTEXT_LIMIT = 120

internal fun resolveArticleSelection(text: String, offset: Int, kind: ArticleSelectionKind): ArticleSelection? {
    if (offset !in 0..text.length || text.isBlank()) return null
    val hit = if (offset == text.length) offset - 1 else offset
    val sentences = BreakIterator.getSentenceInstance(Locale.ENGLISH).apply { setText(text) }
    var start = sentences.preceding(hit + 1).coerceAtLeast(0)
    var end = sentences.following(hit).let { if (it == BreakIterator.DONE) text.length else it }
    while (start > 0) {
        val previousStart = sentences.preceding(start).coerceAtLeast(0)
        if (!isAbbreviation(text, previousStart, start)) break
        start = previousStart
    }
    while (end < text.length && isAbbreviation(text, start, end)) {
        end = sentences.following(end).let { if (it == BreakIterator.DONE) text.length else it }
    }
    while (start < end && text[start].isWhitespace()) start++
    while (end > start && text[end - 1].isWhitespace()) end--
    if (start == end) return null
    val sentence = text.substring(start, end)
    if (kind == ArticleSelectionKind.SENTENCE) {
        return ArticleSelection(sentence, start, end, sentence, start, end, kind)
    }
    val relativeHit = hit - start
    val word = WORD.findAll(sentence).firstOrNull { relativeHit in it.range }
        ?: WORD.findAll(sentence).firstOrNull { offset - start == it.range.last + 1 }
        ?: return null
    return ArticleSelection(word.value, start + word.range.first, start + word.range.last + 1, sentence, start, end, kind)
}

private fun isAbbreviation(text: String, start: Int, end: Int): Boolean =
    ABBREVIATION.containsMatchIn(text.substring(start, end).trimEnd())

internal fun articleMeaningInput(selection: ArticleSelection): JSONObject {
    val relativeStart = selection.start - selection.sentenceStart
    val relativeEnd = selection.end - selection.sentenceStart
    val contextStart = (relativeStart - (ARTICLE_CONTEXT_LIMIT - selection.text.length).coerceAtLeast(0) / 2)
        .coerceAtLeast(0)
    val contextEnd = (contextStart + ARTICLE_CONTEXT_LIMIT).coerceAtMost(selection.sentence.length)
    return JSONObject()
        .put("selectedText", selection.text)
        .put("selectionType", selection.kind.name.lowercase(Locale.ROOT))
        .put("targetLanguage", "English")
        .apply {
            if (selection.kind == ArticleSelectionKind.WORD &&
                relativeStart >= contextStart && relativeEnd <= contextEnd && relativeEnd > relativeStart
            ) {
                put("surroundingContext", selection.sentence.substring(contextStart, contextEnd))
                put("contextStart", relativeStart - contextStart)
                put("contextEnd", relativeEnd - contextStart)
                put("selectedOccurrence", JSONObject()
                    .put("before", selection.sentence.substring((relativeStart - OCCURRENCE_CONTEXT_LIMIT).coerceAtLeast(contextStart), relativeStart))
                    .put("text", selection.text)
                    .put("after", selection.sentence.substring(relativeEnd, (relativeEnd + OCCURRENCE_CONTEXT_LIMIT).coerceAtMost(contextEnd))))
            }
        }
}

internal fun parseArticleMeaning(result: JSONObject, word: Boolean): ArticleMeaning {
    val meaning = result.articleString("meaning")
    if (meaning.isBlank()) throw ProviderException("The learning model did not return a meaning. Try again.")
    return ArticleMeaning(
        meaning,
        if (word) result.articleString("phonetic") else "",
        if (word) result.articleString("contextualAnalysis") else "",
    )
}

internal fun parseArticleSentenceAnalysis(result: JSONObject, sentence: String): ArticleSentenceAnalysis {
    val paraphrase = result.articleString("paraphrase")
    if (paraphrase.isBlank()) throw ProviderException("The learning model did not explain the sentence. Try again.")
    val nested = result.optJSONObject("sentenceAnalysis")
    val details = listOf("connections" to 3, "clauses" to 6, "fragments" to 2).flatMap { (name, limit) ->
        nested?.optJSONArray(name).articleObjects(24).mapNotNull { note ->
            val quote = note.articleString("text")
            val start = sentence.locateFragment(quote, note) ?: return@mapNotNull null
            val explanation = note.articleString("explanation")
            if (explanation.isEmpty() || explanation.length > 600) return@mapNotNull null
            ArticleGrammarDetail(
                quote,
                explanation,
                if (name == "clauses") parseGrammarSpans(note.optJSONArray("structure"), sentence, start, start + quote.length)
                else emptyList(),
            )
        }.distinctBy { it.text to it.explanation }.take(limit)
    }
    return ArticleSentenceAnalysis(paraphrase, parseGrammarSpans(result.optJSONArray("structure"), sentence), details)
}

private fun parseGrammarSpans(
    parts: JSONArray?,
    text: String,
    start: Int = 0,
    end: Int = text.length,
): List<ArticleGrammarSpan> {
    val spans = mutableListOf<ArticleGrammarSpan>()
    for (part in parts.articleObjects(64)) {
        val roleName = part.articleString("role")
        val role = ArticleGrammarRole.entries.firstOrNull { it.name.equals(roleName, ignoreCase = true) } ?: continue
        val fragment = part.articleString("text")
        val offset = text.locateFragment(fragment, part) ?: continue
        val span = ArticleGrammarSpan(role, offset, offset + fragment.length)
        if (span.start >= start && span.end <= end && spans.none { it.start < span.end && it.end > span.start }) {
            spans.add(span)
        }
    }
    return spans.sortedBy { it.start }
}

private fun String.locateFragment(fragment: String, value: JSONObject): Int? {
    if (fragment.isEmpty() || value.opt("text") != fragment || fragment.length > length) return null
    val occurrence = if (value.has("occurrence")) {
        val raw = value.opt("occurrence")
        if (raw !is Number || raw.toDouble() != raw.toInt().toDouble() || raw.toInt() <= 0) return null
        raw.toInt()
    } else {
        null
    }
    val left = if (fragment.codePointAt(0).isWordCharacter()) "(?<![\\p{L}\\p{M}\\p{N}])" else ""
    val right = if (fragment.codePointBefore(fragment.length).isWordCharacter()) "(?![\\p{L}\\p{M}\\p{N}])" else ""
    val matches = Regex("$left(?=${Regex.escape(fragment)}$right)").findAll(this)
    return if (occurrence == null) matches.take(2).toList().singleOrNull()?.range?.first
    else matches.elementAtOrNull(occurrence - 1)?.range?.first
}

private fun Int.isWordCharacter(): Boolean = Character.isLetterOrDigit(this) || Character.getType(this) in setOf(
    Character.NON_SPACING_MARK.toInt(), Character.COMBINING_SPACING_MARK.toInt(), Character.ENCLOSING_MARK.toInt(),
)

private fun JSONObject.articleString(key: String) = (opt(key) as? String)?.trim().orEmpty()

private fun JSONArray?.articleObjects(limit: Int): List<JSONObject> =
    if (this == null) emptyList() else (0 until minOf(length(), limit)).mapNotNull(::optJSONObject)
