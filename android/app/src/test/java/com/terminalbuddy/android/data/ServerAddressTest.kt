package com.terminalbuddy.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ServerAddressTest {
    @Test
    fun `normalize keeps proxy sub directory and drops api suffix`() {
        assertEquals("https://example.com/tb/", ServerAddress.normalize("https://example.com/tb/api"))
        assertEquals("http://192.168.1.10:9600/", ServerAddress.normalize("  http://192.168.1.10:9600  "))
        assertEquals("https://example.com/", ServerAddress.normalize("https://example.com/api/"))
    }

    @Test
    fun `normalize rejects credentials and query`() {
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("http://user:pw@host:9600") }
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("http://host:9600/?token=x") }
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("not a url") }
    }

    @Test
    fun `endpoint appends api and escapes session id`() {
        val url = ServerAddress.endpoint("http://host:9600", listOf("ai", "sessions", "a/b"))
        assertEquals("http://host:9600/api/ai/sessions/a%2Fb", url.toString())
    }

    @Test
    fun `ai socket uses ws path with token query`() {
        val url = ServerAddress.aiSocket("http://host:9600/tb/", "id-1", "jwt")
        assertEquals("http://host:9600/tb/ws/ai/id-1?token=jwt", url.toString())
    }
}
