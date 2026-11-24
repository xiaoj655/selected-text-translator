package io.github.selectedtext.translator

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale

class WorkspaceActivity : LookupActivity(external = false)

class TextLookupActivity : LookupActivity(external = true)

abstract class LookupActivity(private val external: Boolean) : ComponentActivity() {
    private val model: LookupViewModel by viewModels()
    private val clipboard by lazy { getSystemService(ClipboardManager::class.java) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private var speech: TextToSpeech? = null
    private var speechReady = false
    private var speechRevision = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (external) {
            val barStyle = SystemBarStyle.dark(Color.TRANSPARENT)
            enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)
            if (savedInstanceState == null) acceptIntent(intent)
        } else {
            enableEdgeToEdge()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (model.state.value.page == LookupPage.LOOKUP) {
                    // Preserve the platform behavior for a launcher Activity at the task root.
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                } else {
                    model.open(LookupPage.LOOKUP)
                }
            }
        })

        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            SelectedTheme {
                LookupScreen(state, actions, external)
            }
        }
    }

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
        stopSpeech()
        model.useIncoming(text, fromShare = intent.action == Intent.ACTION_SEND)
    }

    private val actions = object : LookupActions {
        override fun input(value: String) {
            stopSpeech()
            model.edit(value)
        }

        override fun paste() {
            val text = clipboard?.primaryClip?.let { clip ->
                if (clip.itemCount == 0) null else clip.getItemAt(0).text?.toString()
            }
            if (text.isNullOrBlank()) {
                model.notice("剪贴板中没有可粘贴的文字。")
                return
            }
            stopSpeech()
            model.useIncoming(text)
        }

        override fun lookup(mode: LookupMode) = model.lookup(mode)

        override fun copy(text: String) {
            if (clipboard == null) {
                model.notice("当前设备无法访问剪贴板。")
                return
            }
            clipboard?.setPrimaryClip(ClipData.newPlainText("Selected", text))
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) model.notice("已复制")
        }

        override fun speak(text: String) = speakOrStop(text)

        override fun saveExpression() = model.saveExpression()

        override fun open(page: LookupPage) {
            if (page != LookupPage.LOOKUP) stopSpeech()
            model.open(page)
        }

        override fun saveSettings(config: ProviderConfig) = model.saveSettings(config)

        override fun removeExpression(id: String) = model.removeExpression(id)

        override fun close() = finish()

        override fun clearNotice() = model.notice(null)
    }

    private fun speakOrStop(text: String) {
        if (model.state.value.speaking) {
            stopSpeech()
            return
        }
        val revision = ++speechRevision
        if (speech == null) {
            model.setSpeaking(true)
            speech = TextToSpeech(this) { status ->
                mainHandler.post {
                    if (isDestroyed || speech == null) return@post
                    speechReady = status == TextToSpeech.SUCCESS
                    if (!speechReady) {
                        speech?.shutdown()
                        speech = null
                    }
                    if (revision != speechRevision) return@post
                    if (speechReady) {
                        startSpeech(text, revision)
                    } else {
                        model.setSpeaking(false)
                        model.notice("系统语音不可用。")
                    }
                }
            }
        } else if (speechReady) {
            startSpeech(text, revision)
        } else {
            model.notice("语音正在启动，请稍后再试。")
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
            model.notice("系统缺少对应语言的语音。")
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
                model.notice("朗读失败，请重试。")
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
                model.notice("朗读失败，请重试。")
            } else if ('-' !in utteranceId) {
                model.setSpeaking(false)
            }
        }
    }

    private fun stopSpeech() {
        speechRevision += 1
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
