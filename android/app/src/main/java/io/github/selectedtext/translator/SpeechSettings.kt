package io.github.selectedtext.translator

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp

@Composable
internal fun SpeechSettings(state: LookupUiState, actions: LookupActions, modifier: Modifier) {
    val config = state.speechConfig
    val canReuseModelKey = cloudSpeechApiKey(SpeechConfig(), state.config) != null
    var cloudEnabled by rememberSaveable(config.cloudEnabled) { mutableStateOf(config.cloudEnabled) }
    var voice by rememberSaveable(config.voice) { mutableStateOf(config.voice.takeIf { it in CLOUD_SPEECH_VOICES }) }
    var customVoice by rememberSaveable(config.voice) { mutableStateOf(if (voice == null) config.voice else "") }
    var apiKey by remember(config.apiKey) { mutableStateOf(config.apiKey) }
    var menuOpen by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val enabled = !state.speechSaving
    fun draft() = if (cloudEnabled) config.copy(cloudEnabled = true, voice = voice ?: customVoice, apiKey = apiKey)
        else config.copy(cloudEnabled = false)
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ReadingChoices("System", "Alibaba Cloud", !cloudEnabled, enabled) { systemSelected ->
            val useCloud = !systemSelected
            if (cloudEnabled != useCloud) actions.stopSpeech()
            cloudEnabled = useCloud
            actions.clearSpeechSettingsError()
        }
        if (cloudEnabled) {
            Text("Cloud voice", style = MaterialTheme.typography.labelLarge)
            Box(Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = { menuOpen = true },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = enabled,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(voice ?: "Custom voice ID", Modifier.weight(1f))
                    SelectedIcon(R.drawable.ic_chevron_down, size = 16)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    (CLOUD_SPEECH_VOICES + listOf(null)).forEach { option ->
                        DropdownMenuItem(
                            text = { Text(option ?: "Custom voice ID") },
                            onClick = {
                                if (voice != option) actions.stopSpeech()
                                voice = option
                                menuOpen = false
                                actions.clearSpeechSettingsError()
                            },
                        )
                    }
                }
            }
            if (voice == null) {
                OutlinedTextField(
                    value = customVoice,
                    onValueChange = { customVoice = it; actions.clearSpeechSettingsError() },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = enabled,
                    singleLine = true,
                    label = { Text("Qwen3 voice ID") },
                    shape = MaterialTheme.shapes.small,
                )
            }
            ApiKeyField(
                value = apiKey,
                onValueChange = { apiKey = it; actions.clearSpeechSettingsError() },
                label = if (canReuseModelKey) "Model Studio API key (optional)" else "Model Studio API key",
                enabled = enabled,
                shape = MaterialTheme.shapes.small,
            )
            Text(
                if (canReuseModelKey) "Leave blank to use the Model Studio API key in Models."
                else "Use an Alibaba Cloud Model Studio key for the Beijing region.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        state.speechSettingsError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { focus.clearFocus(); actions.saveSpeechSettings(draft()) }, enabled = enabled) {
                Text(if (enabled) "Save" else "Saving…")
            }
            if (cloudEnabled) {
                OutlinedButton(onClick = { focus.clearFocus(); actions.previewSpeech(draft()) }, enabled = enabled) {
                    Text(if (state.speaking) "Stop preview" else "Preview")
                }
            }
        }
    }
}
