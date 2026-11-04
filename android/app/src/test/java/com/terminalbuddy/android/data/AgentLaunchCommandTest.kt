package com.terminalbuddy.android.data

import org.junit.Assert.assertEquals
import org.junit.Test

class AgentLaunchCommandTest {
    @Test
    fun `claude llm provider keeps permission args and drops model conflicts`() {
        val command = AgentLaunchCommand.build(
            agent = "claude",
            providerId = "llm:p1",
            modelId = "m1",
            configuredBase = "claude --dangerously-skip-permissions --model old --effort low",
        )
        assertEquals("__TB_CLAUDE_REF__:p1:m1 --dangerously-skip-permissions", command)
    }

    @Test
    fun `claude default provider uses base command unchanged`() {
        val base = "claude --dangerously-skip-permissions"
        assertEquals(base, AgentLaunchCommand.build("claude", "default:claude", "", base))
    }

    @Test
    fun `claude unsupported provider falls back to base command`() {
        val base = "claude --permission-mode plan"
        assertEquals(base, AgentLaunchCommand.build("claude", "claude:legacy", "m1", base))
    }

    @Test
    fun `codex provider keeps sandbox args and drops provider conflicts`() {
        val command = AgentLaunchCommand.build(
            agent = "codex",
            providerId = "codex:c1",
            modelId = "gpt-5",
            configuredBase = "codex --dangerously-bypass-approvals-and-sandbox --model old -c a=b --oss",
        )
        assertEquals(
            "__TB_CODEX_REF__:c1:gpt-5 --dangerously-bypass-approvals-and-sandbox",
            command,
        )
    }

    @Test
    fun `blank configured base falls back to built in defaults`() {
        assertEquals(AgentLaunchCommand.DEFAULT_CLAUDE, AgentLaunchCommand.build("claude", "", "", null))
        assertEquals(AgentLaunchCommand.DEFAULT_CODEX, AgentLaunchCommand.build("codex", "", "", "  "))
    }
}
