package com.terminalbuddy.android.data

import com.terminalbuddy.android.AiUiState
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.Assert.*
import org.junit.Test

class AiProjectHistoryTest {
    @Test
    fun `project models retain provider identity and exclude disabled agents`() {
        val project = AiProject("项目", "C:\\work", AiAgents(claude = false, codex = true, pi = false))
        val state = AiUiState(projects = listOf(project), projectPath = project.path, providers = listOf(
            AiProvider("claude", "claude", "Claude", models = listOf(AiModel("same"))),
            AiProvider("codex-a", "codex", "供应商 A", models = listOf(AiModel("same"))),
            AiProvider("codex-b", "codex", "供应商 B", models = listOf(AiModel("same"))),
        ))
        val models = state.projectModels(project)
        assertEquals(listOf("codex-a", "codex-b"), models.map { it.provider.id })
        assertNotEquals(models[0].key, models[1].key)
        assertEquals(listOf("codex"), state.availableAgents)
        assertTrue(state.projectModels(project, "pi").isEmpty())
    }

    @Test
    fun `installed agents filter by environment and fall back to all when unknown`() {
        // 检测失败或旧服务端无接口时按全部已安装处理，避免助手整体消失。
        val unknown = AiUiState()
        assertNull(unknown.installedAgents)
        assertTrue(unknown.agentInstalled("claude"))
        assertTrue(unknown.agentInstalled("pi"))
        val detected = unknown.copy(agentEnvironment = AiAgentEnvironment(
            claude = AiAgentCliStatus("installed"), codex = AiAgentCliStatus("notInstalled"),
        ))
        // 未返回的助手按未安装处理，与桌面端可用判定一致。
        assertEquals(listOf("claude"), detected.installedAgents)
        assertTrue(detected.agentInstalled("claude"))
        assertFalse(detected.agentInstalled("codex"))
        assertFalse(detected.agentInstalled("pi"))
    }

    @Test
    fun `history path matching handles windows case boundaries and nested projects`() {
        val parent = AiProject("父项目", "C:\\Work")
        val child = AiProject("子项目", "C:\\Work\\Buddy", AiAgents(codex = false))
        assertEquals(child, historyProject(listOf(parent, child), "c:/WORK/buddy/src/"))
        assertEquals(child, historyProject(listOf(parent, child), "//?/C:/WORK/buddy/src"))
        assertEquals("共享目录", historyProject(listOf(AiProject("共享目录", "\\\\server\\share")), "//?/UNC/server/share/project")?.name)
        assertEquals(parent, historyProject(listOf(parent), "C:/Work/src"))
        assertNull(historyProject(listOf(parent), "C:/Workers"))
        assertNull(historyProject(listOf(AiProject("Linux", "/Work")), "/work/src"))
        assertEquals("根目录", historyProject(listOf(AiProject("根目录", "/")), "/src")?.name)
    }

    @Test
    fun `codex history protocol tolerates server metadata and null optionals`() {
        val session = ApiJson.decodeFromJsonElement<AiHistorySession>(ApiJson.parseToJsonElement(
            """{"sessionId":"s","title":"历史标题","projectDir":"/p","filePath":"/private/rollout.jsonl","customTitle":null,"model":null,"updatedAt":123,"messageCount":2}"""
        ))
        assertEquals("历史标题", session.title)
        assertNull(session.model)
        val page = ApiJson.decodeFromJsonElement<AiHistoryReplay>(ApiJson.parseToJsonElement(
            """{"total":1,"title":"历史标题","projectDir":"/p","messages":[{"seq":0,"role":"tool","text":"","tools":[{"name":"exec","summary":"结果"}],"toolName":"exec","timestamp":null}]}"""
        ))
        assertEquals("结果", page.messages.single().tools.single().summary)
        assertNull(page.messages.single().timestamp)
    }
}
