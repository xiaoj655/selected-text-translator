package io.github.selectedtext.translator

internal data class ArticleBlock(val text: String, val heading: Boolean = false)

internal data class ArticlePosition(val index: Int = 0, val offset: Int = 0)

internal data class ReadingArticle(
    val id: String,
    val title: String,
    val sourceUrl: String?,
    val blocks: List<ArticleBlock>,
    val position: ArticlePosition = ArticlePosition(),
    val updatedAt: Long = 0,
)
