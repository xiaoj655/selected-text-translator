package io.github.selectedtext.translator

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val LightColors = lightColorScheme(
    primary = Color(0xFF215C4E),
    onPrimary = Color.White,
    surface = Color(0xFFFAFAF8),
    onSurface = Color(0xFF1D211E),
    onSurfaceVariant = Color(0xFF535B55),
    surfaceContainer = Color(0xFFF0F1ED),
    outline = Color(0xFF767F77),
    outlineVariant = Color(0xFFDCE0D9),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF9BD3BE),
    onPrimary = Color(0xFF15372D),
    surface = Color(0xFF202321),
    onSurface = Color(0xFFE8EDE8),
    onSurfaceVariant = Color(0xFFC0C9C2),
    surfaceContainer = Color(0xFF2A2E2B),
    outline = Color(0xFF949D95),
    outlineVariant = Color(0xFF414942),
)

@Composable
fun SelectedTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, content = content)
}

@Composable
fun LookupScreen(state: LookupUiState, actions: LookupActions, external: Boolean) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.notice) {
        val notice = state.notice ?: return@LaunchedEffect
        snackbar.showSnackbar(notice)
        actions.clearNotice()
    }
    if (external) {
        Box(Modifier.fillMaxSize()) {
            Box(
                Modifier
                    .matchParentSize()
                    .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = actions::close,
                    )
                    .semantics { contentDescription = "关闭翻译" },
            )
            BoxWithConstraints(
                Modifier
                    .fillMaxSize()
                    .safeDrawingPadding()
                    .imePadding()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                contentAlignment = Alignment.BottomCenter,
            ) {
                val heightLimit = if (state.page == LookupPage.LOOKUP) maxHeight * 0.82f else maxHeight
                LookupPanel(
                    state,
                    actions,
                    external = true,
                    snackbar = snackbar,
                    modifier = Modifier.widthIn(max = 600.dp).fillMaxWidth().heightIn(max = heightLimit),
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
) {
    val title = when (state.page) {
        LookupPage.SETTINGS -> "模型设置"
        LookupPage.SAVED -> "表达本"
        LookupPage.LOOKUP -> if (external) "划词翻译" else "翻译"
    }
    Surface(
        modifier = modifier,
        shape = if (external) RoundedCornerShape(28.dp) else RectangleShape,
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    title,
                    Modifier.weight(1f),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                when {
                    state.page != LookupPage.LOOKUP ->
                        TextButton(onClick = { actions.open(LookupPage.LOOKUP) }) { Text("返回") }

                    external -> TextButton(onClick = actions::close) { Text("关闭") }
                    else -> {
                        TextButton(onClick = { actions.open(LookupPage.SAVED) }) { Text("表达本") }
                        TextButton(onClick = { actions.open(LookupPage.SETTINGS) }) { Text("设置") }
                    }
                }
            }
            val pageModifier = Modifier.weight(1f, fill = !external).fillMaxWidth()
            when (state.page) {
                LookupPage.LOOKUP -> LookupContent(state, actions, external, pageModifier)
                LookupPage.SETTINGS -> ModelSettings(state.config, state.settingsError, actions, pageModifier)
                LookupPage.SAVED -> Expressions(state.saved, actions, pageModifier)
            }
            SnackbarHost(snackbar, Modifier.padding(horizontal = 12.dp))
        }
    }
}

