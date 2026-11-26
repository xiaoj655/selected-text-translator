package io.github.selectedtext.translator

import kotlin.math.abs

internal data class ArticleBlock(val text: String, val heading: Boolean = false, val image: ArticleImage? = null)

internal data class ArticleImage(val url: String, val alt: String = "", val aspectRatio: Float? = null)

internal data class ArticlePosition(val index: Int = 0, val offset: Int = 0)

internal data class ReadingArticle(
    val id: String,
    val title: String,
    val sourceUrl: String?,
    val blocks: List<ArticleBlock>,
    val position: ArticlePosition = ArticlePosition(),
    val updatedAt: Long = 0,
) {
    val hasImages = blocks.any { it.image != null }
}

internal fun positionWithImages(previous: ReadingArticle, blocks: List<ArticleBlock>): ArticlePosition {
    val position = previous.position
    if (position.index == 0) return position
    val previousBlock = previous.blocks.getOrNull(position.index - 1) ?: return ArticlePosition()
    val textIndices = blocks.indices.filter { blocks[it].image == null }
    val textIndex = textIndices.withIndex()
        .filter { (_, index) -> blocks[index] == previousBlock }
        .minByOrNull { (index, _) -> abs(index - (position.index - 1)) }
        ?.value
    return if (textIndex != null) ArticlePosition(textIndex + 1, position.offset)
    else ArticlePosition((textIndices.getOrNull(position.index - 1) ?: blocks.lastIndex) + 1)
}
