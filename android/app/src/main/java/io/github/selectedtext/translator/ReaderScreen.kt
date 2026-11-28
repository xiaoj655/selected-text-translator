package io.github.selectedtext.translator

import android.content.res.Configuration
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberOverscrollEffect
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import java.net.URI
import kotlinx.coroutines.launch

@Composable
internal fun ReaderScreen(
    state: ReaderUiState,
    reader: ReaderViewModel,
    speaking: Boolean,
    speak: (String) -> Unit,
    stopSpeech: () -> Unit,
    paste: () -> String?,
    onSettings: () -> Unit,
    onReadingSettings: () -> Unit,
    libraryNavigation: @Composable () -> Unit,
    libraryRail: @Composable () -> Unit = {},
) {
    var adding by rememberSaveable { mutableStateOf(false) }
    val article = state.activeArticle
    val libraryState = rememberSaveableStateHolder()
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
        if (state.result != null) reader.dismissResult() else reader.closeArticle()
    }
    if (article == null) {
        Row(Modifier.fillMaxSize()) {
            libraryRail()
            Column(Modifier.weight(1f)) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                    Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
                        libraryState.SaveableStateProvider("reading-library") {
                            ReadingLibrary(state, reader, onReadingSettings) {
                                reader.clearImportError()
                                sharedDraft = ""
                                adding = true
                            }
                        }
                    }
                }
                libraryNavigation()
            }
        }
    } else {
        key(article.id, article.hasImages) {
            ArticleContent(article, state.result, state.fontSize, state.eInkMode, reader, speaking, speak, stopSpeech, onSettings, back,
                state.reloadingArticle, state.articleReloadError)
        }
    }
    if (adding) {
        AddArticleSheet(state, sharedDraft, reader, paste) {
            adding = false
            sharedDraft = ""
            reader.clearImportError()
            reader.editPastedDraft("")
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
    onReadingSettings: () -> Unit,
    onAdd: () -> Unit,
) {
    var removing by remember { mutableStateOf<ReadingArticle?>(null) }
    var discover by rememberSaveable { mutableStateOf(true) }
    val tabState = rememberSaveableStateHolder()
    val emptyLibrary = !discover && state.articles.isEmpty() && !state.loading &&
        !state.importing && state.libraryError == null
    LaunchedEffect(discover) {
        if (discover) reader.loadFeeds()
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, top = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Reading", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold)
            if (!emptyLibrary) AddArticleButton(onAdd, enabled = !state.importing)
            IconAction(R.drawable.ic_settings, "Reading settings", onReadingSettings)
        }
        Box(Modifier.padding(horizontal = 12.dp)) {
            ReadingChoices("Discover", "My articles", discover) { discover = it }
        }
        if (state.loading || state.importing) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.importing) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Importing article…", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = reader::cancelImport) { Text("Cancel") }
                }
            }
        }
        state.libraryError?.let { error ->
            Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                ReaderError(error, Modifier.weight(1f))
                TextButton(onClick = reader::load) { Text("Retry") }
            }
        }
        when {
            discover -> tabState.SaveableStateProvider("discover") { ReadingDiscover(state, reader) }
            emptyLibrary -> Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("No articles yet", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text(
                    "Import a link, paste article text, or share a page from your browser.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AddArticleButton(onAdd)
            }
            else -> tabState.SaveableStateProvider("my-articles") {
                LazyColumn(contentPadding = PaddingValues(horizontal = 24.dp)) {
                    items(state.articles, key = { it.id }) { article ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(
                                Modifier.weight(1f).clickable(enabled = !state.importing) { reader.open(article) }
                                    .padding(vertical = 12.dp),
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
private fun AddArticleButton(onClick: () -> Unit, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Icon(painterResource(R.drawable.ic_add_article), null, Modifier.padding(end = 6.dp).size(16.dp))
        Text("Add article")
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
    val text = state.pastedDraft
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
                        reader.editPastedDraft(it)
                        clipboardEmpty = false
                    }, Modifier.fillMaxWidth(),
                    enabled = !state.importing, label = { Text("Article text") }, minLines = 4, maxLines = 8,
                )
            }
            state.importError?.let { ReaderError(it) }
            if (clipboardEmpty) ReaderError("There is no text on the clipboard.")
            if (state.importing) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            } else if (linkMode && state.directImportAvailable) {
                TextButton(onClick = { reader.importUrl(url, direct = true) }) { Text("Try direct import") }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                if (state.importing) {
                    TextButton(onClick = reader::cancelImport) { Text("Cancel") }
                } else {
                    TextButton(onClick = {
                        val pasted = paste()
                        clipboardEmpty = pasted.isNullOrBlank()
                        if (!pasted.isNullOrBlank()) {
                            if (linkMode) url = (sharedArticleUrl(pasted) ?: pasted).take(4_096) else reader.editPastedDraft(pasted)
                        }
                    }) { Text("Paste") }
                }
                Button(
                    enabled = !state.importing && if (linkMode) url.isNotBlank() else text.isNotBlank(),
                    onClick = { if (linkMode) reader.importUrl(url) else reader.importText(text, title) },
                ) { Text(if (state.importing) "Importing…" else "Open article") }
            }
        }
    }
}

