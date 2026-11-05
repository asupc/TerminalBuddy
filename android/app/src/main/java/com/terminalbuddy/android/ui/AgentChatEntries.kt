package com.terminalbuddy.android.ui

import com.terminalbuddy.android.data.AiHistoryMessage

/**
 * 终端 Agent 镜像的展示分组：转录里每个工具回合都会写一条 assistant（通常没有正文）
 * 加一条 tool 结果，如果逐条渲染，一次任务会变成几十上百条“消息”。
 * 这里把连续的思考/执行步骤折叠成一个「思考过程」块，只把真正的文字回复保留为消息气泡。
 */
internal sealed interface AgentChatEntry {
    val key: String

    /** 用户消息、assistant 正文或 system 提示：按普通消息气泡展示。 */
    data class Message(val message: AiHistoryMessage) : AgentChatEntry {
        override val key get() = "agent-msg-${message.seq}"
    }

    /** 连续的「无正文工具调用 + 工具结果」，合并成一个可展开的思考过程。 */
    data class Process(val steps: List<AiHistoryMessage>) : AgentChatEntry {
        // 只按首条 seq 标识：后续步骤追加时分组身份不变，展开状态与滚动位置不会被重置。
        override val key get() = "agent-process-${steps.first().seq}"
    }
}

/**
 * 分组规则：
 * - user / 带正文的 assistant / 其他角色 → 独立消息（顺序不变）；
 * - 无正文的 assistant 工具调用与 tool 结果 → 并入当前思考过程；
 * - 带正文的 assistant 如果同时带工具调用，正文仍单独显示，其后的工具步骤开始新的
 *   思考过程，避免把真正回复的工具记录混进正文。
 * 空正文且无工具的 assistant 记录不产生任何条目。
 */
internal fun groupAgentChatEntries(messages: List<AiHistoryMessage>): List<AgentChatEntry> {
    val entries = mutableListOf<AgentChatEntry>()
    val process = mutableListOf<AiHistoryMessage>()

    fun flushProcess() {
        if (process.isEmpty()) return
        entries += AgentChatEntry.Process(process.toList())
        process.clear()
    }

    for (message in messages) {
        when (message.role) {
            "user" -> {
                flushProcess()
                entries += AgentChatEntry.Message(message)
            }
            "assistant" -> when {
                message.text.isNotBlank() -> {
                    flushProcess()
                    // 正文单独成消息；同一条记录里的工具调用归入后续思考过程，避免重复展示。
                    entries += AgentChatEntry.Message(
                        if (message.tools.isEmpty()) message else message.copy(tools = emptyList())
                    )
                    if (message.tools.isNotEmpty()) process += message
                }
                message.tools.isNotEmpty() -> process += message
                // 空正文也没有工具：转录里的占位记录，不展示。
            }
            "tool" -> process += message
            else -> {
                flushProcess()
                entries += AgentChatEntry.Message(message)
            }
        }
    }
    flushProcess()
    return entries
}

/** 折叠状态下展示的最新一步摘要；与展开后的单步行保持同一口径。 */
internal fun processStepSummary(message: AiHistoryMessage): String {
    if (message.role == "assistant") {
        val tool = message.tools.lastOrNull() ?: return "执行过程"
        return listOf(tool.name, tool.summary).filter(String::isNotBlank).joinToString(" · ")
    }
    val firstLine = message.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    val name = message.toolName?.takeIf(String::isNotBlank) ?: "工具"
    return when {
        firstLine.startsWith("{") || firstLine.startsWith("[") -> "$name · 工具返回结果"
        firstLine.isBlank() -> "$name · 执行完成"
        else -> "$name · $firstLine"
    }
}
