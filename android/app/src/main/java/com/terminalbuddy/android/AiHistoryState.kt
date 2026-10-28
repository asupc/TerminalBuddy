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
