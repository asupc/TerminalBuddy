package com.terminalbuddy.android.data

import kotlinx.serialization.Serializable

/** 与服务端 SessionHistoryItem / SessionReplayPage 共用 camelCase 协议。 */
@Serializable
data class AiHistorySession(
    val sessionId: String, val projectDir: String, val title: String,
    val customTitle: String? = null, val startedAt: Long? = null, val updatedAt: Long = 0,
    val messageCount: Long = 0, val model: String? = null,
    val starred: Boolean = false, val archived: Boolean = false,
) {
    val displayTitle get() = customTitle?.takeIf(String::isNotBlank) ?: title.takeIf(String::isNotBlank) ?: "未命名会话"
}

@Serializable
data class AiHistoryTool(val name: String, val summary: String = "")

@Serializable
data class AiHistoryMessage(
    val seq: Long, val role: String, val text: String = "", val timestamp: Long? = null,
    val tools: List<AiHistoryTool> = emptyList(), val toolName: String? = null,
)

@Serializable
data class AiHistoryReplay(
    val total: Long, val messages: List<AiHistoryMessage> = emptyList(),
    val title: String, val projectDir: String, val model: String? = null,
    val inputTokens: Long = 0, val outputTokens: Long = 0,
    val startedAt: Long? = null, val updatedAt: Long = 0,
)

@Serializable
data class AiHistoryScan(val pending: Long = 0)

/** Windows 路径忽略大小写，Linux 路径保持大小写；目录边界必须完整匹配。 */
internal fun historyProject(projects: List<AiProject>, path: String): AiProject? {
    fun key(value: String): String {
        val converted = value.replace('\\', '/')
        val normalPath = when {
            converted.startsWith("//?/UNC/", ignoreCase = true) -> "//" + converted.substring(8)
            converted.startsWith("//?/") -> converted.substring(4)
            else -> converted
        }
        val normalized = normalPath.trimEnd('/').ifEmpty { if (normalPath.startsWith('/')) "/" else "" }
        return if ((normalized.length > 1 && normalized[1] == ':') || normalized.startsWith("//"))
            normalized.lowercase(java.util.Locale.ROOT) else normalized
    }
    val target = key(path)
    return projects.filter {
        val base = key(it.path)
        base.isNotEmpty() && (target == base || target.startsWith(if (base == "/") "/" else "$base/"))
    }.maxByOrNull { key(it.path).length }
}
