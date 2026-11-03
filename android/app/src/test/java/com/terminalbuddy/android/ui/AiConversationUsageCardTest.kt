package com.terminalbuddy.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 上下文进度条只在拿到有效比例时前进，缺失或为 0 都不能把进度打回零点。 */
class AiConversationUsageCardTest {
    @Test
    fun `首次有效比例直接采用`() {
        assertEquals(0.25, retainContextProgress(null, 0.25), 0.0)
    }

    @Test
    fun `缺失统计沿用上一次进度`() {
        assertEquals(0.25, retainContextProgress(0.25, null), 0.0)
    }

    @Test
    fun `零值不覆盖已有进度`() {
        assertEquals(0.25, retainContextProgress(0.25, 0.0), 0.0)
    }

    @Test
    fun `负数与非法值不覆盖已有进度`() {
        assertEquals(0.25, retainContextProgress(0.25, -0.1), 0.0)
        assertEquals(0.25, retainContextProgress(0.25, Double.NaN), 0.0)
        assertEquals(0.25, retainContextProgress(0.25, Double.POSITIVE_INFINITY), 0.0)
    }

    @Test
    fun `首次没有有效值时保持空进度`() {
        assertNull(retainContextProgress(null, null))
        assertNull(retainContextProgress(null, 0.0))
    }

    @Test
    fun `新值增长后替换旧进度`() {
        assertEquals(0.4, retainContextProgress(0.25, 0.4), 0.0)
    }

    @Test
    fun `新会话预置的零值仍可展示`() {
        assertEquals(0L, acceptKnownUsage(null, 0L, rejectZeroAfterPositive = true))
    }

    @Test
    fun `已知正值后零值视为统计缺失`() {
        assertNull(acceptKnownUsage(250_000L, 0L, rejectZeroAfterPositive = true))
    }

    @Test
    fun `已知正值后的缺失值沿用上一次`() {
        assertNull(acceptKnownUsage(250_000L, null, rejectZeroAfterPositive = true))
    }

    @Test
    fun `新的正值正常替换`() {
        assertEquals(300_000L, acceptKnownUsage(250_000L, 300_000L, rejectZeroAfterPositive = true))
    }

    @Test
    fun `输入输出等字段仍允许零值覆盖`() {
        assertEquals(0L, acceptKnownUsage(120L, 0L))
    }
}
