package com.terminalbuddy.android

import com.terminalbuddy.android.data.AiHistoryReplay
import com.terminalbuddy.android.data.AiHistorySession

data class AiHistoryState(
    val expanded: Boolean = false, val loading: Boolean = false, val loaded: Boolean = false,
    val indexing: Boolean = false, val sessions: List<AiHistorySession> = emptyList(),
    val error: String? = null, val selected: AiHistorySession? = null,
    val replay: AiHistoryReplay? = null, val loadingReplay: Boolean = false,
    val replayError: String? = null,
)

/** 项目历史独立于快速开始的项目、助手选择，并按账号随 AiUiState 一起重置。 */
data class AiServerHistoryKey(val agent: String, val projectPath: String)

data class AiServerProjectHistory(
    val expanded: Boolean = false,
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val sessions: List<AiHistorySession> = emptyList(),
    val error: String? = null,
)
