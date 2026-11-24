package io.github.selectedtext.translator

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ReadingDiscover(
    state: ReaderUiState,
    reader: ReaderViewModel,
) {
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by rememberSaveable { mutableStateOf(false) }
    var adding by rememberSaveable { mutableStateOf(false) }
    var feedUrl by rememberSaveable { mutableStateOf("") }
    var selectedArticleUrl by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedSource = state.feeds.firstOrNull { it.id == selectedId }
    val articles = state.feedArticles.filter { selectedSource == null || it.sourceId == selectedSource.id }
    val selectedArticle = articles.firstOrNull { it.url == selectedArticleUrl }
    val uriHandler = LocalUriHandler.current

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f)) {
                TextButton(onClick = { menu = true }) {
                    Text(selectedSource?.name ?: "All sources", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("All sources") }, onClick = { selectedId = null; menu = false })
                    state.feeds.forEach { source ->
                        DropdownMenuItem(text = { Text(source.name) }, onClick = { selectedId = source.id; menu = false })
                    }
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text("Add RSS or Atom feed") }, onClick = {
                        reader.clearFeedMessage()
                        adding = true
                        menu = false
                    })
                    if (selectedSource?.custom == true) {
                        DropdownMenuItem(text = { Text("Remove ${selectedSource.name}") }, onClick = {
                            reader.removeFeed(selectedSource.id)
                            selectedId = null
                            menu = false
                        })
                    }
                }
            }
            TextButton(onClick = { reader.refreshFeeds(selectedSource?.id) }, enabled = !state.refreshingFeeds) { Text("Refresh") }
        }
        val errors = state.feedErrors.filterKeys { selectedSource == null || it == selectedSource.id }
        if (errors.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 24.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (errors.size == 1) "${state.feeds.firstOrNull { it.id == errors.keys.first() }?.name ?: "Feed"} couldn't refresh."
                    else "${errors.size} sources couldn't refresh.",
                    Modifier.weight(1f),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = { reader.retryFeeds(errors.keys) }, enabled = !state.refreshingFeeds) { Text("Retry") }
            }
        }
        if (!adding) state.feedMessage?.let {
            Text(it, Modifier.padding(horizontal = 24.dp), color = MaterialTheme.colorScheme.error)
        }
        PullToRefreshBox(
            isRefreshing = state.refreshingFeeds,
            onRefresh = { reader.refreshFeeds(selectedSource?.id) },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(contentPadding = PaddingValues(horizontal = 24.dp, vertical = 4.dp)) {
                if (articles.isEmpty() && !state.refreshingFeeds) {
                    item { Text("No articles available", Modifier.padding(vertical = 24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                items(articles, key = { "${it.sourceId}:${it.url}" }) { article ->
                    val source = state.feeds.firstOrNull { it.id == article.sourceId }
                    Column(
                        Modifier.fillMaxWidth().clickable(enabled = !state.importing) {
                            if (article.hasFullText || state.articles.any { it.sourceUrl == article.url }) {
                                reader.openFeedArticle(article)
                            } else {
                                selectedArticleUrl = article.url
                            }
                        }.padding(vertical = 15.dp),
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Text(
                            listOfNotNull(source?.name, article.publishedLabel()).joinToString(" · "),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(article.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        if (article.excerpt.isNotBlank()) {
                            Text(article.excerpt, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
    }
    if (adding) {
        AlertDialog(
            onDismissRequest = { if (!state.addingFeed) adding = false },
            title = { Text("Add subscription") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(feedUrl, { feedUrl = it.take(4096); reader.clearFeedMessage() },
                        label = { Text("RSS or Atom URL") }, singleLine = true, enabled = !state.addingFeed)
                    state.optionalFeeds.forEach { source ->
                        TextButton(onClick = { feedUrl = source.url; reader.clearFeedMessage() }, enabled = !state.addingFeed) {
                            Text("Use ${source.name}")
                        }
                    }
                    state.feedMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                Button(onClick = {
                    reader.addFeed(feedUrl) { id -> selectedId = id; feedUrl = ""; adding = false }
                }, enabled = feedUrl.isNotBlank() && !state.addingFeed) { Text(if (state.addingFeed) "Adding…" else "Add") }
            },
            dismissButton = { TextButton(onClick = { adding = false; reader.clearFeedMessage() }, enabled = !state.addingFeed) { Text("Cancel") } },
        )
    }
    selectedArticle?.let { article ->
        AlertDialog(
            onDismissRequest = { selectedArticleUrl = null },
            title = { Text(article.title) },
            text = {
                Text(
                    article.excerpt.ifBlank { article.url },
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            confirmButton = {
                Button(onClick = { selectedArticleUrl = null; reader.openFeedArticle(article) }) { Text("Import full article") }
            },
            dismissButton = {
                TextButton(onClick = { selectedArticleUrl = null; runCatching { uriHandler.openUri(article.url) } }) { Text("Open original") }
            },
        )
    }
}
