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
}
