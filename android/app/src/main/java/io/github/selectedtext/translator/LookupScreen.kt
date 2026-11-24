package io.github.selectedtext.translator

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Shapes
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val LightColors = lightColorScheme(
    primary = Color(0xFF19191C),
    onPrimary = Color.White,
    surface = Color(0xFFFCFCFD),
    onSurface = Color(0xFF19191C),
    onSurfaceVariant = Color(0xFF62626B),
    surfaceContainer = Color(0xFFF1F1F4),
    outline = Color(0xFF777780),
    outlineVariant = Color(0xFFE1E1E7),
    error = Color(0xFFAB2D38),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFF2F2F4),
    onPrimary = Color(0xFF1C1C1F),
    surface = Color(0xFF18181B),
    onSurface = Color(0xFFF4F4F5),
    onSurfaceVariant = Color(0xFFA7A7B0),
    surfaceContainer = Color(0xFF252529),
    outline = Color(0xFF85858F),
    outlineVariant = Color(0xFF37373E),
    error = Color(0xFFFF9AA3),
)

@Composable
fun SelectedTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp)),
        content = content,
    )
}

@Composable
fun LookupScreen(
    state: LookupUiState,
    actions: LookupActions,
    external: Boolean,
    reading: @Composable (navigation: @Composable () -> Unit) -> Unit,
    readingSettings: (@Composable (Modifier) -> Unit)? = null,
    preferReadingSettings: Boolean = false,
    updateControls: @Composable (compact: Boolean) -> Unit,
) {
    val snackbar = remember { SnackbarHostState() }
    val workspaceState = rememberSaveableStateHolder()
    val navigation: @Composable () -> Unit = {
        if (WindowInsets.ime.getBottom(LocalDensity.current) == 0) {
            WorkspaceNavigation(state.page, actions::open)
        }
    }
    LaunchedEffect(state.notice) {
        val notice = state.notice ?: return@LaunchedEffect
        snackbar.showSnackbar(notice)
        actions.clearNotice()
    }
    if (state.page == LookupPage.READING && !external) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Box(Modifier.safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
                Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
                    workspaceState.SaveableStateProvider(LookupPage.READING.name) { reading(navigation) }
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = 16.dp))
                }
            }
        }
        return
    }
    if (external) {
        Box(Modifier.fillMaxSize()) {
            Box(
                Modifier
                    .matchParentSize()
                    .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.40f))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = actions::close,
                    )
                    .semantics { contentDescription = "Close translation" },
            )
            BoxWithConstraints(
                Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(
                        WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
                    )
                    .imePadding(),
                contentAlignment = Alignment.BottomCenter,
            ) {
                val heightLimit = if (state.page == LookupPage.LOOKUP) maxHeight * 0.86f else maxHeight
                LookupPanel(
                    state,
                    actions,
                    external = true,
                    snackbar = snackbar,
                    modifier = Modifier.widthIn(max = 600.dp).fillMaxWidth().heightIn(max = heightLimit),
                    workspaceState = workspaceState,
                    updateControls = {},
                )
            }
        }
    } else {
        Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.surface)
                .safeDrawingPadding()
                .imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            LookupPanel(
                state,
                actions,
                external = false,
                snackbar = snackbar,
                modifier = Modifier.widthIn(max = 640.dp).fillMaxSize(),
                updateControls = updateControls,
                readingSettings = readingSettings,
                preferReadingSettings = preferReadingSettings,
                workspaceState = workspaceState,
                navigation = navigation,
            )
        }
    }
}

