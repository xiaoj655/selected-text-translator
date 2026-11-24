package io.github.selectedtext.translator

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

private const val IQS_KEY_URL = "https://aisearch.aliyun.com/web-parsing?tab=docs&apiTab=scrape"

@Composable
internal fun ReadingImportSettings(state: ReaderUiState, reader: ReaderViewModel, modifier: Modifier) {
    val savedKey by reader.iqsApiKey.collectAsStateWithLifecycle()
    var key by remember(savedKey) { mutableStateOf(savedKey) }
    val uriHandler = LocalUriHandler.current
    val focus = LocalFocusManager.current
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Web import", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        OutlinedTextField(
            value = key,
            onValueChange = { key = it; reader.clearIqsSettingsMessage() },
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.savingIqsKey,
            label = { Text("Alibaba Cloud IQS API key (optional)") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Text(
            "With a key saved, web import sends the article link to Alibaba Cloud. Usage charges may apply.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.iqsSettingsMessage?.let { message ->
            Text(message, color = if (state.iqsSettingsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { focus.clearFocus(); reader.saveIqsKey(key) }, enabled = !state.savingIqsKey) {
                Text("Save")
            }
            TextButton(onClick = { runCatching { uriHandler.openUri(IQS_KEY_URL) } }) { Text("Get IQS key") }
        }
    }
}