@Composable
private fun LookupContent(
    state: LookupUiState,
    actions: LookupActions,
    external: Boolean,
    modifier: Modifier,
) {
    val result = state.result
    val focus = LocalFocusManager.current
    var visibleHints by rememberSaveable(state.input, state.requestRevision) { mutableStateOf(1) }
    var revealed by rememberSaveable(state.input, state.requestRevision) { mutableStateOf(false) }
    val guideOpen = state.mode == LookupMode.GUIDE
    val canCopyResult = result != null && (!guideOpen || revealed)

    Column(modifier) {
        Column(
            Modifier
                .weight(1f, fill = !external)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (external) {
                ExternalSource(state.input)
            } else {
                OutlinedTextField(
                    value = state.input,
                    onValueChange = actions::input,
                    label = { Text("原文") },
                    placeholder = { Text("输入或粘贴要翻译的文字") },
                    minLines = 3,
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = {
                        focus.clearFocus()
                        actions.paste()
                    }) {
                        Text("粘贴")
                    }
                    Button(
                        onClick = {
                            focus.clearFocus()
                            if (state.configured) {
                                actions.lookup(LookupMode.TRANSLATE)
                            } else {
                                actions.open(LookupPage.SETTINGS)
                            }
                        },
                        modifier = Modifier.weight(1f),
                        enabled = !state.busy && (!state.configured || state.input.isNotBlank()),
                    ) {
                        Text(if (state.configured) "翻译" else "配置模型")
                    }
                }
            }

            if (state.busy) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                if (state.partial.isBlank() || guideOpen) {
                    Text(
                        if (guideOpen) "正在生成线索…" else "正在翻译…",
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
            if (!external) {
                LookupButtons(state, actions, canCopyResult)
            }
        }
        if (external) {
            Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 10.dp)) {
                LookupButtons(state, actions, canCopyResult, external = true)
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
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (overflowed || expanded) {
            TextButton(
                onClick = { expanded = !expanded },
                contentPadding = PaddingValues(horizontal = 0.dp),
            ) {
                Text(if (expanded) "收起原文" else "展开原文")
            }
        }
    }
}

@Composable
private fun TranslationText(text: String, phonetic: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SelectionContainer {
            Text(text, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurface)
        }
        if (phonetic.isNotBlank()) {
            Text(phonetic, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (result.hints.isNotEmpty()) {
            Text("理解线索", style = MaterialTheme.typography.titleMedium)
            for (hint in result.hints.take(visibleHints)) {
                Text(hint, style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (!revealed) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = reveal, modifier = Modifier.weight(1f)) { Text("查看解释") }
                if (visibleHints < result.hints.size) {
                    OutlinedButton(onClick = nextHint, modifier = Modifier.weight(1f)) { Text("再提示一点") }
                }
            }
        } else {
            TranslationText(result.text, result.phonetic)
            if (result.explanation.isNotBlank()) Text(result.explanation, style = MaterialTheme.typography.bodyLarge)
            if (result.example.isNotBlank()) {
                Text(
                    result.example,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyLarge,
                )
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
        Button(
            onClick = { actions.open(LookupPage.SETTINGS) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("配置模型") }
        return
    }

    val result = state.result
    if (external && result == null && !state.busy && state.error == null && state.input.isNotBlank()) {
        Button(
            onClick = { actions.lookup(LookupMode.TRANSLATE) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("翻译") }
    }
    val finished = result != null && !state.busy
    val canRead = state.input.isNotBlank()
    if (finished || state.error != null || canRead) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
    if (finished || state.error != null) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            if (state.error != null && state.configured && state.input.isNotBlank()) {
                TextButton(onClick = { actions.lookup(state.mode) }, enabled = !state.busy) { Text("重试") }
                if (external) {
                    TextButton(onClick = { actions.open(LookupPage.SETTINGS) }) { Text("设置") }
                }
            }
            if (state.mode == LookupMode.GUIDE) {
                TextButton(onClick = { actions.lookup(LookupMode.TRANSLATE) }, enabled = !state.busy) {
                    Text("看译文")
                }
            } else if (finished) {
                TextButton(onClick = {
                    actions.lookup(LookupMode.GUIDE)
                }) {
                    Text("引导理解")
                }
            }
        }
    }
    if (canRead || canCopyResult) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            if (canRead) {
                TextButton(onClick = { actions.speak(state.input) }) {
                    Text(if (state.speaking) "停止朗读" else "朗读原文")
                }
            }
            if (canCopyResult && result != null) {
                TextButton(onClick = { actions.copy(result.text) }) { Text("复制") }
                TextButton(onClick = actions::saveExpression, enabled = !state.isSaved && !state.busy) {
                    Text(if (state.isSaved) "已收藏" else "收藏")
                }
            }
        }
    }
}

@Composable
private fun ModelSettings(
    config: ProviderConfig,
    error: String?,
    actions: LookupActions,
    modifier: Modifier,
) {
    var baseUrl by rememberSaveable(config.baseUrl) { mutableStateOf(config.baseUrl) }
    var apiKey by remember(config.apiKey) { mutableStateOf(config.apiKey) }
    var translationModel by rememberSaveable(config.translationModel) { mutableStateOf(config.translationModel) }
    var learningModel by rememberSaveable(config.learningModel) { mutableStateOf(config.learningModel) }
    val focus = LocalFocusManager.current
    Column(
        modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedTextField(
            baseUrl,
            { baseUrl = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("API 地址") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            apiKey,
            { apiKey = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("API Key") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
            visualTransformation = PasswordVisualTransformation(),
        )
        OutlinedTextField(
            translationModel,
            { translationModel = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("翻译模型") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            learningModel,
            { learningModel = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("引导模型（可选）") },
            supportingText = { Text("使用 qwen-mt 翻译时，引导理解需要另填通用模型。") },
            singleLine = true,
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
            Text("保存设置")
        }
    }
}

@Composable
private fun Expressions(entries: List<SavedExpression>, actions: LookupActions, modifier: Modifier) {
    if (entries.isEmpty()) {
        Text(
            "收藏的词句会显示在这里。",
            modifier.padding(horizontal = 20.dp, vertical = 16.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
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
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { actions.copy(expression.result) }) { Text("复制") }
                    TextButton(onClick = { actions.removeExpression(expression.id) }) { Text("移除") }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}
