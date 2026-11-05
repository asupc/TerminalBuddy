package com.terminalbuddy.android.ui

import com.terminalbuddy.android.data.AiHistoryMessage
import com.terminalbuddy.android.data.AiHistoryTool
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentChatEntriesTest {
    private fun assistant(seq: Long, text: String = "", tools: List<AiHistoryTool> = emptyList()) =
        AiHistoryMessage(seq = seq, role = "assistant", text = text, tools = tools)

    private fun tool(seq: Long, text: String = "输出", name: String? = "Bash") =
        AiHistoryMessage(seq = seq, role = "tool", text = text, toolName = name)

    private fun user(seq: Long, text: String = "问题") =
        AiHistoryMessage(seq = seq, role = "user", text = text)

    @Test
    fun `continuous execution steps merge into one process block`() {
        val entries = groupAgentChatEntries(
            listOf(
                user(0),
                assistant(1, tools = listOf(AiHistoryTool("Bash", "grep a"))),
                tool(2),
                assistant(3, tools = listOf(AiHistoryTool("Read", "a.kt"))),
                tool(4),
            ),
        )
        assertEquals(2, entries.size)
        assertTrue(entries[0] is AgentChatEntry.Message)
        val process = entries[1] as AgentChatEntry.Process
        assertEquals(listOf(1L, 2L, 3L, 4L), process.steps.map { it.seq })
    }

    @Test
    fun `text replies stay separate and start a new process for their tools`() {
        val entries = groupAgentChatEntries(
            listOf(
                user(0),
                assistant(1, tools = listOf(AiHistoryTool("Bash", "ls"))),
                tool(2),
                assistant(3, text = "已找到原因。"),
                assistant(4, text = "继续修复。", tools = listOf(AiHistoryTool("Edit", "a.kt"))),
                tool(5),
            ),
        )
        assertEquals(listOf("Message", "Process", "Message", "Message", "Process"), entries.map {
            when (it) {
                is AgentChatEntry.Message -> "Message"
                is AgentChatEntry.Process -> "Process"
            }
        })
        val replyWithTools = entries[3] as AgentChatEntry.Message
        // 正文单独展示，工具调用不重复挂在正文下。
        assertEquals("继续修复。", replyWithTools.message.text)
        assertTrue(replyWithTools.message.tools.isEmpty())
        assertEquals(listOf(4L, 5L), (entries[4] as AgentChatEntry.Process).steps.map { it.seq })
    }

    @Test
    fun `empty assistant placeholders are dropped without breaking the process`() {
        val entries = groupAgentChatEntries(
            listOf(user(0), assistant(1), assistant(2, tools = listOf(AiHistoryTool("Bash", ""))), tool(3)),
        )
        assertEquals(2, entries.size)
        assertEquals(listOf(2L, 3L), (entries[1] as AgentChatEntry.Process).steps.map { it.seq })
    }

    @Test
    fun `process summary prefers tool name and first meaningful line`() {
        assertEquals("Bash · grep a", processStepSummary(assistant(1, tools = listOf(AiHistoryTool("Bash", "grep a")))))
        assertEquals("Bash · 结果行", processStepSummary(tool(2, text = "\n结果行\n更多")))
        assertEquals("Bash · 工具返回结果", processStepSummary(tool(3, text = "{\"ok\":true}")))
        assertEquals("工具 · 执行完成", processStepSummary(tool(4, text = "  ", name = null)))
    }
}
