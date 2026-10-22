package com.terminalbuddy.android.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PayloadTest {
    @Test
    fun `post always carries a body`() {
        val body = payloadFor("POST", null)
        assertEquals("{}", body?.let { okio.Buffer().also { buffer -> it.writeTo(buffer) }.readUtf8() })
    }

    @Test
    fun `delete without body stays empty while delete with body is sent`() {
        assertNull(payloadFor("DELETE", null))
        val json = buildJsonObject { put("k", "v") }
        assertEquals("{\"k\":\"v\"}", payloadFor("DELETE", json)?.let { okio.Buffer().also { buffer -> it.writeTo(buffer) }.readUtf8() })
    }
}
