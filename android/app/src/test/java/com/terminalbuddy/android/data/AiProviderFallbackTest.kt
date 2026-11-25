package com.terminalbuddy.android.data

import com.terminalbuddy.android.AiUiState
import org.junit.Assert.*
import org.junit.Test

/** 服务端 catalog 缺少某助手供应商时，只要项目启用了该助手，客户端仍需给出可选入口。 */
class AiProviderFallbackTest {
    @Test
    fun `enabled agent without provider falls back to server default`() {
        val project = AiProject("项目", "/p", AiAgents(claude = true, codex = true, antigravity = true))
        val state = AiUiState(
            projects = listOf(project), projectPath = project.path,
            providers = listOf(AiProvider("claude", "claude", "Claude", models = listOf(AiModel("m1")))),
        )
        assertEquals(listOf("claude", "codex", "antigravity"), state.availableAgents)
        val codex = state.availableProviders.single { it.agent == "codex" }
        assertTrue(codex.localDefault)
        assertEquals("default:codex", codex.id)
        assertEquals("服务端默认配置", codex.name)
        assertEquals(listOf(""), codex.models.map { it.id })
    }

    @Test
    fun `disabled agent does not get a fallback provider`() {
        val project = AiProject("项目", "/p", AiAgents(claude = true, codex = false, antigravity = false))
        val state = AiUiState(
            projects = listOf(project), projectPath = project.path,
            providers = listOf(AiProvider("claude", "claude", "Claude", models = listOf(AiModel("m1")))),
        )
        assertEquals(listOf("claude"), state.availableAgents)
        assertNull(state.availableProviders.find { it.agent == "codex" })
    }

    @Test
    fun `server provided codex provider is never replaced by fallback`() {
        val project = AiProject("项目", "/p", AiAgents(claude = true, codex = true, antigravity = true))
        val state = AiUiState(
            projects = listOf(project), projectPath = project.path,
            providers = listOf(
                AiProvider("claude", "claude", "Claude", models = listOf(AiModel("m1"))),
                AiProvider("codex:real", "codex", "真实供应商", models = listOf(AiModel("gpt"))),
            ),
        )
        val codex = state.availableProviders.single { it.agent == "codex" }
        assertEquals("codex:real", codex.id)
        assertFalse(codex.localDefault)
    }
}
