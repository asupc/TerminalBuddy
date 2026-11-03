package com.terminalbuddy.android.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private inline fun <reified T> decode(raw: String): T =
    ApiJson.decodeFromJsonElement(ApiJson.parseToJsonElement(raw) as JsonElement)

class AiModelsTest {
    @Test
    fun `session list payload without messages decodes`() {
        val session = decode<AiSession>(
            """
            {"id":"s1","title":"新对话","provider":"claude","projectPath":"/p","providerId":"llm:x",
             "providerName":"Claude 官方","model":"claude-sonnet-5","status":"idle","messages":[],"approvals":[],
             "error":null,"updatedAt":100,"revision":3}
            """.trimIndent()
        )
        assertEquals("Claude 官方", session.providerName)
        assertEquals("Claude · Claude 官方 · claude-sonnet-5", session.targetLabel)
        assertFalse(session.running)
    }

    @Test
    fun `session tolerates missing optional fields from old servers`() {
        val session = decode<AiSession>(
            """{"id":"s1","title":"t","provider":"codex","projectPath":"p","status":"running","messages":[],"approvals":[],"error":null,"updatedAt":1,"revision":1}"""
        )
        assertEquals(null, session.model)
        assertEquals("服务端默认模型", session.modelLabel)
        assertTrue(session.running)
    }

    @Test
    fun `catalog providers decode with default and model effort`() {
        val catalog = decode<AiCatalog>(
            """
            {"providers":[{"id":"default:claude","agent":"claude","name":"服务端默认配置","isDefault":false,
              "models":[{"id":"","label":"服务端默认模型","effort":""}]},
             {"id":"codex:a","agent":"codex","name":"Codex A","isDefault":true,
              "models":[{"id":"gpt-5-codex","label":"gpt-5-codex","effort":"xhigh"}]}]}
            """.trimIndent()
        )
        assertEquals(2, catalog.providers.size)
        assertEquals("Codex · Codex A", catalog.providers[1].label)
        assertEquals("很高", catalog.providers[1].models[0].effortLabel)
        assertEquals("服务端默认模型", catalog.providers[0].models[0].title)
    }

    @Test
    fun `approval details decode into json object`() {
        val approval = decode<AiApproval>(
            """{"id":"a1","method":"exec","details":{"command":"rm -rf build","questions":[{"id":"q1"}]}}"""
        )
        assertEquals("rm -rf build", approval.details.text("command"))
        assertEquals(1, approval.details.rows("questions").size)
        assertEquals(JsonObject(emptyMap()), AiApproval("a2", "m").details)
    }

    @Test
    fun `project enabled agents defaults to both`() {
        val project = decode<AiProject>("""{"name":"p","path":"/p"}""")
        assertTrue(project.enabledAgents.claude)
        assertTrue(project.enabledAgents.codex)
    }

    @Test
    fun `model effort labels normalize case and new levels`() {
        assertEquals("极高", AiModel(id = "m", effort = " Ultra ").effortLabel)
        assertEquals("关闭", AiModel(id = "m", effort = "none").effortLabel)
        assertEquals("自动", AiModel(id = "m", effort = "Auto").effortLabel)
        assertEquals("跟随服务端", AiModel(id = "m", effort = "default").effortLabel)
    }
}