@Composable
private fun LookupPanel(
    state: LookupUiState,
    actions: LookupActions,
    external: Boolean,
    snackbar: SnackbarHostState,
    modifier: Modifier,
    workspaceState: SaveableStateHolder,
    updateControls: @Composable (compact: Boolean) -> Unit,
    readingSettings: (@Composable (Modifier) -> Unit)? = null,
    preferReadingSettings: Boolean = false,
    navigation: @Composable () -> Unit = {},
) {
    val rootPage = !external && state.page != LookupPage.SETTINGS
    val title = when (state.page) {
        LookupPage.SETTINGS -> "Settings"
        LookupPage.SAVED -> "Saved expressions"
        LookupPage.READING -> "Reading"
        LookupPage.LOOKUP -> if (external) "Translate selection" else "Translate"
    }
    Surface(
        modifier = modifier,
        shape = if (external) RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp) else RectangleShape,
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            if (external) Modifier.windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
            else Modifier,
        ) {
            Row(
                Modifier.fillMaxWidth().padding(start = if (state.page == LookupPage.SETTINGS) 8.dp else 20.dp, end = 12.dp, top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (state.page == LookupPage.SETTINGS) {
                    IconAction(R.drawable.ic_back, "Back", actions::back)
                } else if (external) {
                    SelectedIcon(R.drawable.ic_selected_mark, size = 25)
                }
                Text(
                    title,
                    Modifier.weight(1f),
                    style = if (rootPage) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (rootPage) {
                    IconAction(R.drawable.ic_settings, "Settings", { actions.open(LookupPage.SETTINGS) })
                } else if (external) {
                    IconAction(R.drawable.ic_close, "Close", actions::close)
                }
            }
            val pageModifier = Modifier.weight(1f, fill = !external).fillMaxWidth()
            when (state.page) {
                LookupPage.LOOKUP -> workspaceState.SaveableStateProvider(LookupPage.LOOKUP.name) {
                    LookupContent(state, actions, external, pageModifier) { updateControls(true) }
                }
                LookupPage.SETTINGS -> Column(pageModifier) {
                    var models by rememberSaveable(preferReadingSettings) { mutableStateOf(!preferReadingSettings) }
                    if (readingSettings != null) {
                        Box(Modifier.padding(horizontal = 24.dp)) {
                            ReadingChoices("Models", "Reading", models) { models = it }
                        }
                    }
                    if (models || readingSettings == null) {
                        ModelSettings(state.config, state.settingsError, state.connectionTest, actions, Modifier.weight(1f)) {
                            updateControls(false)
                        }
                    } else {
                        readingSettings(Modifier.weight(1f))
                    }
                }
                LookupPage.SAVED -> workspaceState.SaveableStateProvider(LookupPage.SAVED.name) {
                    Expressions(state.saved, actions, pageModifier)
                }
                LookupPage.READING -> Unit
            }
            SnackbarHost(snackbar, Modifier.padding(horizontal = 16.dp))
            if (rootPage) navigation()
        }
    }
}

@Composable
private fun WorkspaceNavigation(currentPage: LookupPage, open: (LookupPage) -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column {
        HorizontalDivider(color = colors.outlineVariant)
        Row(Modifier.fillMaxWidth().selectableGroup().padding(horizontal = 8.dp)) {
            WorkspaceDestination(LookupPage.LOOKUP, "Translate", R.drawable.ic_selected_mark, currentPage, open, Modifier.weight(1f))
            WorkspaceDestination(LookupPage.READING, "Reading", R.drawable.ic_reading, currentPage, open, Modifier.weight(1f))
            WorkspaceDestination(LookupPage.SAVED, "Saved", R.drawable.ic_bookmark, currentPage, open, Modifier.weight(1f))
        }
    }
}

