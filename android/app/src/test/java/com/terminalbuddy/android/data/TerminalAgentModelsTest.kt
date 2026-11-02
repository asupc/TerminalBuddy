package com.terminalbuddy.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalAgentModelsTest {
    private fun session(
        provider: String = "claude", sessionId: String = "s1", phase: String = "running",
    ) = TerminalAgentSession(
        terminalId = "t-$provider-$sessionId-$phase",
        provider = provider, sessionId = sessionId, phase = phase,
    )

    @Test
    fun `matches provider and session id ignoring other sessions`() {
        val live = session("claude", "abc", "running")
        val found = findLiveAgentSession(
            "claude", "abc",
            listOf(session("codex", "abc", "running"), session("claude", "other", "idle"), live),
        )
        assertEquals(live, found)
    }

    @Test
    fun `ended sessions fall back to history resume`() {
        // agent 已退出、终端回到 shell：不算「正在运行」，继续会话应走恢复历史而不是只读接管。
        assertNull(findLiveAgentSession("claude", "abc", listOf(session("claude", "abc", "ended"))))
    }

    @Test
    fun `unknown phase still matches for read only takeover`() {
        // 服务重启后阶段未知但进程可能仍在：只读接管是安全的（canReply 由服务端闸门把关）。
        val live = session("codex", "abc", "unknown")
        assertEquals(live, findLiveAgentSession("codex", "abc", listOf(live)))
    }

    @Test
    fun `missing session returns null`() {
        assertNull(findLiveAgentSession("claude", "abc", emptyList()))
        assertNull(findLiveAgentSession("claude", "abc", listOf(session("claude", "other"))))
    }
}
