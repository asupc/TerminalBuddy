package com.terminalbuddy.android.ui

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalConfiguration

/**
 * 平板横屏：设备本身是平板（最小宽度 ≥ 600dp）且当前横屏窗口宽度也至少 600dp。
 * 竖屏、手机横屏与平板分屏后的窄窗口都不进入该分支，保持原有单列布局与交互。
 */
@Composable
@ReadOnlyComposable
internal fun isTabletLandscape(): Boolean {
    val configuration = LocalConfiguration.current
    return configuration.orientation == Configuration.ORIENTATION_LANDSCAPE &&
        configuration.smallestScreenWidthDp >= 600 &&
        configuration.screenWidthDp >= 600
}