@Composable
private fun WorkspaceDestination(
    page: LookupPage,
    label: String,
    @DrawableRes icon: Int,
    currentPage: LookupPage,
    open: (LookupPage) -> Unit,
    modifier: Modifier,
) {
    val selected = page == currentPage
    val colors = MaterialTheme.colorScheme
    val color = if (selected) colors.onSurface else colors.onSurfaceVariant
    Column(
        modifier.selectable(selected, role = Role.Tab) { if (!selected) open(page) }
            .heightIn(min = 58.dp).padding(vertical = 5.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
    ) {
        Box(
            Modifier.size(width = 52.dp, height = 27.dp)
                .background(if (selected) colors.surfaceContainer else Color.Transparent, RoundedCornerShape(16.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(21.dp), tint = color)
        }
        Text(label, color = color, style = MaterialTheme.typography.labelMedium,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
    }
}

@Composable
private fun LookupContent(
    state: LookupUiState,
    actions: LookupActions,
    external: Boolean,
    modifier: Modifier,
    updateControls: @Composable () -> Unit,
) {
    val result = state.result
    var visibleHints by rememberSaveable(state.input, state.requestRevision) { mutableIntStateOf(1) }
    var revealed by rememberSaveable(state.input, state.requestRevision) { mutableStateOf(false) }
    val guideOpen = state.mode == LookupMode.GUIDE
    val canCopyResult = result != null && (!guideOpen || revealed)

    Column(modifier) {
        Column(
            Modifier
                .weight(1f, fill = !external)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(if (external) 12.dp else 14.dp),
        ) {
            if (external) {
                if (state.input.isNotBlank()) ExternalSource(state.input)
            } else {
                updateControls()
                Composer(state, actions)
                if (state.input.isNotBlank()) WorkspaceResultBar(state, actions, canCopyResult)
            }

            if (state.busy) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().height(2.dp),
                    trackColor = MaterialTheme.colorScheme.surfaceContainer,
                )
                if (state.partial.isBlank() || guideOpen) {
                    Text(
                        if (guideOpen) "Preparing hints…" else "Translating…",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            state.error?.let { error ->
                Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            when {
                !guideOpen && state.partial.isNotBlank() && result == null ->
                    TranslationText(state.partial, "")

                result != null && guideOpen && result.parts.isNotEmpty() -> {
                    result.parts.forEachIndexed { index, part ->
                        key(state.requestRevision, index) {
                            var partHints by rememberSaveable { mutableIntStateOf(1) }
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                                ExternalSource(part.source)
                                GuideText(part.result, partHints, revealed, { partHints++ }, { revealed = true })
                            }
                        }
                    }
                }

                result != null && guideOpen -> GuideText(
                    result,
                    visibleHints,
                    revealed,
                    nextHint = { visibleHints += 1 },
                    reveal = { revealed = true },
                )

                result != null -> TranslationText(result.text, result.phonetic)
            }
        }
        if (external) {
            Box(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 8.dp)) {
                ExternalLookupButtons(state, actions, canCopyResult)
            }
        }
    }
}

@Composable
private fun Composer(state: LookupUiState, actions: LookupActions) {
    val focus = LocalFocusManager.current
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(20.dp)
    val inputStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface)
    var focused by remember { mutableStateOf(false) }
    fun submit(mode: LookupMode) {
        focus.clearFocus()
        if (state.configured) actions.lookup(mode) else actions.open(LookupPage.SETTINGS)
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.surfaceContainer, shape)
            .border(1.dp, if (focused) colors.outline else colors.outlineVariant, shape),
    ) {
        BasicTextField(
            value = state.input,
            onValueChange = actions::input,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 12.dp)
                .onFocusChanged { focused = it.isFocused }
                .semantics { contentDescription = "Source text" },
            textStyle = inputStyle,
            cursorBrush = SolidColor(colors.primary),
            minLines = 3,
            maxLines = 5,
            decorationBox = { field ->
                Box {
                    if (state.input.isEmpty()) {
                        Text("Type or paste text to translate", style = inputStyle, color = colors.onSurfaceVariant)
                    }
                    field()
                }
            },
        )
        Row(
            Modifier.fillMaxWidth().padding(start = 6.dp, end = 8.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextAction(R.drawable.ic_paste, "Paste", {
                focus.clearFocus()
                actions.paste()
            })
            Spacer(Modifier.weight(1f))
            if (state.configured) {
                TextButton(
                    onClick = { submit(LookupMode.GUIDE) },
                    enabled = state.input.isNotBlank() && !state.busy,
                    contentPadding = PaddingValues(horizontal = 12.dp),
                ) {
                    Text("Guide")
                }
            }
            Button(
                onClick = { if (state.busy) actions.stopLookup() else submit(LookupMode.TRANSLATE) },
                enabled = state.busy || !state.configured || state.input.isNotBlank(),
                contentPadding = PaddingValues(horizontal = 16.dp),
            ) {
                Text(if (state.busy) "Stop" else if (state.configured) "Translate" else "Set up a model")
            }
        }
    }
}

@Composable
private fun ExternalSource(source: String) {
    var expanded by rememberSaveable(source) { mutableStateOf(false) }
    var overflowed by remember(source) { mutableStateOf(false) }
    Column {
        SelectionContainer {
            Text(
                source,
                maxLines = if (expanded) Int.MAX_VALUE else 3,
                overflow = TextOverflow.Ellipsis,
                onTextLayout = { if (!expanded) overflowed = it.hasVisualOverflow },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        if (overflowed || expanded) {
            TextButton(
                onClick = { expanded = !expanded },
                contentPadding = PaddingValues(horizontal = 0.dp),
            ) {
                Text(if (expanded) "Show less" else "Show full text")
            }
        }
    }
}

@Composable
private fun TranslationText(text: String, phonetic: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SelectionContainer {
            Text(text, style = MaterialTheme.typography.headlineSmall.copy(lineHeight = 34.sp), fontWeight = FontWeight.Medium)
        }
        if (phonetic.isNotBlank()) {
            Text(phonetic, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun GuideText(
    result: LookupResult,
    visibleHints: Int,
    revealed: Boolean,
    nextHint: () -> Unit,
    reveal: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (result.hints.isNotEmpty()) {
            Text("Hints", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            for (hint in result.hints.take(visibleHints)) {
                Text(hint, style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (!revealed) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (visibleHints < result.hints.size) {
                    OutlinedButton(onClick = nextHint, modifier = Modifier.weight(1f)) { Text("Next hint") }
                }
                Button(onClick = reveal, modifier = Modifier.weight(1f)) { Text("Show explanation") }
            }
        } else {
            TranslationText(result.text, result.phonetic)
            if (result.explanation.isNotBlank()) Text(result.explanation, style = MaterialTheme.typography.bodyLarge)
            if (result.example.isNotBlank()) {
                Text(result.example, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

@Composable
private fun WorkspaceResultBar(state: LookupUiState, actions: LookupActions, canCopyResult: Boolean) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            if (state.error != null && state.configured) {
                TextButton(onClick = { actions.lookup(state.mode) }, enabled = !state.busy) { Text("Retry") }
            } else if (state.result != null || state.partial.isNotBlank()) {
                Text(
                    if (state.mode == LookupMode.GUIDE) "Guided explanation" else "Translation",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
        LookupResultActions(state, actions, canCopyResult)
    }
}

@Composable
private fun ExternalLookupButtons(
    state: LookupUiState,
    actions: LookupActions,
    canCopyResult: Boolean,
) {
    if (!state.configured) {
        Button(onClick = { actions.open(LookupPage.SETTINGS) }, modifier = Modifier.fillMaxWidth()) { Text("Set up a model") }
        return
    }

    val result = state.result
    val canRead = state.input.isNotBlank()
    if (result == null && !state.busy && state.error == null && canRead) {
        Button(onClick = { actions.lookup(LookupMode.TRANSLATE) }, modifier = Modifier.fillMaxWidth()) { Text("Translate") }
    }
    if (!canRead) return

    Column {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            when {
                state.busy -> TextButton(onClick = actions::stopLookup) { Text("Stop") }
                state.error != null -> TextButton(onClick = { actions.lookup(state.mode) }, enabled = !state.busy) { Text("Retry") }
                state.mode == LookupMode.GUIDE -> TextButton(
                    onClick = { actions.lookup(LookupMode.TRANSLATE) },
                    enabled = !state.busy,
                ) { Text("Translation") }
                result != null -> TextAction(R.drawable.ic_guide, "Guide", { actions.lookup(LookupMode.GUIDE) })
            }
            Spacer(Modifier.weight(1f))
            if (state.error != null) {
                IconAction(R.drawable.ic_settings, "Settings", { actions.open(LookupPage.SETTINGS) })
            }
            LookupResultActions(state, actions, canCopyResult)
        }
    }
}

@Composable
private fun LookupResultActions(state: LookupUiState, actions: LookupActions, canCopyResult: Boolean) {
    IconAction(
        if (state.speaking) R.drawable.ic_stop else R.drawable.ic_volume,
        if (state.speaking) "Stop reading" else "Read aloud",
        { actions.speak(state.input) },
    )
    val result = state.result
    if (canCopyResult && result != null) {
        IconAction(R.drawable.ic_copy, "Copy", { actions.copy(result.text) })
        IconAction(
            if (state.isSaved) R.drawable.ic_bookmark_filled else R.drawable.ic_bookmark,
            if (state.isSaved) "Saved" else "Save",
            actions::saveExpression,
            enabled = !state.isSaved && !state.busy,
        )
    }
}

@Composable
private fun SelectedIcon(@DrawableRes icon: Int, label: String? = null, size: Int = 20) {
    Icon(painterResource(icon), contentDescription = label, modifier = Modifier.size(size.dp))
}

@Composable
internal fun IconAction(@DrawableRes icon: Int, label: String, onClick: () -> Unit, enabled: Boolean = true) {
    IconButton(onClick, enabled = enabled, modifier = Modifier.size(48.dp)) {
        SelectedIcon(icon, label)
    }
}

@Composable
private fun TextAction(@DrawableRes icon: Int, label: String, onClick: () -> Unit) {
    TextButton(onClick, contentPadding = PaddingValues(horizontal = 10.dp)) {
        SelectedIcon(icon, size = 18)
        Spacer(Modifier.width(6.dp))
        Text(label)
    }
}

@Composable
private fun ModelSettings(
    config: ProviderConfig,
    error: String?,
    connectionTest: ModelConnectionTest?,
    actions: LookupActions,
    modifier: Modifier,
    updateControls: @Composable () -> Unit,
) {
    var baseUrl by rememberSaveable(config.baseUrl) { mutableStateOf(config.baseUrl) }
    var apiKey by remember(config.apiKey) { mutableStateOf(config.apiKey) }
    var translationModel by rememberSaveable(config.translationModel) { mutableStateOf(config.translationModel) }
    var learningModel by rememberSaveable(config.learningModel) { mutableStateOf(config.learningModel) }
    val focus = LocalFocusManager.current
    fun draft() = ProviderConfig(baseUrl.trim(), apiKey.trim(), translationModel.trim(), learningModel.trim())
    val fieldColors = OutlinedTextFieldDefaults.colors(
        unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
    )
    Column(
        modifier.verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedTextField(
            baseUrl,
            { baseUrl = it; actions.clearConnectionTest() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("API URL") },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            colors = fieldColors,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            apiKey,
            { apiKey = it; actions.clearConnectionTest() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("API Key") },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            colors = fieldColors,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
            visualTransformation = PasswordVisualTransformation(),
        )
        OutlinedTextField(
            translationModel,
            { translationModel = it; actions.clearConnectionTest() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Translation model") },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            colors = fieldColors,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            learningModel,
            { learningModel = it; actions.clearConnectionTest() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Learning model (optional)") },
            supportingText = { Text("Reading and guided explanations use a general-purpose model.") },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            colors = fieldColors,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        )
        if (error != null) {
            Text(error, color = MaterialTheme.colorScheme.error)
        }
        if (connectionTest?.busy == true) LinearProgressIndicator(Modifier.fillMaxWidth())
        connectionTest?.message?.let {
            Text(it, color = if (connectionTest.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Button(onClick = { focus.clearFocus(); actions.saveSettings(draft()) }) { Text("Save") }
            OutlinedButton(
                onClick = { focus.clearFocus(); actions.testConnection(draft()) },
                enabled = connectionTest?.busy != true,
            ) { Text(if (connectionTest?.busy == true) "Testing…" else "Test connection") }
            if (learningModel != ProviderConfig().learningModel) {
                TextButton(onClick = { learningModel = ProviderConfig().learningModel; actions.clearConnectionTest() }) {
                    Text("Use default learning model")
                }
            }
        }
        updateControls()
    }
}

@Composable
private fun Expressions(entries: List<SavedExpression>, actions: LookupActions, modifier: Modifier) {
    if (entries.isEmpty()) {
        Text(
            "Words and phrases you save will appear here.",
            modifier.padding(horizontal = 24.dp, vertical = 16.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(entries, key = { it.id }) { expression ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SelectionContainer {
                    Text(expression.source, style = MaterialTheme.typography.titleMedium)
                }
                SelectionContainer {
                    Text(expression.result, style = MaterialTheme.typography.bodyLarge)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    IconAction(R.drawable.ic_copy, "Copy", { actions.copy(expression.result) })
                    IconAction(R.drawable.ic_remove, "Remove", { actions.removeExpression(expression.id) })
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}
