package com.terminalbuddy.android.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
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

private val LightPalette = lightColorScheme(
    primary = Color(0xFF18181B), onPrimary = Color.White,
    primaryContainer = Color(0xFF27272A), onPrimaryContainer = Color.White,
    secondary = Color(0xFF52525B), onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDEDEF), onSecondaryContainer = Color(0xFF27272A),
    tertiary = Color(0xFF825B18), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFEECF), onTertiaryContainer = Color(0xFF513600),
    background = Color(0xFFF7F7F8), onBackground = Color(0xFF18181B),
    surface = Color.White, onSurface = Color(0xFF18181B),
    surfaceVariant = Color(0xFFF1F1F3), onSurfaceVariant = Color(0xFF5A5A63),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFFAFAFA),
    surfaceContainer = Color(0xFFF7F7F8), surfaceContainerHigh = Color(0xFFF1F1F3),
    surfaceContainerHighest = Color(0xFFEDEDEF), surfaceTint = Color(0xFF18181B),
    outline = Color(0xFF6B6B75), outlineVariant = Color(0xFFE0E0E5),
    error = Color(0xFFB83232), onError = Color.White,
    errorContainer = Color(0xFFFFEDED), onErrorContainer = Color(0xFF7C2020),
    inverseSurface = Color(0xFF27272A), inverseOnSurface = Color(0xFFFAFAFA),
    inversePrimary = Color(0xFFE4E4E7),
)

private val DarkPalette = darkColorScheme(
    primary = Color(0xFFFAFAFA), onPrimary = Color(0xFF18181B),
    primaryContainer = Color(0xFFE4E4E7), onPrimaryContainer = Color(0xFF18181B),
    secondary = Color(0xFFC4C4CC), onSecondary = Color(0xFF18181B),
    secondaryContainer = Color(0xFF303036), onSecondaryContainer = Color(0xFFEDEDEF),
    tertiary = Color(0xFFE8C078), onTertiary = Color(0xFF3E2B0B),
    tertiaryContainer = Color(0xFF473719), onTertiaryContainer = Color(0xFFFFEECF),
    background = Color(0xFF101012), onBackground = Color(0xFFFAFAFA),
    surface = Color(0xFF18181B), onSurface = Color(0xFFFAFAFA),
    surfaceVariant = Color(0xFF232327), onSurfaceVariant = Color(0xFFC4C4CC),
    surfaceContainerLowest = Color(0xFF101012), surfaceContainerLow = Color(0xFF18181B),
    surfaceContainer = Color(0xFF141416), surfaceContainerHigh = Color(0xFF232327),
    surfaceContainerHighest = Color(0xFF2B2B30), surfaceTint = Color(0xFFFAFAFA),
    outline = Color(0xFFA1A1AA), outlineVariant = Color(0xFF35353B),
    error = Color(0xFFFF9292), onError = Color(0xFF4A1515),
    errorContainer = Color(0xFF4A2424), onErrorContainer = Color(0xFFFFDADA),
    inverseSurface = Color(0xFFFAFAFA), inverseOnSurface = Color(0xFF18181B),
    inversePrimary = Color(0xFF27272A),
)

internal data class ThemeControls(
    val darkTheme: Boolean = false,
    val onDarkThemeChange: (Boolean) -> Unit = {},
)

internal val LocalThemeControls = staticCompositionLocalOf { ThemeControls() }

/** 默认浅色；主题状态由 Activity 保存，各页面共用同一份切换状态。 */
@Composable
fun TerminalBuddyTheme(
    darkTheme: Boolean = false,
    onDarkThemeChange: (Boolean) -> Unit = {},
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalThemeControls provides ThemeControls(darkTheme, onDarkThemeChange)) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkPalette else LightPalette,
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
