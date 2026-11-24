package io.github.selectedtext.translator

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal sealed interface AndroidUpdateState {
    data object Idle : AndroidUpdateState
    data object Checking : AndroidUpdateState
    data object Current : AndroidUpdateState
    data class CheckFailed(val message: String) : AndroidUpdateState
    data class Available(val update: AndroidUpdate, val error: String? = null) : AndroidUpdateState
    data class Downloading(val update: AndroidUpdate) : AndroidUpdateState
    data class Ready(val update: AndroidUpdate, val apk: File, val error: String? = null) : AndroidUpdateState
}

internal class AndroidUpdateViewModel(application: Application) : AndroidViewModel(application) {
    private val client = AndroidUpdateClient(application)
    private val preferences = application.getSharedPreferences("updates", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow<AndroidUpdateState>(AndroidUpdateState.Idle)
    val state = _state.asStateFlow()

    fun check(automatic: Boolean = false) {
        if (BuildConfig.DEBUG) return
        when (_state.value) {
            AndroidUpdateState.Checking,
            is AndroidUpdateState.Available,
            is AndroidUpdateState.Downloading,
            is AndroidUpdateState.Ready -> return
            else -> Unit
        }
        val now = System.currentTimeMillis()
        val elapsed = now - preferences.getLong(LAST_CURRENT_CHECK, 0L)
        if (automatic && elapsed in 0 until CHECK_INTERVAL) return
        _state.value = AndroidUpdateState.Checking
        viewModelScope.launch {
            _state.value = try {
                val update = client.checkForUpdate()
                if (update == null) {
                    preferences.edit().putLong(LAST_CURRENT_CHECK, now).apply()
                    AndroidUpdateState.Current
                } else {
                    preferences.edit().remove(LAST_CURRENT_CHECK).apply()
                    AndroidUpdateState.Available(update)
                }
            } catch (error: IOException) {
                AndroidUpdateState.CheckFailed(error.message ?: "检查更新失败，请重试。")
            }
        }
    }

    fun download() {
        val available = _state.value as? AndroidUpdateState.Available ?: return
        _state.value = AndroidUpdateState.Downloading(available.update)
        viewModelScope.launch {
            _state.value = try {
                AndroidUpdateState.Ready(available.update, client.download(available.update))
            } catch (error: IOException) {
                available.copy(error = error.message ?: "下载失败，请重试。")
            }
        }
    }

    fun installationFailed(message: String) {
        val ready = _state.value as? AndroidUpdateState.Ready ?: return
        _state.value = if (ready.apk.isFile) {
            ready.copy(error = message)
        } else {
            AndroidUpdateState.Available(ready.update, "安装包已清理，请重新下载。")
        }
    }

    private companion object {
        const val LAST_CURRENT_CHECK = "lastCurrentCheck"
        val CHECK_INTERVAL = TimeUnit.HOURS.toMillis(24)
    }
}
