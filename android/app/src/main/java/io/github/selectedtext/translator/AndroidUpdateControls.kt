package io.github.selectedtext.translator

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
internal fun AndroidUpdateControls(
    state: AndroidUpdateState,
    compact: Boolean,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    if (compact) {
        when (state) {
            is AndroidUpdateState.Available,
            is AndroidUpdateState.Downloading,
            is AndroidUpdateState.Ready -> Surface(
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.surfaceContainer,
                shape = MaterialTheme.shapes.medium,
            ) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    UpdateStatus(state, onCheck, onDownload, onInstall)
                }
            }
            else -> Unit
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Text("App updates", style = MaterialTheme.typography.titleSmall)
            UpdateDescription("Current version ${BuildConfig.VERSION_NAME}")
            UpdateStatus(state, onCheck, onDownload, onInstall)
        }
    }
}

@Composable
private fun UpdateStatus(
    state: AndroidUpdateState,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    when (state) {
        AndroidUpdateState.Idle ->
            TextButton(onClick = onCheck) { Text("Check for updates") }
        AndroidUpdateState.Checking ->
            UpdateDescription("Checking for updates…")
        AndroidUpdateState.Current -> {
            UpdateDescription("You’re up to date")
            TextButton(onClick = onCheck) { Text("Check for updates") }
        }
        is AndroidUpdateState.CheckFailed -> {
            UpdateError(state.message)
            TextButton(onClick = onCheck) { Text("Check again") }
        }
        is AndroidUpdateState.Available -> {
            UpdateDescription("New version ${state.update.versionName}")
            state.error?.let { UpdateError(it) }
            TextButton(onClick = onDownload) { Text(if (state.error == null) "Download update" else "Download again") }
        }
        is AndroidUpdateState.Downloading -> {
            UpdateDescription("Downloading ${state.update.versionName}…")
            LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp).height(2.dp))
        }
        is AndroidUpdateState.Ready -> {
            UpdateDescription("${state.update.versionName} downloaded")
            state.error?.let { UpdateError(it) }
            TextButton(onClick = onInstall) { Text("Install update") }
        }
    }
}

@Composable
private fun UpdateDescription(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun UpdateError(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
}
