package com.terminalbuddy.android.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * 与 `src-tauri/src/models/ai_chat.rs` 一致的原生 AI 会话模型。
 * 字段全部为 camelCase；服务端不返回内部线程、账户归属和请求去重信息。
 */
@Serializable
data class AiMessage(
    val id: String, val role: String, val text: String, val createdAt: Long = 0,
    /** 用户消息附带的图片：服务端落盘后只返回路径与元数据。 */
    val images: List<AiChatImage> = emptyList(),
)

/** 服务端已落盘的聊天图片；本地待发送预览用 `data:` URL 装在 path 里。 */
@Serializable
data class AiChatImage(
    val path: String = "",
    val mediaType: String = "image/png",
    val name: String = "",
)

/** 发送给服务端的图片：base64 正文，服务端校验后落盘并转换为 [AiChatImage]。 */
@Serializable
data class AiSendImage(val data: String, val mediaType: String, val name: String)

/** 输入框上方待发送的图片：data 是交给服务端的 base64，dataUrl 按需拼接避免双份大字符串常驻内存。 */
data class AiDraftImage(
    val id: String, val data: String, val mediaType: String, val name: String,
) {
    val dataUrl: String get() = "data:$mediaType;base64,$data"
}

@Serializable
data class AiApproval(val id: String, val method: String, val details: JsonObject = JsonObject(emptyMap()))

/** 回合进行中排队的消息：当前回合结束后按序自动发送。 */
@Serializable
data class AiPendingInput(
    val text: String = "", val requestId: String = "",
    /** 排队期间保留图片附件，出队时与文本一起交给 CLI。 */
    val images: List<AiChatImage> = emptyList(),
)

/** `/` 补全清单，来自 CLI 的 `system/init`；Codex 没有该机制，字段为 null。 */
@Serializable
data class AiSlashCatalog(
    val skills: List<String> = emptyList(), val slashCommands: List<String> = emptyList(),
    val terminalSlashCommands: List<String> = emptyList(),
)

/** 一条斜杠命令候选；Skill 与内建命令分组展示。 */
data class AiSlashItem(val name: String, val isSkill: Boolean)

/**
 * 输入框文本转候选：只认「以 / 或全角 ／ 开头且尚未写入空格」的草稿。
 * - 原生对话默认排除纯 TUI 命令（doctor / color 等）；终端接力会话可通过 [includeTerminalCommands] 放行。
 * - 合并 `slashCommands` 与 `skills`，避免只出现在 `skills` 里的技能被漏掉。
 * - 前缀命中优先，其次包含命中（如 `/review` 可匹配 `code-review`）。
 */
fun slashCompletions(
    catalog: AiSlashCatalog?,
    draft: String,
    limit: Int = 12,
    includeTerminalCommands: Boolean = false,
): List<AiSlashItem> {
    if (catalog == null || draft.isEmpty()) return emptyList()
    val first = draft[0]
    if (first != '/' && first != '／') return emptyList()
    val query = draft.substring(1)
    if (query.any(Char::isWhitespace)) return emptyList()
    val terminal = if (includeTerminalCommands) emptySet() else catalog.terminalSlashCommands.toSet()
    val skills = catalog.skills.asSequence().map(String::trim).filter(String::isNotEmpty).toSet()
    val normalized = query.lowercase()
    val candidates = (catalog.slashCommands.asSequence() + catalog.skills.asSequence())
        .map(String::trim)
        .filter(String::isNotEmpty)
        .distinct()
        .filterNot(terminal::contains)
        .toList()
    val matched = if (normalized.isEmpty()) {
        candidates
    } else {
        val prefix = candidates.filter { it.lowercase().startsWith(normalized) }
        val contains = candidates.filter { !it.lowercase().startsWith(normalized) && it.lowercase().contains(normalized) }
        prefix + contains
    }
    return matched.asSequence()
        .map { AiSlashItem(it, it in skills) }
        .take(limit)
        .toList()
}

/** 合并两份斜杠目录：保留主清单顺序并去重，同时补全来自服务端资产或兜底清单的技能与命令。 */
fun mergeSlashCatalogs(primary: AiSlashCatalog?, fallback: AiSlashCatalog?): AiSlashCatalog? {
    if (primary == null) return fallback
    if (fallback == null) return primary
    val skills = (primary.skills + fallback.skills).map(String::trim).filter(String::isNotEmpty).distinct()
    val commands = (primary.slashCommands + fallback.slashCommands + skills)
        .map(String::trim)
        .filter(String::isNotEmpty)
        .distinct()
    val terminal = (primary.terminalSlashCommands + fallback.terminalSlashCommands)
        .map(String::trim)
        .filter(String::isNotEmpty)
        .distinct()
    return AiSlashCatalog(skills = skills, slashCommands = commands, terminalSlashCommands = terminal)
}

/** CLI 尚未上报 `system/init` 时的按 Agent 兜底命令清单，保证首次输入 `/` 也能唤起快速选择。 */
fun defaultSlashCatalogForProvider(provider: String): AiSlashCatalog? = when (provider.lowercase()) {
    "claude" -> AiSlashCatalog(
        slashCommands = listOf("compact", "clear", "model", "cost", "status", "review", "init", "memory", "plan", "help"),
        terminalSlashCommands = listOf("doctor", "color", "focus", "reload-plugins"),
    )
    "codex" -> AiSlashCatalog(
        slashCommands = listOf("compact", "model", "review", "diff", "status", "new", "init", "approvals", "permissions", "help"),
    )
    "antigravity" -> AiSlashCatalog(
        slashCommands = listOf("model", "config", "permissions", "mcp", "plan", "context", "btw", "compact", "clear", "help"),
    )
    else -> null
}

