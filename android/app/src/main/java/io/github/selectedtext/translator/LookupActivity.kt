package io.github.selectedtext.translator

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.KeyEvent
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private const val OPEN_ARTICLE = "io.github.selectedtext.translator.OPEN_ARTICLE"

class WorkspaceActivity : LookupActivity(external = false) {
    private val updates: AndroidUpdateViewModel by viewModels()
    private val reader: ReaderViewModel by viewModels()
    private var articlePageTurn: ((Int) -> Unit)? = null
    private val installPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (packageManager.canRequestPackageInstalls()) {
            installDownloadedUpdate()
        } else {
            updates.installationFailed("Allow Selected to install apps to continue.")
        }
    }

    override fun onStart() {
        super.onStart()
        if (!BuildConfig.DEBUG) updates.check(automatic = true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val windowCallback = window.callback
        window.callback = object : Window.Callback by windowCallback {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                val turnPage = articlePageTurn ?: return windowCallback.dispatchKeyEvent(event)
                val direction = when (event.keyCode) {
                    KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_VOLUME_UP -> -1
                    KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_VOLUME_DOWN -> 1
                    else -> return windowCallback.dispatchKeyEvent(event)
                }
                // Android can consume the first Page Up/Down key-down when leaving touch mode.
                if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) turnPage(direction)
                return true
            }
        }
        if (savedInstanceState == null) openSharedArticle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openSharedArticle(intent)
    }

    private fun openSharedArticle(intent: Intent) {
        if (intent.action != OPEN_ARTICLE) return
        val url = intent.dataString?.let(::sharedArticleUrl) ?: return
        openPage(LookupPage.READING)
        reader.importUrl(url, fromShare = true)
    }

    @Composable
    override fun Reading(speaking: Boolean, libraryNavigation: @Composable () -> Unit, libraryRail: @Composable () -> Unit) {
        val state by reader.uiState.collectAsStateWithLifecycle()
        ReaderScreen(
            state, reader, speaking, ::speakOrStop, ::stopSpeech, ::clipboardText,
            onSettings = { openSettings() },
            onReadingSettings = { openSettings(reading = true) },
            setPageTurnHandler = { articlePageTurn = it },
            libraryNavigation = libraryNavigation,
            libraryRail = libraryRail,
        )
    }

    override val hasReadingSettings = true

    @Composable
    override fun ReadingSettings(modifier: Modifier) {
        val state by reader.uiState.collectAsStateWithLifecycle()
        ReadingImportSettings(state, reader, modifier)
    }

    @Composable
    override fun UpdateControls(compact: Boolean) {
        if (BuildConfig.DEBUG) return
        val state by updates.state.collectAsStateWithLifecycle()
        AndroidUpdateControls(
            state,
            compact,
            onCheck = { updates.check() },
            onDownload = updates::download,
            onInstall = ::installDownloadedUpdate,
        )
    }

    private fun installDownloadedUpdate() {
        val ready = updates.state.value as? AndroidUpdateState.Ready ?: return
        if (!ready.apk.isFile) {
            updates.installationFailed("Download the update again to install it.")
            return
        }
        try {
            if (!packageManager.canRequestPackageInstalls()) {
                installPermission.launch(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", packageName, null)),
                )
                return
            }
            val uri = FileProvider.getUriForFile(this, "$packageName.updates", ready.apk)
            startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        } catch (_: ActivityNotFoundException) {
            updates.installationFailed("The Android installer is unavailable.")
        } catch (_: SecurityException) {
            updates.installationFailed("Android blocked Selected from installing the update.")
        } catch (_: IllegalArgumentException) {
            updates.installationFailed("The update file could not be opened. Download it again.")
        }
    }
}

class TextLookupActivity : LookupActivity(external = true)