@Composable
internal fun ReadingChoices(first: String, second: String, firstSelected: Boolean, enabled: Boolean = true, change: (Boolean) -> Unit) {
    ChoiceTabs(listOf(first, second), if (firstSelected) 0 else 1, enabled) { change(it == 0) }
}

@Composable
internal fun ChoiceTabs(choices: List<String>, selectedIndex: Int, enabled: Boolean = true, change: (Int) -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.selectableGroup()) {
        choices.forEachIndexed { index, label ->
            val selected = selectedIndex == index
            val color = if (selected) colors.onSurface else colors.onSurfaceVariant
            Box(
                Modifier.heightIn(min = 48.dp).selectable(
                    selected = selected,
                    enabled = enabled,
                    role = Role.Tab,
                    onClick = { change(index) },
                ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    Modifier.background(if (selected) colors.surfaceContainer else Color.Transparent, CircleShape)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.labelLarge,
                    color = if (enabled) color else color.copy(alpha = 0.38f),
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ArticleContent(
    article: ReadingArticle,
    result: ReaderResult?,
    fontSize: Int,
    eInkMode: Boolean,
    reader: ReaderViewModel,
    speaking: Boolean,
    speak: (String) -> Unit,
    stopSpeech: () -> Unit,
    onSettings: () -> Unit,
    back: () -> Unit,
    reloading: Boolean,
    reloadError: String?,
) {
    var mode by rememberSaveable { mutableStateOf(ArticleSelectionKind.WORD) }
    var guided by rememberSaveable { mutableStateOf(false) }
    var phraseAnchor by remember(article.blocks) { mutableStateOf<ReadingTap?>(null) }
    var phrase by remember(article.blocks) { mutableStateOf<ReadingTap?>(null) }
    var optionsOpen by remember { mutableStateOf(false) }
    var tap by remember(article.blocks) { mutableStateOf<ReadingTap?>(null) }
    var panelHeight by remember { mutableIntStateOf(0) }
    val resultScroll = key(result?.blockIndex, result?.selection, result?.guided) { rememberScrollState() }
    var sentenceOpen by rememberSaveable(result?.blockIndex, result?.selection, result?.guided) { mutableStateOf(false) }
    var detailsOpen by rememberSaveable(result?.blockIndex, result?.selection, result?.guided) { mutableStateOf(false) }
    var visibleHints by rememberSaveable(result?.blockIndex, result?.selection, result?.guided) { mutableIntStateOf(1) }
    val lineMargin = with(LocalDensity.current) { 12.dp.toPx() }
    val uriHandler = LocalUriHandler.current
    val typography = MaterialTheme.typography
    val titleStyle = typography.headlineMedium.copy(fontFamily = FontFamily.Serif, fontWeight = FontWeight.SemiBold)
    val sourceStyle = typography.bodySmall
    val bodyStyle = typography.bodyLarge.copy(
        fontFamily = FontFamily.Serif, fontWeight = FontWeight.Normal,
        fontSize = fontSize.sp, lineHeight = (fontSize + 11).sp,
    )
    val headingStyle = typography.titleLarge.copy(
        fontFamily = FontFamily.Serif, fontWeight = FontWeight.SemiBold,
        fontSize = (fontSize + 4).sp, lineHeight = bodyStyle.lineHeight,
    )
    val source = article.sourceLabel()
    fun cancelPhrase() {
        phraseAnchor = null
        phrase = null
    }
    val closeOrBack = {
        if (phraseAnchor != null) cancelPhrase() else back()
    }
    val toggleGuide = {
        result?.let {
            guided = !it.guided
            stopSpeech()
            reader.select(it.blockIndex, it.selection, guided)
        }
        Unit
    }
    BackHandler(onBack = closeOrBack)
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        val sideResult = maxWidth >= 900.dp && LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
        val resultWidth = if (sideResult) (maxWidth * 0.34f).coerceIn(304.dp, 360.dp) else 0.dp
        val bodyWidth = minOf(664.dp, maxWidth - resultWidth)
        val articleHeight = maxHeight
        val resultHeight = minOf(320.dp, articleHeight * 0.42f)
        val bodyWidthPx = with(LocalDensity.current) { bodyWidth.roundToPx() }
        // A taller viewport can temporarily clamp the first visible paragraph near the end.
        // Start each new viewport from the last position reached by scrolling.
        val list = remember(article.blocks, bodyWidthPx, constraints.maxHeight, fontSize) {
            val position = reader.readingPosition(article)
            LazyListState(position.index, position.offset)
        }
        LaunchedEffect(list, result?.selection, result?.blockIndex, panelHeight) {
            val selection = result ?: return@LaunchedEffect
            val hit = tap?.takeIf { it.selection == selection.selection && it.blockIndex == selection.blockIndex }
                ?: return@LaunchedEffect
            if (sideResult || panelHeight == 0 || list.isScrollInProgress) return@LaunchedEffect
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
            var wasScrolling = false
            snapshotFlow { list.isScrollInProgress }.collect { scrolling ->
                if (wasScrolling && !scrolling) {
                    reader.savePosition(article, ArticlePosition(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset))
                }
                wasScrolling = scrolling
            }
        }
        DisposableEffect(list) {
            onDispose {
                if (list.isScrollInProgress) {
                    reader.savePosition(article, ArticlePosition(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset))
                }
            }
        }
        val scrollMetrics = rememberArticleScrollMetrics(
            bodyWidthPx, article.title, source, article.blocks, titleStyle, sourceStyle, bodyStyle, headingStyle,
        )
        Column(Modifier.width(bodyWidth + resultWidth).fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconAction(R.drawable.ic_back, "Back", closeOrBack)
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    ReadingChoices("Word", "Sentence", mode == ArticleSelectionKind.WORD) { word ->
                        val newMode = if (word) ArticleSelectionKind.WORD else ArticleSelectionKind.SENTENCE
                        if (newMode != mode) {
                            mode = newMode
                            cancelPhrase()
                            stopSpeech()
                            reader.dismissResult()
                        }
                    }
                }
                Box {
                    TextButton(onClick = { optionsOpen = true }, contentPadding = PaddingValues(horizontal = 6.dp)) {
                        Text("Aa", style = MaterialTheme.typography.titleMedium)
                    }
                    ArticleOptionsMenu(optionsOpen, eInkMode, articleHeight, onDismissRequest = { optionsOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("E Ink mode") },
                            trailingIcon = { Switch(checked = eInkMode, onCheckedChange = null) },
                            modifier = Modifier.semantics {
                                role = Role.Switch
                                toggleableState = ToggleableState(eInkMode)
                            },
                            onClick = {
                                optionsOpen = false
                                reader.setEInkMode(!eInkMode)
                            },
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        readerFontSizes.forEach { size ->
                            DropdownMenuItem(
                                text = { Text("$size sp", fontWeight = if (size == fontSize) FontWeight.Bold else FontWeight.Normal) },
                                onClick = { reader.changeFontSize(size); optionsOpen = false },
                            )
                        }
                        article.sourceUrl?.let { url ->
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            if (!article.hasImages) {
                                DropdownMenuItem(text = { Text("Reload images") }, enabled = !reloading, onClick = {
                                    optionsOpen = false
                                    stopSpeech()
                                    reader.reloadArticle(article)
                                })
                            }
                            DropdownMenuItem(text = { Text("Reimport article") }, enabled = !reloading, onClick = {
                                optionsOpen = false
                                stopSpeech()
                                reader.reimportArticle(article)
                            })
                            DropdownMenuItem(text = { Text("Open original") }, onClick = {
                                optionsOpen = false
                                runCatching { uriHandler.openUri(url) }
                            })
                        }
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            if (reloading) {
                if (eInkMode) {
                    Text(
                        "Reloading article…",
                        Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
            }
            reloadError?.let { ReaderError(it, Modifier.padding(horizontal = 24.dp, vertical = 8.dp)) }
            Row(Modifier.weight(1f)) {
                Column(Modifier.width(bodyWidth).fillMaxSize()) {
                    LazyColumn(
                        Modifier.weight(1f).fillMaxWidth().articleScrollbar(list, scrollMetrics, eInkMode),
                        state = list,
                        contentPadding = articleContentPadding,
                        verticalArrangement = Arrangement.spacedBy(articleItemSpacing),
                        overscrollEffect = if (eInkMode) null else rememberOverscrollEffect(),
                    ) {
                        item(key = "title") {
                            Column(verticalArrangement = Arrangement.spacedBy(articleTitleSpacing)) {
                                Text(article.title, style = titleStyle)
                                Text(source, style = sourceStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        itemsIndexed(article.blocks, key = { index, _ -> index }) { index, block ->
                            val image = block.image
                            if (image != null) {
                                ArticleImageContent(image, article.sourceUrl, eInkMode)
                                return@itemsIndexed
                            }
                            val paragraphResult = result?.takeIf { it.blockIndex == index }
                            ArticleParagraph(
                                block,
                                phrase?.takeIf { it.blockIndex == index }?.selection ?: paragraphResult?.selection,
                                paragraphResult?.grammar,
                                if (block.heading) headingStyle else bodyStyle,
                                onLongPress = { offset, line ->
                                    resolveArticleSelection(block.text, offset, ArticleSelectionKind.WORD)?.let {
                                        stopSpeech()
                                        reader.dismissResult()
                                        val selection = ReadingTap(index, it, line)
                                        phraseAnchor = selection
                                        phrase = selection
                                    }
                                },
                                onTap = { offset, line ->
                                    val anchor = phraseAnchor
                                    if (anchor != null) {
                                        if (anchor.blockIndex == index) {
                                            resolveArticlePhrase(block.text, anchor.selection, offset)?.let {
                                                phrase = ReadingTap(index, it, line)
                                            }
                                        }
                                    } else {
                                        resolveArticleSelection(block.text, offset, mode)?.let {
                                            tap = ReadingTap(index, it, line)
                                            stopSpeech()
                                            reader.select(index, it, guided)
                                        }
                                    }
                                },
                            )
                        }
                    }
                    if (eInkMode) {
                        val overlap = with(LocalDensity.current) { 2 * bodyStyle.lineHeight.toPx() }
                        ArticleScreenControls(list, overlap) {
                            reader.savePosition(article, ArticlePosition(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset))
                        }
                    }
                    phrase?.let { selection ->
                        Surface(color = MaterialTheme.colorScheme.surfaceContainer, contentColor = MaterialTheme.colorScheme.onSurface) {
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(selection.selection.text, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                                TextButton(onClick = {
                                    tap = selection
                                    cancelPhrase()
                                    reader.select(selection.blockIndex, selection.selection, guided)
                                }) { Text("Look up") }
                                IconAction(R.drawable.ic_close, "Cancel selection", ::cancelPhrase)
                            }
                        }
                    }
                }
                if (sideResult && result != null) {
                    VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    ReaderResultPanel(
                        result, reader, speaking, speak, onSettings, back, Modifier.weight(1f).fillMaxSize(),
                        resultScroll, sentenceOpen, { sentenceOpen = !sentenceOpen },
                        detailsOpen, { detailsOpen = !detailsOpen }, visibleHints, { visibleHints++ }, toggleGuide, side = true,
                    )
                }
            }
            if (!sideResult && result != null) {
                ReaderResultPanel(
                    result, reader, speaking, speak, onSettings, back,
                    Modifier.heightIn(max = resultHeight).onSizeChanged { panelHeight = it.height },
                    resultScroll, sentenceOpen, { sentenceOpen = !sentenceOpen },
                    detailsOpen, { detailsOpen = !detailsOpen }, visibleHints, { visibleHints++ }, toggleGuide, side = false,
                )
                DisposableEffect(Unit) {
                    onDispose { panelHeight = 0 }
                }
            }
        }
    }
}

@Composable
private fun ArticleOptionsMenu(
    expanded: Boolean,
    eInkMode: Boolean,
    articleHeight: Dp,
    onDismissRequest: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (!eInkMode) {
        DropdownMenu(expanded = expanded, onDismissRequest = onDismissRequest, content = content)
    } else if (expanded) {
        Popup(
            popupPositionProvider = ArticleMenuPosition,
            onDismissRequest = onDismissRequest,
            properties = PopupProperties(focusable = true),
        ) {
            Surface(
                shape = MaterialTheme.shapes.extraSmall,
                color = MaterialTheme.colorScheme.surfaceContainer,
                shadowElevation = 3.dp,
            ) {
                Column(
                    Modifier.widthIn(max = 280.dp)
                        .heightIn(max = (articleHeight - 56.dp).coerceAtLeast(1.dp))
                        .verticalScroll(rememberScrollState())
                        .padding(vertical = 8.dp),
                    content = content,
                )
            }
        }
    }
}

private object ArticleMenuPosition : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val x = if (layoutDirection == LayoutDirection.Ltr) anchorBounds.right - popupContentSize.width else anchorBounds.left
        return IntOffset(
            x.coerceIn(0, (windowSize.width - popupContentSize.width).coerceAtLeast(0)),
            anchorBounds.bottom.coerceIn(0, (windowSize.height - popupContentSize.height).coerceAtLeast(0)),
        )
    }
}

@Composable
private fun ArticleScreenControls(list: LazyListState, overlap: Float, savePosition: () -> Unit) {
    val scope = rememberCoroutineScope()
    fun turnPage(direction: Int) {
        scope.launch {
            val height = list.layoutInfo.viewportSize.height
            val distance = (height - overlap).coerceAtLeast(height / 2f)
            if (list.scrollBy(direction * distance) != 0f) savePosition()
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        TextButton(
            onClick = { turnPage(-1) },
            modifier = Modifier.weight(1f),
            enabled = list.canScrollBackward,
        ) { Text("Previous screen") }
        TextButton(
            onClick = { turnPage(1) },
            modifier = Modifier.weight(1f),
            enabled = list.canScrollForward,
        ) { Text("Next screen") }
    }
}

@Composable
private fun ArticleParagraph(
    block: ArticleBlock,
    selection: ArticleSelection?,
    grammar: ArticleSentenceAnalysis?,
    style: TextStyle,
    onLongPress: (Int, Rect) -> Unit,
    onTap: (Int, Rect) -> Unit,
) {
    val emphasis = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
    val text = remember(block, selection, grammar, emphasis) {
        buildAnnotatedString {
            append(block.text)
            if (selection != null) {
                grammar?.structure?.forEach { span ->
                    addStyle(SpanStyle(background = grammarColor(span.role)),
                        selection.sentenceStart + span.start, selection.sentenceStart + span.end)
                }
                val selectionStyle = SpanStyle(
                    textDecoration = TextDecoration.Underline,
                    background = if (grammar?.structure.isNullOrEmpty()) emphasis else Color.Unspecified,
                )
                addStyle(selectionStyle, selection.start, selection.end)
            }
        }
    }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val tap by rememberUpdatedState(onTap)
    val longPress by rememberUpdatedState(onLongPress)
    Text(
        text,
        Modifier.fillMaxWidth().pointerInput(block.text) {
            fun handle(point: androidx.compose.ui.geometry.Offset, action: (Int, Rect) -> Unit) {
                val measured = layout ?: return
                val offset = measured.getOffsetForPosition(point)
                val hit = listOf(offset, offset - 1).firstOrNull { index ->
                    index in block.text.indices && !block.text[index].isWhitespace() &&
                        measured.getBoundingBox(index).contains(point)
                }
                if (hit != null) action(hit, measured.getBoundingBox(hit))
            }
            detectTapGestures(onLongPress = { handle(it, longPress) }, onTap = { handle(it, tap) })
        },
        onTextLayout = { layout = it },
        style = style,
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
    scroll: ScrollState,
    sentenceOpen: Boolean,
    toggleSentence: () -> Unit,
    detailsOpen: Boolean,
    toggleDetails: () -> Unit,
    visibleHints: Int,
    nextHint: () -> Unit,
    toggleGuide: () -> Unit,
    side: Boolean,
) {
    val selection = result.selection
    val directSentence = !result.guided && selection.kind == ArticleSelectionKind.SENTENCE
    val hasMeaning = result.meaning != null || result.meaningError != null
    val canShowSentence = if (result.guided) result.answerRevealed else !directSentence && hasMeaning
    val showSentence = directSentence || (canShowSentence && sentenceOpen)
    val guide = result.guide
    val sentenceStart = remember { BringIntoViewRequester() }
    val latestHint = remember { BringIntoViewRequester() }
    LaunchedEffect(visibleHints) {
        if (result.guided && !result.answerRevealed && visibleHints > 1) latestHint.bringIntoView()
    }
    LaunchedEffect(result.answerRevealed, sentenceOpen) {
        if (!sentenceOpen && !directSentence) scroll.scrollTo(0)
    }
    LaunchedEffect(showSentence, result.grammar, result.grammarError) {
        if (showSentence && !directSentence) sentenceStart.bringIntoView()
    }
    val inset = if (side) 20.dp else 14.dp
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer, contentColor = MaterialTheme.colorScheme.onSurface) {
        Column {
            if (!side) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.padding(start = inset, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (directSentence) "Sentence analysis" else selection.text,
                    Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                TextButton(onClick = toggleGuide, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Text(if (result.guided) "Direct" else "Guide", maxLines = 1)
                }
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
            if (result.meaningBusy || result.guideBusy || (showSentence && result.grammarBusy)) {
                LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
            }
            Column(
                Modifier.weight(1f, fill = side).verticalScroll(scroll)
                    .padding(start = inset, end = inset, top = 2.dp, bottom = 6.dp),
                verticalArrangement = Arrangement.spacedBy(if (side) 8.dp else 6.dp),
            ) {
                if (result.guided) {
                    if (result.guideBusy) Text("Preparing hints…", style = MaterialTheme.typography.bodyMedium)
                    result.guideError?.let { ReaderRetry(it, reader::retryGuide, onSettings) }
                    if (guide != null) {
                        if (result.answerRevealed) {
                            Text(guide.text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                            if (guide.explanation.isNotBlank()) Text(guide.explanation, style = MaterialTheme.typography.bodyMedium)
                            if (guide.example.isNotBlank()) Text(guide.example, style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else {
                            val hints = guide.hints.take(visibleHints)
                            hints.forEachIndexed { index, hint ->
                                Row(
                                    if (index == hints.lastIndex) Modifier.bringIntoViewRequester(latestHint) else Modifier,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text("${index + 1}", style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Text(hint, style = MaterialTheme.typography.bodyLarge)
                                }
                            }
                        }
                    }
                }
                if (result.meaningBusy) Text("Looking up…", style = MaterialTheme.typography.bodyMedium)
                result.meaning?.let { meaning ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(meaning.text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        if (meaning.phonetic.isNotBlank()) {
                            Text(meaning.phonetic, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (meaning.contextualAnalysis.isNotBlank()) {
                            Text(meaning.contextualAnalysis, style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                result.meaningError?.let { ReaderRetry(it, reader::retryMeaning, onSettings) }
                if (showSentence) {
                    if (!directSentence) HorizontalDivider()
                    if (result.grammarBusy) {
                        Text("Analyzing the sentence…", Modifier.bringIntoViewRequester(sentenceStart),
                            style = MaterialTheme.typography.bodyMedium)
                    }
                    result.grammarError?.let {
                        Column(Modifier.bringIntoViewRequester(sentenceStart)) { ReaderRetry(it, reader::retryGrammar, onSettings) }
                    }
                    result.grammar?.let { analysis ->
                        GrammarExplanation(selection.sentence, analysis, detailsOpen, toggleDetails,
                            Modifier.bringIntoViewRequester(sentenceStart))
                    }
                }
                result.saveError?.let { ReaderError(it) }
            }
            if (canShowSentence || (guide != null && !result.answerRevealed)) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = inset),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (canShowSentence) {
                        TextButton(onClick = toggleSentence) { Text(if (sentenceOpen) "Hide sentence" else "Show sentence") }
                    } else if (guide != null) {
                        if (visibleHints < guide.hints.size) {
                            TextButton(onClick = nextHint) { Text("Next hint") }
                        }
                        Button(onClick = reader::revealAnswer) { Text("Reveal answer") }
                    }
                }
            }
        }
    }
}

@Composable
private fun GrammarExplanation(
    sentence: String, analysis: ArticleSentenceAnalysis, detailsOpen: Boolean, toggleDetails: () -> Unit, modifier: Modifier,
) {
    Text(analysis.paraphrase, modifier, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
    if (analysis.details.isNotEmpty()) {
        TextButton(onClick = toggleDetails, contentPadding = PaddingValues(horizontal = 2.dp)) {
            Text(if (detailsOpen) "Hide grammar details" else "Grammar details")
        }
        if (detailsOpen) {
            analysis.details.forEach { detail ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (detail.text.trim() != sentence.trim()) {
                        Text(detail.text, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(detail.explanation, style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
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
