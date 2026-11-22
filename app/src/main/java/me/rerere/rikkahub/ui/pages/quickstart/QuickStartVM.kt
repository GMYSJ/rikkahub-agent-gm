package me.rerere.rikkahub.ui.pages.quickstart

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import me.rerere.ai.provider.Model
import me.rerere.rikkahub.data.datastore.Settings
import me.rerere.rikkahub.data.datastore.SettingsStore
import me.rerere.rikkahub.data.datastore.findModelById
import me.rerere.rikkahub.data.sync.importer.DeepSeekImportResult
import me.rerere.rikkahub.data.sync.importer.DeepSeekMigrator
import me.rerere.rikkahub.utils.UiState

/**
 * 快速入门页 VM（迁移自官方 3.3.1，简化版）。
 * DeepSeek 导入相关逻辑依赖官方 3.x 的 Conversation.config 数据模型改造，
 * 本阶段暂不迁移，仅保留通用配置引导能力。
 */
class QuickStartVM(
    private val settingsStore: SettingsStore,
    private val deepSeekMigrator: DeepSeekMigrator,
) : ViewModel() {
    // 和 SettingVM 一样直接取内存里的当前值，避免第一帧闪成默认设置
    val settings: StateFlow<Settings> = settingsStore.settingsFlow
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.Lazily,
            initialValue = settingsStore.settingsFlow.value.takeUnless { it.init }
                ?: Settings(init = true, providers = emptyList()),
        )

    private val _deepSeekImport = MutableStateFlow<UiState<DeepSeekImportResult>>(UiState.Idle)
    val deepSeekImport: kotlinx.coroutines.flow.StateFlow<UiState<DeepSeekImportResult>> = _deepSeekImport

    /** 从 DeepSeek 导出的 ZIP 导入聊天记录（官方 3.3.0 功能） */
    fun importDeepSeek(uri: Uri) {
        if (_deepSeekImport.value is UiState.Loading) return
        _deepSeekImport.value = UiState.Loading
        viewModelScope.launch {
            _deepSeekImport.value = runCatching { deepSeekMigrator.import(uri) }
                .fold(onSuccess = { UiState.Success(it) }, onFailure = { UiState.Error(it) })
        }
    }

    /**
     * 设置默认聊天模型。快速模型和翻译模型还没有可用的模型时一并设成它，
     * 否则新用户的标题生成、聊天建议和翻译会因为没有模型而用不了。
     */
    fun setDefaultChatModel(model: Model) {
        viewModelScope.launch {
            settingsStore.update { latest ->
                latest.copy(
                    chatModelId = model.id,
                    fastModelId = latest.fastModelId.takeIf { latest.findModelById(it) != null } ?: model.id,
                    translateModeId = latest.translateModeId.takeIf { latest.findModelById(it) != null } ?: model.id,
                )
            }
        }
    }
}
