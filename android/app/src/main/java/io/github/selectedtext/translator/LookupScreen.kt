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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
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
    reading: @Composable () -> Unit,
    updateControls: @Composable (compact: Boolean) -> Unit,
) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.notice) {
        val notice = state.notice ?: return@LaunchedEffect
        snackbar.showSnackbar(notice)
        actions.clearNotice()
    }
    if (state.page == LookupPage.READING && !external) {
        Box(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).safeDrawingPadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Box(Modifier.widthIn(max = 640.dp).fillMaxSize()) {
                reading()
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = 16.dp))
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
    updateControls: @Composable (compact: Boolean) -> Unit,
) {
    val title = when (state.page) {
        LookupPage.SETTINGS -> "Model settings"
        LookupPage.SAVED -> "Saved expressions"
        LookupPage.READING -> "Reading"
        LookupPage.LOOKUP -> if (external) "Translate selection" else "Selected"
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
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = if (external) 4.dp else 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (state.page != LookupPage.LOOKUP) {
                    IconAction(R.drawable.ic_back, "Back", actions::back)
                } else {
                    SelectedIcon(R.drawable.ic_selected_mark, size = 25)
                }
                Text(
                    title,
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (state.page == LookupPage.LOOKUP && !external) {
                    TextButton(onClick = { actions.open(LookupPage.READING) }) { Text("Reading") }
                    IconAction(R.drawable.ic_bookmark, "Saved expressions", { actions.open(LookupPage.SAVED) })
                    IconAction(R.drawable.ic_settings, "Settings", { actions.open(LookupPage.SETTINGS) })
                } else if (external) {
                    IconAction(R.drawable.ic_close, "Close", actions::close)
                }
            }
            val pageModifier = Modifier.weight(1f, fill = !external).fillMaxWidth()
            when (state.page) {
                LookupPage.LOOKUP -> LookupContent(state, actions, external, pageModifier) { updateControls(true) }
                LookupPage.SETTINGS -> ModelSettings(state.config, state.settingsError, actions, pageModifier) {
                    updateControls(false)
                }
                LookupPage.SAVED -> Expressions(state.saved, actions, pageModifier)
                LookupPage.READING -> Unit
            }
            SnackbarHost(snackbar, Modifier.padding(horizontal = 16.dp))
        }
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
                .padding(start = 24.dp, end = 24.dp, top = if (external) 8.dp else 24.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(if (external) 16.dp else 20.dp),
        ) {
            if (external) {
                if (state.input.isNotBlank()) ExternalSource(state.input)
            } else {
                Text("Translate", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold)
                updateControls()
                Composer(state, actions)
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

                result != null && guideOpen -> GuideText(
                    result,
                    visibleHints,
                    revealed,
                    nextHint = { visibleHints += 1 },
                    reveal = { revealed = true },
                )

                result != null -> TranslationText(result.text, result.phonetic)
            }
            if (!external) LookupButtons(state, actions, canCopyResult)
        }
        if (external) {
            Box(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 8.dp)) {
                LookupButtons(state, actions, canCopyResult, external = true)
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
    fun submit() {
        focus.clearFocus()
        if (state.configured) actions.lookup(LookupMode.TRANSLATE) else actions.open(LookupPage.SETTINGS)
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
            maxLines = 6,
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
            Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextAction(R.drawable.ic_paste, "Paste", {
                focus.clearFocus()
                actions.paste()
            })
            Spacer(Modifier.weight(1f))
            Button(
                onClick = ::submit,
                enabled = !state.busy && (!state.configured || state.input.isNotBlank()),
                contentPadding = PaddingValues(horizontal = 16.dp),
            ) {
                Text(if (state.configured) "Translate" else "Set up a model")
                Spacer(Modifier.width(6.dp))
                SelectedIcon(R.drawable.ic_arrow_up, size = 16)
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
private fun LookupButtons(
    state: LookupUiState,
    actions: LookupActions,
    canCopyResult: Boolean,
    external: Boolean = false,
) {
    if (external && !state.configured) {
        Button(onClick = { actions.open(LookupPage.SETTINGS) }, modifier = Modifier.fillMaxWidth()) { Text("Set up a model") }
        return
    }

    val result = state.result
    val canRead = state.input.isNotBlank()
    if (external && result == null && !state.busy && state.error == null && canRead) {
        Button(onClick = { actions.lookup(LookupMode.TRANSLATE) }, modifier = Modifier.fillMaxWidth()) { Text("Translate") }
    }
    if (!canRead) return

    Column {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            when {
                state.error != null -> TextButton(onClick = { actions.lookup(state.mode) }, enabled = !state.busy) { Text("Retry") }
                state.mode == LookupMode.GUIDE -> TextButton(
                    onClick = { actions.lookup(LookupMode.TRANSLATE) },
                    enabled = !state.busy,
                ) { Text("Translation") }
                result != null -> TextAction(R.drawable.ic_guide, "Guide", { actions.lookup(LookupMode.GUIDE) })
            }
            Spacer(Modifier.weight(1f))
            if (external && state.error != null) {
                IconAction(R.drawable.ic_settings, "Settings", { actions.open(LookupPage.SETTINGS) })
            }
            IconAction(
                if (state.speaking) R.drawable.ic_stop else R.drawable.ic_volume,
                if (state.speaking) "Stop reading" else "Read aloud",
                { actions.speak(state.input) },
            )
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
    actions: LookupActions,
    modifier: Modifier,
    updateControls: @Composable () -> Unit,
) {
    var baseUrl by rememberSaveable(config.baseUrl) { mutableStateOf(config.baseUrl) }
    var apiKey by remember(config.apiKey) { mutableStateOf(config.apiKey) }
    var translationModel by rememberSaveable(config.translationModel) { mutableStateOf(config.translationModel) }
    var learningModel by rememberSaveable(config.learningModel) { mutableStateOf(config.learningModel) }
    val focus = LocalFocusManager.current
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
            { baseUrl = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("API URL") },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            colors = fieldColors,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            apiKey,
            { apiKey = it },
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
            { translationModel = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Translation model") },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            colors = fieldColors,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            learningModel,
            { learningModel = it },
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
        Button(
            onClick = {
                focus.clearFocus()
                actions.saveSettings(
                    ProviderConfig(baseUrl.trim(), apiKey.trim(), translationModel.trim(), learningModel.trim()),
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Save settings")
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
