package io.github.selectedtext.translator

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.withContext

internal val articleContentPadding = PaddingValues(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 36.dp)
internal val articleItemSpacing = 18.dp
internal val articleTitleSpacing = 7.dp

internal class ArticleScrollMetrics(val itemStarts: IntArray, val contentHeight: Int)

@Composable
internal fun rememberArticleScrollMetrics(
    listWidth: Int,
    title: String,
    source: String,
    blocks: List<ArticleBlock>,
    titleStyle: TextStyle,
    sourceStyle: TextStyle,
    bodyStyle: TextStyle,
    headingStyle: TextStyle,
): State<ArticleScrollMetrics?> {
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val measurer = rememberTextMeasurer(cacheSize = 0)
    val textWidth = with(density) {
        listWidth - articleContentPadding.calculateStartPadding(direction).roundToPx() -
            articleContentPadding.calculateEndPadding(direction).roundToPx()
    }
    val metrics = remember(textWidth, title, source, blocks, titleStyle, sourceStyle, bodyStyle, headingStyle, measurer) {
        mutableStateOf<ArticleScrollMetrics?>(null)
    }
    LaunchedEffect(metrics) {
        if (textWidth <= 0) return@LaunchedEffect
        metrics.value = withContext(Dispatchers.Default) {
            val titleConstraints = Constraints(maxWidth = textWidth)
            val paragraphConstraints = Constraints.fixedWidth(textWidth)
            val itemSpacing = with(density) { articleItemSpacing.roundToPx() }
            val titleSpacing = with(density) { articleTitleSpacing.roundToPx() }
            val verticalPadding = with(density) {
                articleContentPadding.calculateTopPadding().roundToPx() +
                    articleContentPadding.calculateBottomPadding().roundToPx()
            }
            val itemStarts = IntArray(blocks.size + 1)
            var height = measurer.measure(title, style = titleStyle, constraints = titleConstraints).size.height +
                titleSpacing + measurer.measure(source, style = sourceStyle, constraints = titleConstraints).size.height
            blocks.forEachIndexed { index, block ->
                ensureActive()
                height += itemSpacing
                itemStarts[index + 1] = height
                val image = block.image
                height += if (image != null) articleImageHeight(textWidth, image.aspectRatio) else {
                    val style = if (block.heading) headingStyle else bodyStyle
                    measurer.measure(block.text, style = style, constraints = paragraphConstraints).size.height
                }
            }
            ArticleScrollMetrics(itemStarts, height + verticalPadding)
        }
    }
    return metrics
}

@Composable
internal fun Modifier.articleScrollbar(
    list: LazyListState,
    metrics: State<ArticleScrollMetrics?>,
    eInkMode: Boolean,
): Modifier {
    val opacity = remember(list) { Animatable(0f) }
    val color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.48f)
    LaunchedEffect(list, eInkMode) {
        snapshotFlow { list.isScrollInProgress }.collectLatest { scrolling ->
            if (scrolling) {
                opacity.snapTo(1f)
            } else if (opacity.value > 0f) {
                delay(400)
                if (eInkMode) opacity.snapTo(0f) else opacity.animateTo(0f, tween(durationMillis = 250))
            }
        }
    }

    return drawWithContent {
        drawContent()
        val alpha = opacity.value
        if (alpha == 0f || (!list.canScrollForward && !list.canScrollBackward)) return@drawWithContent
        val measured = metrics.value ?: return@drawWithContent
        val trackInset = 4.dp.toPx()
        val trackHeight = size.height - 2 * trackInset
        val maxScroll = measured.contentHeight - size.height
        if (maxScroll <= 0f || trackHeight <= 0f) return@drawWithContent

        val thumbWidth = 3.dp.toPx()
        val thumbHeight = (trackHeight * size.height / measured.contentHeight)
            .coerceIn(minOf(24.dp.toPx(), trackHeight), trackHeight)
        val progress = when {
            !list.canScrollBackward -> 0f
            !list.canScrollForward -> 1f
            else -> {
                val itemStart = measured.itemStarts.getOrNull(list.firstVisibleItemIndex) ?: return@drawWithContent
                ((itemStart + list.firstVisibleItemScrollOffset) / maxScroll).coerceIn(0f, 1f)
            }
        }
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width - 5.dp.toPx() - thumbWidth, trackInset + (trackHeight - thumbHeight) * progress),
            size = Size(thumbWidth, thumbHeight),
            cornerRadius = CornerRadius(thumbWidth / 2),
            alpha = alpha,
        )
    }
}
