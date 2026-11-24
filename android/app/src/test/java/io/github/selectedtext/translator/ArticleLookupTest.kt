package io.github.selectedtext.translator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ArticleLookupTest {
    @Test
    fun expandsPhraseWithinTheOriginalSentenceAndKeepsTheExactOccurrence() {
        val article = "They record a record every month. We record a record too."
        val anchor = resolveArticleSelection(article, article.indexOf(" every"), ArticleSelectionKind.WORD)!!
        val phrase = resolveArticlePhrase(article, anchor, article.indexOf("record"))!!
        assertEquals(ArticleSelectionKind.PHRASE, phrase.kind)
        assertEquals("record a record", phrase.text)
        val input = articleMeaningInput(phrase)
        val occurrence = input.getJSONObject("selectedOccurrence")
        assertEquals("They ", occurrence.getString("before"))
        assertEquals(" every month.", occurrence.getString("after"))
        assertNull(resolveArticlePhrase(article, anchor, article.lastIndexOf("record")))
    }

    @Test
    fun repeatedWordKeepsItsExactSentenceOccurrence() {
        val article = "Read this first. We record a record every month. That's all."
        val wordStart = article.lastIndexOf("record")
        val selected = resolveArticleSelection(article, wordStart + 2, ArticleSelectionKind.WORD)!!

        assertEquals("record", selected.text)
        assertEquals(wordStart, selected.start)
        assertEquals(wordStart + 6, selected.end)
        assertEquals("We record a record every month.", selected.sentence)

        val request = articleMeaningInput(selected)
        assertEquals("English", request.getString("targetLanguage"))
        assertEquals(12, request.getInt("contextStart"))
        assertEquals(18, request.getInt("contextEnd"))
        val occurrence = request.getJSONObject("selectedOccurrence")
        assertEquals("We record a ", occurrence.getString("before"))
        assertEquals(" every month.", occurrence.getString("after"))
    }

    @Test
    fun resolvesQuotesAbbreviationsContractionsAndHyphenatedWords() {
        val article = "All done. Dr. Taylor said, “It's well-known.” She waved."
        val start = article.indexOf("Taylor")
        val sentence = resolveArticleSelection(article, start, ArticleSelectionKind.SENTENCE)!!
        val contraction = resolveArticleSelection(article, article.indexOf("It's") + 2, ArticleSelectionKind.WORD)!!
        val compound = resolveArticleSelection(article, article.indexOf("well-known") + 4, ArticleSelectionKind.WORD)!!

        assertEquals("Dr. Taylor said, “It's well-known.”", sentence.text)
        assertEquals(article.indexOf("Dr."), sentence.start)
        assertEquals(article.indexOf(" She"), sentence.end)
        assertEquals("It's", contraction.text)
        assertEquals("well-known", compound.text)
        assertNull(resolveArticleSelection(article, -1, ArticleSelectionKind.WORD))
    }

    @Test
    fun trimsVeryLongContextAroundTheSelectedWord() {
        val article = "The " + "other ".repeat(500) + "target stands out."
        val selected = resolveArticleSelection(article, article.indexOf("target"), ArticleSelectionKind.WORD)!!
        val request = articleMeaningInput(selected)
        val context = request.getString("surroundingContext")

        assertEquals("target", context.substring(request.getInt("contextStart"), request.getInt("contextEnd")))
        assertEquals(" stands out.", request.getJSONObject("selectedOccurrence").getString("after"))
    }

    @Test
    fun acceptsOnlyWholeExactGrammarFragmentsWithValidOccurrences() {
        val sentence = "They saw a saw that cut wood."
        val analysis = parseArticleSentenceAnalysis(JSONObject("""
            {
              "paraphrase": "They noticed a tool that cut wood.",
              "structure": [
                {"role":"verb","text":"saw"},
                {"role":"object","text":"saw","occurrence":2},
                {"role":"subject","text":"They"},
                {"role":"verb","text":"saw","occurrence":1},
                {"role":"object","text":"a saw"},
                {"role":"verb","text":"wood","occurrence":"1"},
                {"role":"complement","text":"woo"},
                {"role":"object","text":"a saw","occurrence":1.5},
                {"role":"adverb","text":"wood"}
              ],
              "sentenceAnalysis": {
                "clauses": [
                  {"text":"that cut wood","explanation":"This defines which tool they saw.",
                   "structure":[{"role":"subject","text":"that"},{"role":"verb","text":"cut"},{"role":"object","text":"They"}]},
                  {"text":" that cut wood","explanation":"The quote is missing an exact boundary."}
                ],
                "fragments":[{"text":"absent","explanation":"This was not in the article."}]
              }
            }
        """.trimIndent()), sentence)

        assertEquals("They noticed a tool that cut wood.", analysis.paraphrase)
        assertEquals(
            listOf("SUBJECT:They", "VERB:saw", "OBJECT:saw"),
            analysis.structure.map { "${it.role}:${sentence.substring(it.start, it.end)}" },
        )
        val detail = analysis.details.single()
        assertEquals("that cut wood", detail.text)
        assertEquals(listOf("that", "cut"), detail.structure.map { sentence.substring(it.start, it.end) })
    }

    @Test
    fun requiresAPlainEnglishMeaningAndParaphrase() {
        assertThrows(ProviderException::class.java) { parseArticleMeaning(JSONObject("""{"meaning":2}"""), word = true) }
        assertThrows(ProviderException::class.java) { parseArticleSentenceAnalysis(JSONObject(), "She left.") }
    }
}
