package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 页面统一读取当前 Material 配色，切换主题时正文、图标、卡片与弹层同步更新。 */
object TbColors {
    val Canvas: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.background
    val CanvasSoft: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainer
    val Surface: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surface
    val SurfaceRaised: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainerHigh
    val SurfaceHover: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainerHighest
    val Accent: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.primary
    val AccentStrong: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.primaryContainer
    val AccentInk: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onPrimary
    /** 纯色皮肤的实心控件使用黑底浅字，文字链接仍沿用可读的强调色。 */
    val ButtonBackground: Color
        @Composable @ReadOnlyComposable get() = if (LocalThemeControls.current.skin.fixedDarkTheme != null) Color.Black
            else MaterialTheme.colorScheme.primary
    val ButtonForeground: Color
        @Composable @ReadOnlyComposable get() = if (LocalThemeControls.current.skin.fixedDarkTheme != null) Color.White
            else MaterialTheme.colorScheme.onPrimary
    val Text: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurface
    val TextSoft: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurfaceVariant
    val TextMuted: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.outline
    val Border: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.outlineVariant
    val BorderSoft: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .65f)
    val Blue: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.secondary
    val Danger: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.error
    val Warning: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.tertiary
}

internal data class ThemeControls(
    val darkTheme: Boolean = false,
    val onDarkThemeChange: (Boolean) -> Unit = {},
    val skin: AppSkin = AppSkin.Pine,
    val onSkinChange: (AppSkin) -> Unit = {},
)

internal val LocalThemeControls = staticCompositionLocalOf { ThemeControls() }

/** 纯色皮肤统一使用黑色实心按钮，其他皮肤沿用 Material 默认按钮配色。 */
@Composable
internal fun primaryButtonColors(tonal: Boolean = false): ButtonColors {
    if (LocalThemeControls.current.skin.fixedDarkTheme == null) {
        return if (tonal) ButtonDefaults.filledTonalButtonColors() else ButtonDefaults.buttonColors()
    }
    return ButtonDefaults.buttonColors(
        containerColor = TbColors.ButtonBackground,
        contentColor = TbColors.ButtonForeground,
    )
}

/** 细描边保证黑色控件在纯黑画布和深色面板中仍有清楚轮廓。 */
@Composable
internal fun primaryControlBorder(): BorderStroke? = if (LocalThemeControls.current.skin.fixedDarkTheme != null) {
    BorderStroke(1.dp, TbColors.TextMuted)
} else null

/** 深浅模式和皮肤独立保存，各页面、卡片与弹层统一更新。 */
@Composable
fun TerminalBuddyTheme(
    darkTheme: Boolean = false,
    onDarkThemeChange: (Boolean) -> Unit = {},
    skin: AppSkin = AppSkin.Pine,
    onSkinChange: (AppSkin) -> Unit = {},
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalThemeControls provides ThemeControls(
        darkTheme = darkTheme, onDarkThemeChange = onDarkThemeChange,
        skin = skin, onSkinChange = onSkinChange,
    )) {
        MaterialTheme(
            colorScheme = skin.colorScheme(darkTheme),
            shapes = Shapes(
                extraSmall = RoundedCornerShape(8.dp), small = RoundedCornerShape(12.dp),
                medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(28.dp),
            ),
            typography = Typography(
                headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 42.sp),
                headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 36.sp),
                headlineSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp),
                titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 30.sp),
                titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 24.sp),
                titleSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 22.sp),
                bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 26.sp),
                bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 22.sp),
                bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 20.sp),
                labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
                labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 18.sp),
                labelSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 16.sp),
            ),
            content = content,
        )
    }
}

/** 弥散皮肤使用低浓度色晕，其余皮肤保持纯色底，正文和卡片仍使用实色。 */
@Composable
internal fun Modifier.skinBackground(): Modifier {
    val controls = LocalThemeControls.current
    val baseModifier = background(TbColors.Canvas)
    if (!controls.skin.diffuseBackground) return baseModifier
    val colors = controls.skin.previewColors
    val upperAlpha = if (controls.darkTheme) .10f else .12f
    val lowerAlpha = if (controls.darkTheme) .14f else .18f
    return baseModifier.drawWithCache {
        val upperGlow = Brush.radialGradient(
            colors = listOf(colors[0].copy(alpha = upperAlpha), Color.Transparent),
            center = Offset(size.width * .05f, size.height * .08f),
            radius = size.maxDimension.coerceAtLeast(1f) * .78f,
        )
        val lowerGlow = Brush.radialGradient(
            colors = listOf(colors[1].copy(alpha = lowerAlpha), Color.Transparent),
            center = Offset(size.width * .95f, size.height * .72f),
            radius = size.maxDimension.coerceAtLeast(1f) * .7f,
        )
        onDrawBehind {
            drawRect(upperGlow)
            drawRect(lowerGlow)
        }
    }
}
