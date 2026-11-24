package io.github.selectedtext.translator

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.net.URI
import kotlinx.coroutines.flow.filterNotNull

@Composable
internal fun ReaderScreen(
    state: ReaderUiState,
    reader: ReaderViewModel,
    speaking: Boolean,
    speak: (String) -> Unit,
    stopSpeech: () -> Unit,
    paste: () -> String?,
    onSettings: () -> Unit,
    onExit: () -> Unit,
) {
    var adding by rememberSaveable { mutableStateOf(false) }
    val article = state.activeArticle
    val sharedError = state.pendingUrl?.takeIf { state.importError != null }
    var sharedDraft by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(sharedError) {
        if (sharedError != null) {
            sharedDraft = sharedError
            adding = true
        }
    }
    val back = {
        stopSpeech()
        when {
            state.result != null -> reader.dismissResult()
            article != null -> reader.closeArticle()
            else -> onExit()
        }
    }
    BackHandler(enabled = article != null, onBack = back)
    if (article == null) {
        ReadingLibrary(state, reader, onExit) {
            reader.clearImportError()
            sharedDraft = ""
            adding = true
        }
    } else {
        key(article.id) {
            ArticleContent(article, state.result, reader, speaking, speak, stopSpeech, onSettings, back)
        }
    }
    if (adding) {
        AddArticleSheet(state, sharedDraft, reader, paste) {
            adding = false
            sharedDraft = ""
            reader.clearImportError()
        }
        LaunchedEffect(article?.id, state.importing, state.importError) {
            if (article != null && !state.importing && state.importError == null) {
                adding = false
                sharedDraft = ""
            }
        }
    }
}

