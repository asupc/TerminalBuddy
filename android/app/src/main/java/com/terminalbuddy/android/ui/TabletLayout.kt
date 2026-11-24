package com.terminalbuddy.android.ui

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import kotlin.math.hypot
import kotlin.math.min

/** 设计稿的启用阈值：平板横屏且窗口宽度至少 600dp。 */
private const val TABLET_MIN_WIDTH_DP = 600

/** 展开态窗口（Material 3 的 expanded）宽度阈值，用于高缩放 density 设备的兜底。 */
private const val EXPANDED_MIN_WIDTH_DP = 840

/** 物理屏幕对角线达到该值即视为平板（手机普遍在 7 英寸以内）。 */
private const val TABLET_MIN_DIAGONAL_INCHES = 7.5f

/**
 * 平板横屏：设备本身是平板，且当前横屏窗口宽度至少 600dp。
 * 竖屏、手机横屏与宽度不足 600dp 的分屏窗口都不进入该分支，保持原有单列布局与交互。
 *
 * 判定刻意不依赖 [Configuration.orientation]（厂商电脑模式 / 兼容窗口 / 平行视界可能不写方向），
 * 也不只依赖 `smallestScreenWidthDp`：
 * - 窗口尺寸按「宽 > 高」判断更稳；
 * - 部分机型把 density 调得较高，`smallestScreenWidthDp` 与「物理短边 ÷ density」会一起掉到
 *   600dp 以下（如 8.8 英寸平板横屏窗口 922 × 576dp），因此再依次回退到物理对角线英寸数，
 *   最后用「展开态宽度 + 平板常见的宽高比」兜底。
 */
@Composable
@ReadOnlyComposable
internal fun isTabletLandscape(): Boolean {
    val configuration = LocalConfiguration.current
    val widthDp = configuration.screenWidthDp
    val heightDp = configuration.screenHeightDp
    if (widthDp < TABLET_MIN_WIDTH_DP || widthDp <= heightDp) return false
    if (configuration.smallestScreenWidthDp >= TABLET_MIN_WIDTH_DP) return true
    val context = LocalContext.current
    val real = realDisplayMetrics(context)
    if (real != null) {
        if (min(real.widthPixels, real.heightPixels) / real.density >= TABLET_MIN_WIDTH_DP) return true
        if (real.xdpi > 0f && real.ydpi > 0f) {
            val diagonalInches = hypot(real.widthPixels / real.xdpi, real.heightPixels / real.ydpi)
            if (diagonalInches >= TABLET_MIN_DIAGONAL_INCHES) return true
        }
    }
    // 兜底：窗口已达到展开态宽度，且宽高比接近平板（4:3 / 3:2 / 16:10），
    // 而非手机横屏的 2:1 以上窄长比例。
    return widthDp >= EXPANDED_MIN_WIDTH_DP && widthDp.toFloat() / heightDp <= 1.9f
}

/** 物理屏幕的真实尺寸（不受窗口大小影响）。 */
@Suppress("DEPRECATION")
private fun realDisplayMetrics(context: Context): DisplayMetrics? {
    val display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        context.display
    } else {
        context.getSystemService(WindowManager::class.java)?.defaultDisplay
    }
    if (display == null) return null
    val real = DisplayMetrics()
    display.getRealMetrics(real)
    return real.takeIf { it.widthPixels > 0 && it.heightPixels > 0 && it.density > 0f }
}

/** 供服务信息页展示的物理屏幕对角线（英寸）。 */
internal fun displayDiagonalInches(context: Context): Float? =
    realDisplayMetrics(context)?.let { real ->
        if (real.xdpi > 0f && real.ydpi > 0f) {
            hypot(real.widthPixels / real.xdpi, real.heightPixels / real.ydpi)
        } else null
    }
