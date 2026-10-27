package com.terminalbuddy.android.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * 与 `src-tauri/src/models/ai_chat.rs` 一致的原生 AI 会话模型。
 * 字段全部为 camelCase；服务端不返回内部线程、账户归属和请求去重信息。
 */
@Serializable
data class AiMessage(val id: String, val role: String, val text: String, val createdAt: Long = 0)

@Serializable
data class AiApproval(val id: String, val method: String, val details: JsonObject = JsonObject(emptyMap()))

/** 回合进行中排队的消息：当前回合结束后按序自动发送。 */
@Serializable
data class AiPendingInput(val text: String = "", val requestId: String = "")

@Serializable
data class AiSession(
    val id: String, val title: String, val provider: String, val projectPath: String,
    val providerId: String? = null, val providerName: String? = null,
    val model: String? = null, val status: String = "idle", val messages: List<AiMessage> = emptyList(),
    val approvals: List<AiApproval> = emptyList(), val error: String? = null,
    val updatedAt: Long = 0, val revision: Long = 0, val resultRevision: Long = 0,
    val usage: AiUsage? = null,
    val pendingInputs: List<AiPendingInput> = emptyList(),
) {
    /** 服务端仍在该会话执行任务（含等待用户确认）。 */
    val running get() = status == "running" || status == "approval" || status == "background" || status == "stopping"
    /** 回复/等待确认期间发送的消息会排队，回合结束后自动按序发送；中断瞬间禁发防误触。 */
    val canSend get() = status != "stopping"
    /** 排队待发条数，供状态提示展示。 */
    val pendingCount get() = pendingInputs.size
    val statusLabel get() = when (status) {
        "running" -> "正在回复"
        "approval" -> "等待确认"
        "background" -> "后台任务执行中"
        "stopping" -> "正在中断"
        "error" -> "执行失败"
        "interrupted" -> "已中断"
        else -> "可以发送消息"
    }
    val providerLabel get() = when (provider) {
        "codex" -> "Codex"
        "pi" -> "Pi"
        else -> "Claude"
    }
    val modelLabel get() = model?.takeIf(String::isNotBlank) ?: "服务端默认模型"
    val targetLabel get() = listOfNotNull(providerLabel, providerName?.takeIf(String::isNotBlank), modelLabel).joinToString(" · ")
}

/** `/api/projects` 返回的已登记项目，enabledAgents 决定首页可选哪些 Agent。 */
@Serializable
data class AiAgents(val claude: Boolean = true, val codex: Boolean = true, val pi: Boolean = true)

@Serializable
data class AiProject(val name: String, val path: String, val enabledAgents: AiAgents = AiAgents())

@Serializable
data class AiCatalog(val providers: List<AiProvider> = emptyList())

@Serializable
data class AiProvider(
    val id: String, val agent: String, val name: String, val isDefault: Boolean = false,
    val models: List<AiModel> = emptyList(),
) {
    val agentLabel get() = when (agent) {
        "codex" -> "Codex"
        "pi" -> "Pi"
        else -> "Claude"
    }
    val label get() = "$agentLabel · $name"
}

@Serializable
data class AiModel(val id: String, val label: String = "", val effort: String = "") {
    val title get() = label.ifBlank { id.ifBlank { "服务端默认模型" } }
    val effortLabel get() = when (effort.trim().lowercase()) {
        "none" -> "关闭"
        "auto" -> "自动"
        "default" -> "跟随服务端"
        "minimal" -> "极低"
        "low" -> "低"
        "medium" -> "中"
        "high" -> "高"
        "xhigh" -> "很高"
        "max" -> "最高"
        "ultra" -> "极高"
        else -> effort
    }
}

/** 缺失值为 null，和已确认的零消耗区分；输入量已经包含缓存。 */
@Serializable
data class AiTokenUsage(
    val inputTokens: Long? = null, val outputTokens: Long? = null,
    val cacheReadInputTokens: Long? = null, val cacheCreationInputTokens: Long? = null,
    val reasoningOutputTokens: Long? = null,
    val state: String = "", val coverage: String = "",
)

@Serializable
data class AiContextUsage(
    val usedTokens: Long? = null, val windowTokens: Long? = null,
    val basis: String = "", val usedSource: String? = null, val windowSource: String? = null,
    val updating: Boolean = false,
) {
    val percentage: Double?
        get() {
            val used = usedTokens?.takeIf { it >= 0 } ?: return null
            val window = windowTokens?.takeIf { it > 0 } ?: return null
            return if (updating) null else (used.toDouble() / window * 100).takeIf(Double::isFinite)
        }
    val estimated get() = usedSource == "calculated" || windowSource == "configuration"
}

@Serializable
data class AiUsage(
    val context: AiContextUsage? = null, val lastTurn: AiTokenUsage? = null,
    val sessionTotal: AiTokenUsage? = null,
)