abstract class LookupActivity(private val external: Boolean) : ComponentActivity() {
    private val model: LookupViewModel by viewModels()
    private val clipboard by lazy { getSystemService(ClipboardManager::class.java) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private var speech: TextToSpeech? = null
    private var speechReady = false
    private var speechRevision = 0
    private var pendingSystemSpeech: Pair<String, Int>? = null
    private var cloudSpeechJob: Job? = null
    private var preferReadingSettings by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (external) {
            enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
            if (savedInstanceState == null) acceptIntent(intent)
        } else {
            enableEdgeToEdge()
        }
        if (isFinishing) return

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (model.state.value.page == LookupPage.LOOKUP) {
                    // Preserve the platform behavior for a launcher Activity at the task root.
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                } else {
                    backPage()
                }
            }
        })

        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            SelectedTheme {
                LookupScreen(
                    state, actions, external,
                    reading = { navigation, rail -> Reading(state.speaking, navigation, rail) },
                    readingSettings = if (hasReadingSettings) ({ modifier -> ReadingSettings(modifier) }) else null,
                    preferReadingSettings = preferReadingSettings,
                ) { compact ->
                    UpdateControls(compact)
                }
            }
        }
    }

    @Composable
    protected open fun UpdateControls(compact: Boolean) = Unit

    @Composable
    protected open fun Reading(speaking: Boolean, libraryNavigation: @Composable () -> Unit, libraryRail: @Composable () -> Unit) = Unit

    protected open val hasReadingSettings = false

    @Composable
    protected open fun ReadingSettings(modifier: Modifier) = Unit

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (external) acceptIntent(intent)
    }

    private fun acceptIntent(intent: Intent) {
        val text = runCatching {
            when (intent.action) {
                Intent.ACTION_PROCESS_TEXT -> intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
                Intent.ACTION_SEND -> intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
                else -> null
            }
        }.getOrNull()
        if (intent.action == Intent.ACTION_SEND) {
            val url = text?.let(::sharedArticleUrl)
            if (url != null) {
                startActivity(
                    Intent(this, WorkspaceActivity::class.java)
                        .setAction(OPEN_ARTICLE)
                        .setData(url.toUri())
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                )
                finish()
                return
            }
        }
        stopSpeech()
        model.useIncoming(text, fromShare = intent.action == Intent.ACTION_SEND)
    }

    protected fun clipboardText(): String? = clipboard?.primaryClip?.let { clip ->
        if (clip.itemCount == 0) null else clip.getItemAt(0).text?.toString()
    }

    protected fun openPage(page: LookupPage) {
        stopSpeech()
        model.open(page)
    }

    protected fun openSettings(reading: Boolean = false) {
        preferReadingSettings = reading
        openPage(LookupPage.SETTINGS)
    }

    protected fun backPage() {
        stopSpeech()
        model.back()
    }

    private val actions = object : LookupActions {
        override fun input(value: String) {
            stopSpeech()
            model.edit(value)
        }

        override fun paste() {
            val text = clipboardText()
            if (text.isNullOrBlank()) {
                model.notice("There is no text on the clipboard.")
                return
            }
            stopSpeech()
            model.useIncoming(text)
        }

        override fun lookup(mode: LookupMode) = model.lookup(mode)

        override fun stopLookup() = model.stopLookup()

        override fun copy(text: String) {
            if (clipboard == null) {
                model.notice("The clipboard is unavailable.")
                return
            }
            clipboard?.setPrimaryClip(ClipData.newPlainText("Selected", text))
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) model.notice("Copied")
        }

        override fun speak(text: String) = speakOrStop(text)

        override fun previewSpeech(config: SpeechConfig) {
            if (model.state.value.speaking) {
                stopSpeech()
                return
            }
            val draft = model.speechDraft(config) ?: return
            readSpeech("This is a sample of the voice you selected.", draft)
        }

        override fun stopSpeech() = this@LookupActivity.stopSpeech()

        override fun saveExpression() = model.saveExpression()

        override fun open(page: LookupPage) {
            if (page == LookupPage.SETTINGS) openSettings() else openPage(page)
        }

        override fun back() = backPage()

        override fun saveSettings(config: ProviderConfig) = model.saveSettings(config)

        override fun saveSpeechSettings(config: SpeechConfig) = model.saveSpeechSettings(config)

        override fun clearSpeechSettingsError() = model.clearSpeechSettingsError()

        override fun testConnection(config: ProviderConfig) = model.testConnection(config)

        override fun clearConnectionTest() = model.clearConnectionTest()

        override fun removeExpression(id: String) = model.removeExpression(id)

        override fun close() = finish()

        override fun clearNotice() = model.notice(null)
    }

    protected fun speakOrStop(text: String) = readSpeech(text)

    private fun readSpeech(text: String, preview: SpeechConfig? = null) {
        if (model.state.value.speaking) {
            stopSpeech()
            return
        }
        val content = text.trim()
        if (content.isEmpty()) return
        val revision = ++speechRevision
        model.setSpeaking(true)
        cloudSpeechJob = lifecycleScope.launch {
            var playbackStarted = false
            val fallback = try {
                val app = application as TranslatorApplication
                app.store.load()
                val config = preview ?: app.store.speechConfig.value
                val key = if (config.cloudEnabled) cloudSpeechApiKey(config, app.store.config.value) else null
                when {
                    !config.cloudEnabled -> null
                    key == null -> "Add a Model Studio API key in Speech settings."
                    content.length > MAX_CLOUD_SPEECH_LENGTH -> "Cloud speech supports up to 600 characters."
                    else -> {
                        val wave = app.cloudSpeech.synthesize(content, config.voice, key)
                        playCloudSpeech(wave) { playbackStarted = true }
                        model.setSpeaking(false)
                        return@launch
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (playbackStarted) {
                    model.setSpeaking(false)
                    model.notice("Unable to read aloud. Try again.")
                    return@launch
                }
                "Cloud speech is unavailable."
            }
            if (fallback != null) {
                if (preview != null) {
                    model.setSpeaking(false)
                    model.notice(fallback)
                    return@launch
                }
                model.notice("$fallback Using a system voice.")
            }
            startSystemSpeech(content, revision)
        }
    }

    private fun startSystemSpeech(text: String, revision: Int) {
        if (speechReady) {
            startSpeech(text, revision)
            return
        }
        pendingSystemSpeech = text to revision
        if (speech != null) return
        speech = TextToSpeech(this) { status ->
            mainHandler.post {
                if (isDestroyed || speech == null) return@post
                speechReady = status == TextToSpeech.SUCCESS
                if (!speechReady) {
                    speech?.shutdown()
                    speech = null
                }
                val (pendingText, pendingRevision) = pendingSystemSpeech ?: return@post
                pendingSystemSpeech = null
                if (speechReady) {
                    startSpeech(pendingText, pendingRevision)
                } else {
                    model.setSpeaking(false)
                    model.notice("Text-to-speech is unavailable.")
                }
            }
        }
    }

    private fun startSpeech(text: String, revision: Int) {
        val engine = speech ?: return
        val locale = if (text.any { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.HAN }) {
            Locale.SIMPLIFIED_CHINESE
        } else {
            Locale.US
        }
        if (engine.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
            model.setSpeaking(false)
            model.notice("A voice for this language is unavailable.")
            return
        }
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) = Unit

            override fun onDone(utteranceId: String) = finishSpeech(utteranceId)

            @Deprecated("Android invokes this on some speech engines")
            override fun onError(utteranceId: String) = finishSpeech(utteranceId, failed = true)

            override fun onError(utteranceId: String, errorCode: Int) = finishSpeech(utteranceId, failed = true)
        })
        val maxLength = TextToSpeech.getMaxSpeechInputLength()
        for ((index, chunk) in text.chunked(maxLength).withIndex()) {
            val finalChunk = (index + 1) * maxLength >= text.length
            val id = if (finalChunk) revision.toString() else "$revision-$index"
            val queue = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            if (engine.speak(chunk, queue, null, id) != TextToSpeech.SUCCESS) {
                stopSpeech()
                model.notice("Unable to read aloud. Try again.")
                return
            }
        }
        model.setSpeaking(true)
    }

    private fun finishSpeech(utteranceId: String, failed: Boolean = false) {
        runOnUiThread {
            if (utteranceId.substringBefore('-') != speechRevision.toString()) return@runOnUiThread
            if (failed) {
                stopSpeech()
                model.notice("Unable to read aloud. Try again.")
            } else if ('-' !in utteranceId) {
                model.setSpeaking(false)
            }
        }
    }

    protected fun stopSpeech() {
        speechRevision += 1
        cloudSpeechJob?.cancel()
        cloudSpeechJob = null
        pendingSystemSpeech = null
        speech?.stop()
        model.setSpeaking(false)
    }

    override fun onStop() {
        super.onStop()
        stopSpeech()
    }

    override fun onDestroy() {
        speech?.shutdown()
        speech = null
        super.onDestroy()
    }
}
