package com.terminalbuddy.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 任务结果留存依赖 SharedPreferences 里的 JSON，字段增删不应静默丢数据。 */
class ServerResultNoticeTest {
    private fun notice(kind: String = "completed") = ServerResultNotice(
        accountId = "a1", eventId = "e1",
        terminalId = "t1", terminalName = "构建终端",
        provider = "codex", kind = kind,
        title = "任务已完成", summary = "全部检查通过",
        occurredAt = 1_730_000_000_000, observedAt = 1_730_000_001_000,
    )

    @Test
    fun `round trips through persisted json`() {
        val decoded = ApiJson.decodeFromString<List<ServerResultNotice>>(
            ApiJson.encodeToString(listOf(notice())),
        )
        assertEquals(listOf(notice()), decoded)
    }

    @Test
    fun `unknown fields and missing defaults stay readable`() {
        // 旧版本写入的数据缺新字段、或未来版本多写字段，都应能还原核心内容。
        val decoded = ApiJson.decodeFromString<ServerResultNotice>(
            """{"accountId":"a1","eventId":"e1","kind":"failed","summary":"编译失败","futureField":1}""",
        )
        assertEquals("failed", decoded.kind)
        assertEquals("编译失败", decoded.summary)
        assertTrue(decoded.failed)
    }

    @Test
    fun `only failed kind marks failure`() {
        assertTrue(notice("failed").failed)
        assertFalse(notice("completed").failed)
        assertFalse(notice("interrupted").failed)
    }
}