@Composable
private fun ReadingLibrary(
    state: ReaderUiState,
    reader: ReaderViewModel,
    onExit: () -> Unit,
    onAdd: () -> Unit,
) {
    var removing by remember { mutableStateOf<ReadingArticle?>(null) }
    Column(Modifier.fillMaxSize()) {
        ReadingHeader("Reading", onExit) {
            Button(onClick = onAdd, enabled = !state.importing) { Text("Add article") }
        }
        if (state.loading || state.importing) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.importing) {
                Text("Importing article…", Modifier.padding(20.dp), style = MaterialTheme.typography.bodyMedium)
            }
        }
        state.libraryError?.let { error ->
            Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                ReaderError(error, Modifier.weight(1f))
                TextButton(onClick = reader::load) { Text("Retry") }
            }
        }
        if (state.articles.isEmpty() && !state.loading && !state.importing) {
            Column(Modifier.padding(horizontal = 24.dp, vertical = 36.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Your reading list", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    "Add a link, paste an article, or share a page to Selected from your browser.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = 20.dp)) {
            items(state.articles, key = { it.id }) { article ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(
                        Modifier.weight(1f).clickable(enabled = !state.importing) { reader.open(article) }
                            .padding(vertical = 14.dp, horizontal = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(article.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        val source = article.sourceLabel()
                        val status = if (article.position != ArticlePosition()) "$source · Resume reading" else source
                        Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconAction(R.drawable.ic_remove, "Remove ${article.title}", { removing = article })
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
    removing?.let { article ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove article?") },
            text = { Text(article.title) },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    reader.delete(article.id)
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ReadingHeader(title: String, back: () -> Unit, trailing: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 8.dp, end = 20.dp, top = 6.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconAction(R.drawable.ic_back, "Back", back)
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        trailing()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddArticleSheet(
    state: ReaderUiState,
    initialUrl: String,
    reader: ReaderViewModel,
    paste: () -> String?,
    dismiss: () -> Unit,
) {
    var linkMode by rememberSaveable(initialUrl) { mutableStateOf(true) }
    var url by rememberSaveable(initialUrl) { mutableStateOf(initialUrl) }
    // Large articles already live in app storage after import. Keep drafts out of the activity Bundle.
    var text by remember { mutableStateOf("") }
    var title by rememberSaveable { mutableStateOf("") }
    var clipboardEmpty by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = { if (!state.importing) dismiss() }, containerColor = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Add article", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            ReadingChoices("Link", "Text", linkMode, enabled = !state.importing) {
                linkMode = it
                clipboardEmpty = false
                reader.clearImportError()
            }
            if (linkMode) {
                OutlinedTextField(
                    url, {
                        url = it.take(4_096)
                        clipboardEmpty = false
                    }, Modifier.fillMaxWidth(),
                    enabled = !state.importing, label = { Text("Article link") },
                    placeholder = { Text("https://example.com/article") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
            } else {
                OutlinedTextField(
                    title, { title = it.take(300) }, Modifier.fillMaxWidth(),
                    enabled = !state.importing, label = { Text("Title (optional)") }, singleLine = true,
                )
                OutlinedTextField(
                    text, {
                        text = it
                        clipboardEmpty = false
                    }, Modifier.fillMaxWidth(),
                    enabled = !state.importing, label = { Text("Article text") }, minLines = 4, maxLines = 8,
                )
            }
            state.importError?.let { ReaderError(it) }
            if (clipboardEmpty) ReaderError("There is no text on the clipboard.")
            if (state.importing) LinearProgressIndicator(Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(enabled = !state.importing, onClick = {
                    val pasted = paste()
                    clipboardEmpty = pasted.isNullOrBlank()
                    if (!pasted.isNullOrBlank()) {
                        if (linkMode) url = (sharedArticleUrl(pasted) ?: pasted).take(4_096) else text = pasted
                    }
                }) { Text("Paste") }
                Button(
                    enabled = !state.importing && if (linkMode) url.isNotBlank() else text.isNotBlank(),
                    onClick = { if (linkMode) reader.importUrl(url) else reader.importText(text, title) },
                ) { Text(if (state.importing) "Importing…" else "Open article") }
            }
        }
    }
}

@Composable
private fun ReadingChoices(first: String, second: String, firstSelected: Boolean, enabled: Boolean = true, change: (Boolean) -> Unit) {
    SingleChoiceSegmentedButtonRow {
        listOf(first, second).forEachIndexed { index, label ->
            SegmentedButton(
                shape = SegmentedButtonDefaults.itemShape(index, 2),
                onClick = { change(index == 0) },
                selected = firstSelected == (index == 0),
                enabled = enabled,
                icon = {},
            ) { Text(label, maxLines = 1) }
        }
    }
}

@Composable
private fun ArticleContent(
    article: ReadingArticle,
    result: ReaderResult?,
    reader: ReaderViewModel,
    speaking: Boolean,
    speak: (String) -> Unit,
    stopSpeech: () -> Unit,
    onSettings: () -> Unit,
    back: () -> Unit,
) {
    var mode by rememberSaveable { mutableStateOf(ArticleSelectionKind.WORD) }
    val list = rememberLazyListState(article.position.index, article.position.offset)
    var tap by remember { mutableStateOf<ReadingTap?>(null) }
    var panelHeight by remember { mutableIntStateOf(0) }
    val lineMargin = with(LocalDensity.current) { 12.dp.toPx() }
    LaunchedEffect(result?.selection, result?.blockIndex, panelHeight) {
        val selection = result ?: return@LaunchedEffect
        val hit = tap?.takeIf { it.selection == selection.selection && it.blockIndex == selection.blockIndex }
            ?: return@LaunchedEffect
        if (panelHeight == 0 || list.isScrollInProgress) return@LaunchedEffect
        val index = hit.blockIndex + 1
        val layout = list.layoutInfo
        val item = layout.visibleItemsInfo.firstOrNull { it.index == index }
        if (item != null) {
            val hiddenBy = item.offset + hit.line.bottom + lineMargin - layout.viewportEndOffset
            if (hiddenBy > 0) list.scrollBy(hiddenBy)
        } else if (index > (layout.visibleItemsInfo.lastOrNull()?.index ?: index)) {
            list.scrollToItem(index, (hit.line.top - lineMargin).toInt().coerceAtLeast(0))
        }
    }
    LaunchedEffect(list) {
        snapshotFlow {
            if (list.isScrollInProgress || list.layoutInfo.totalItemsCount == 0) null
            else ArticlePosition(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset)
        }.filterNotNull().collect { reader.savePosition(article.id, it) }
    }
    DisposableEffect(list) {
        onDispose { reader.savePosition(article.id, ArticlePosition(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset)) }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val resultHeight = maxHeight * 0.48f
        Column(Modifier.fillMaxSize()) {
            ReadingHeader("Reading", back) {
                ReadingChoices("Word", "Sentence", mode == ArticleSelectionKind.WORD) { word ->
                    val newMode = if (word) ArticleSelectionKind.WORD else ArticleSelectionKind.SENTENCE
                    if (newMode != mode) {
                        mode = newMode
                        stopSpeech()
                        reader.dismissResult()
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                state = list,
                contentPadding = PaddingValues(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 36.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item(key = "title") {
                    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Text(article.sourceLabel(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(article.title, style = MaterialTheme.typography.headlineMedium, fontFamily = FontFamily.Serif,
                            fontWeight = FontWeight.SemiBold)
                    }
                }
                itemsIndexed(article.blocks, key = { index, _ -> index }) { index, block ->
                    ArticleParagraph(block, result?.takeIf { it.blockIndex == index }?.selection) { offset, line ->
                        resolveArticleSelection(block.text, offset, mode)?.let {
                            tap = ReadingTap(index, it, line)
                            stopSpeech()
                            reader.select(index, it)
                        }
                    }
                }
            }
            if (result != null) {
                ReaderResultPanel(
                    result, reader, speaking, speak, onSettings, back,
                    Modifier.heightIn(max = resultHeight).onSizeChanged { panelHeight = it.height },
                )
                DisposableEffect(Unit) {
                    onDispose { panelHeight = 0 }
                }
            }
        }
    }
}

@Composable
private fun ArticleParagraph(block: ArticleBlock, selection: ArticleSelection?, onTap: (Int, Rect) -> Unit) {
    val emphasis = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
    val text = remember(block, selection, emphasis) {
        buildAnnotatedString {
            append(block.text)
            if (selection != null) addStyle(SpanStyle(background = emphasis), selection.start, selection.end)
        }
    }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val tap by rememberUpdatedState(onTap)
    Text(
        text,
        Modifier.fillMaxWidth().pointerInput(block.text) {
            detectTapGestures { point ->
                val measured = layout ?: return@detectTapGestures
                val offset = measured.getOffsetForPosition(point)
                val hit = listOf(offset, offset - 1).firstOrNull { index ->
                    index in block.text.indices && !block.text[index].isWhitespace() && measured.getBoundingBox(index).contains(point)
                }
                if (hit != null) tap(hit, measured.getBoundingBox(hit))
            }
        },
        onTextLayout = { layout = it },
        style = if (block.heading) MaterialTheme.typography.titleLarge else MaterialTheme.typography.bodyLarge,
        fontFamily = FontFamily.Serif,
        fontWeight = if (block.heading) FontWeight.SemiBold else FontWeight.Normal,
        fontSize = if (block.heading) 23.sp else 19.sp,
        lineHeight = if (block.heading) 30.sp else 31.sp,
    )
}

private data class ReadingTap(val blockIndex: Int, val selection: ArticleSelection, val line: Rect)

@Composable
private fun ReaderResultPanel(
    result: ReaderResult,
    reader: ReaderViewModel,
    speaking: Boolean,
    speak: (String) -> Unit,
    onSettings: () -> Unit,
    dismiss: () -> Unit,
    modifier: Modifier,
) {
    val selection = result.selection
    val word = selection.kind == ArticleSelectionKind.WORD
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (word) selection.text else "Sentence analysis",
                    Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                IconAction(if (speaking) R.drawable.ic_stop else R.drawable.ic_volume,
                    if (speaking) "Stop reading" else "Read aloud", { speak(selection.text) })
                IconAction(
                    if (result.isSaved) R.drawable.ic_bookmark_filled else R.drawable.ic_bookmark,
                    if (result.isSaved) "Saved" else "Save expression",
                    reader::saveExpression,
                    enabled = !result.isSaved && !result.saveBusy && result.saveText != null,
                )
                IconAction(R.drawable.ic_close, "Close result", dismiss)
            }
            if (result.meaningBusy || result.grammarBusy) LinearProgressIndicator(Modifier.fillMaxWidth())
            key(result.blockIndex, selection) {
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                        .padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (result.meaningBusy) Text("Looking up the word…", style = MaterialTheme.typography.bodyMedium)
                    result.meaning?.let { meaning ->
                        if (meaning.phonetic.isNotBlank()) Text(meaning.phonetic, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(meaning.text, style = MaterialTheme.typography.bodyLarge)
                        if (meaning.contextualAnalysis.isNotBlank()) {
                            Text(meaning.contextualAnalysis, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    result.meaningError?.let { ReaderRetry(it, reader::retryMeaning, onSettings) }
                    if (word && result.grammar == null && !result.grammarBusy && result.grammarError == null) {
                        TextButton(onClick = reader::analyzeSentence, contentPadding = PaddingValues(horizontal = 2.dp)) {
                            Text("Analyze sentence")
                        }
                    }
                    if (result.grammarBusy) Text("Analyzing the sentence…", style = MaterialTheme.typography.bodyMedium)
                    result.grammarError?.let { ReaderRetry(it, reader::retryGrammar, onSettings) }
                    result.grammar?.let { GrammarExplanation(selection.sentence, it) }
                    result.saveError?.let { ReaderError(it) }
                    Spacer(Modifier.height(2.dp))
                }
            }
        }
    }
}

@Composable
private fun GrammarExplanation(sentence: String, analysis: ArticleSentenceAnalysis) {
    val roles = analysis.structure.map { it.role }.distinct()
    val color = MaterialTheme.colorScheme.onSurface
    val marked = remember(sentence, analysis.structure, color) {
        buildAnnotatedString {
            append(sentence)
            analysis.structure.forEach { span ->
                addStyle(SpanStyle(background = grammarColor(span.role), color = color), span.start, span.end)
            }
        }
    }
    Text(marked, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Serif, lineHeight = 25.sp)
    if (roles.isNotEmpty()) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            roles.forEach { role ->
                Surface(color = grammarColor(role), contentColor = color, shape = MaterialTheme.shapes.small) {
                    Text(role.name.lowercase().replaceFirstChar(Char::uppercaseChar), Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
                        style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
    Text(analysis.paraphrase, style = MaterialTheme.typography.bodyLarge)
    analysis.details.forEach { detail ->
        Text(detail.text, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
        Text(detail.explanation, style = MaterialTheme.typography.bodyMedium)
    }
}

private fun grammarColor(role: ArticleGrammarRole): Color = when (role) {
    ArticleGrammarRole.SUBJECT -> Color(0x40689FF8)
    ArticleGrammarRole.VERB -> Color(0x4055B68E)
    ArticleGrammarRole.OBJECT -> Color(0x40E5AD4F)
    ArticleGrammarRole.COMPLEMENT -> Color(0x40B49AE7)
}

@Composable
private fun ReaderRetry(error: String, retry: () -> Unit, settings: () -> Unit) {
    ReaderError(error)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = retry) { Text("Retry") }
        TextButton(onClick = settings) { Text("Model settings") }
    }
}

@Composable
private fun ReaderError(error: String, modifier: Modifier = Modifier) {
    Text(error, modifier, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
}

private fun ReadingArticle.sourceLabel(): String = sourceUrl?.let { runCatching { URI(it).host }.getOrNull() }
    ?.removePrefix("www.") ?: "Pasted article"
