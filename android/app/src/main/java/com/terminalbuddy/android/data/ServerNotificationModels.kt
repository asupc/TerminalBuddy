package com.terminalbuddy.android.data

import kotlinx.serialization.Serializable

/** 服务端任务通知事件：与 `AppNotificationEvent` 保持一致。 */
@Serializable
data class ServerNotificationEvent(
    val id: String, val kind: String,
    val terminalId: String = "", val terminalName: String = "",
    val provider: String? = null, val title: String = "", val summary: String = "",
    val decisionId: String? = null,
    val questions: List<ServerDecisionQuestion> = emptyList(),
    val expiresAt: Long? = null, val occurredAt: Long = 0,
) {
    val isDecision get() = kind == "decision"
    val isResolved get() = kind == "resolved"
    val isResult get() = kind == "completed" || kind == "failed"
}

@Serializable
data class ServerDecisionQuestion(
    val question: String, val header: String = "",
    val options: List<ServerDecisionOption> = emptyList(),
    val multiSelect: Boolean = false,
)

@Serializable
data class ServerDecisionOption(
    val label: String, val description: String? = null,
)

/** `/ws/notifications` 的一帧：快照用于重连补齐，Event 为实时事件。 */
internal sealed class ServerNotificationFrame {
    data class Snapshot(val decisions: List<ServerNotificationEvent>) : ServerNotificationFrame()
    data class Event(val event: ServerNotificationEvent) : ServerNotificationFrame()
    data object Heartbeat : ServerNotificationFrame()
}