/** 主线程当前思考的实时快照（Claude thinking 块）。不落盘、不进聊天记录：
 * 长回合里模型可能思考几十分钟才输出一句正文，界面靠它证明模型仍在推进。 */
@Serializable
data class AiThinking(
    val text: String = "",
    val startedAt: Long = 0,
    val updatedAt: Long = 0,
    /** 是否仍在输出：思考块结束后为 false。 */
    val active: Boolean = false,
    /** 本回合已开始的思考段数。 */
    val blocks: Int = 0,
    /** 本回合思考累计字符数（截断前统计）。 */
    val totalChars: Long = 0,
)

/** 发送确认：手机只消费请求标识与版本，正文统一由实时 WebSocket 或 GET 合并。 */
data class AiSendResult(
    val id: String = "",
    val requestId: String = "",
    val revision: Long = 0,
    val status: String? = null,
)

/** ACP 动态配置项的可选值（模型、模式、推理强度等）。 */
@Serializable
data class AiConfigOptionChoice(
    val value: String,
    val name: String = "",
    val description: String? = null,
) {
    val label get() = name.ifBlank { value }
}

/** ACP 会话下发的动态配置项，客户端据此渲染热切换选项。 */
@Serializable
data class AiConfigOption(
    val id: String,
    val name: String = "",
    val category: String? = null,
    val currentValue: String = "",
    val options: List<AiConfigOptionChoice> = emptyList(),
)

@Serializable
data class AiSession(
    val id: String, val title: String, val provider: String, val projectPath: String,
    val providerId: String? = null, val providerName: String? = null,
    val model: String? = null, val status: String = "idle", val messages: List<AiMessage> = emptyList(),
    val approvals: List<AiApproval> = emptyList(), val error: String? = null,
    val updatedAt: Long = 0, val revision: Long = 0, val resultRevision: Long = 0,
    val usage: AiUsage? = null,
    val pendingInputs: List<AiPendingInput> = emptyList(),
    /** CLI `system/init` 下发的 `/` 命令清单；会话启动后自动刷新。 */
    val slashCatalog: AiSlashCatalog? = null,
    /** 主线程当前思考的实时快照；无思考或回合结束时为 null。 */
    val thinking: AiThinking? = null,
    /** 桌面端是否正打开着该会话（服务端运行时标记）；手机「已打开」据此与服务端同步。 */
    val desktopOpen: Boolean = false,
    /** ACP 动态配置项（模型、模式、推理强度等）。 */
    val configOptions: List<AiConfigOption> = emptyList(),
) {
    /** 服务端仍在该会话执行任务（含等待用户确认）。 */
    val running get() = status == "running" || status == "approval" || status == "background" || status == "stopping"
    /** 回复/等待确认期间发送的消息会排队，回合结束后自动按序发送；中断瞬间禁发防误触。 */
    val canSend get() = status != "stopping"
    /** 旧快照可能同时包含队列消息，正文只显示已经实际发出的消息。 */
    val conversationMessages: List<AiMessage>
        get() {
            if (pendingInputs.isEmpty()) return messages
            val pendingIds = pendingInputs.mapTo(mutableSetOf()) { it.requestId }
            return messages.filterNot { it.id in pendingIds }
        }
    /** 排队待发条数，供状态提示展示。 */
    val pendingCount get() = pendingInputs.size
    val statusLabel get() = when (status) {
        "running" -> "正在回复"
        "approval" -> "等待确认"
        "background" -> "后台任务执行中"
        "stopping" -> "正在中断"
        "forceStopped" -> "已强制结束"
        "error" -> "执行失败"
        "interrupted" -> "已中断"
        else -> "可以发送消息"
    }
    val providerLabel get() = when (provider) {
        "codex" -> "Codex"
        "antigravity" -> "Antigravity"
        else -> "Claude"
    }
    val modelLabel get() = model?.takeIf(String::isNotBlank) ?: "服务端默认模型"
    val targetLabel get() = listOfNotNull(providerLabel, providerName?.takeIf(String::isNotBlank), modelLabel).joinToString(" · ")
}

/** `/api/projects` 返回的已登记项目，enabledAgents 决定首页可选哪些 Agent。 */
@Serializable
data class AiAgents(val claude: Boolean = true, val codex: Boolean = true, val antigravity: Boolean = true) {
    fun enabled(agent: String): Boolean = when (agent) {
        "claude" -> claude
        "codex" -> codex
        "antigravity" -> antigravity
        else -> false
    }
    val names get() = listOf("claude", "codex", "antigravity").filter(::enabled)
}

@Serializable
data class AiProject(val name: String, val path: String, val enabledAgents: AiAgents = AiAgents())

/** 快速开始的展示快照；与项目、供应商和模型选择一起按账号写入 SharedPreferences。 */
@Serializable
data class AiQuickStartCache(
    val projects: List<AiProject>,
    val providers: List<AiProvider>,
)

@Serializable
data class AiCatalog(val providers: List<AiProvider> = emptyList())

@Serializable
data class AiProvider(
    val id: String, val agent: String, val name: String, val isDefault: Boolean = false,
    val models: List<AiModel> = emptyList(),
    /**
     * 客户端兜底项：服务端 catalog 没有返回该助手的供应商时，只要项目启用了该助手，
     * 就用「服务端默认配置」占位。创建会话时不能把兜底 id 发给服务端（旧版服务端不认识），
     * 而是省略 providerId，让服务端按默认 CLI 配置启动。
     */
    val localDefault: Boolean = false,
) {
    val agentLabel get() = when (agent) {
        "codex" -> "Codex"
        "antigravity" -> "Antigravity"
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
