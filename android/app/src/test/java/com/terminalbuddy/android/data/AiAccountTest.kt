package com.terminalbuddy.android.data

import org.junit.Assert.assertEquals
import org.junit.Test

class AiAccountTest {
    @Test
    fun `label falls back to username when name blank`() {
        assertEquals("客厅 NAS", AiAccount("id", "http://192.168.1.10:9600/", "admin", true, "客厅 NAS").label)
        assertEquals("admin", AiAccount("id", "http://192.168.1.10:9600/", "admin", true, "").label)
        assertEquals("admin", AiAccount("id", "http://192.168.1.10:9600/", "admin", true, "  ").label)
    }

    @Test
    fun `account keeps four argument constructor for old callers`() {
        // 旧调用点（通知等）仍按 server + username 构造，名称默认为空。
        val legacy = AiAccount("id", "http://host:9600/", "admin", false)
        assertEquals("", legacy.name)
        assertEquals("admin", legacy.label)
    }
}
