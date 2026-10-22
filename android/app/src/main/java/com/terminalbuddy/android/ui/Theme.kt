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
    primary = Color(0xFF087C53), onPrimary = Color.White,
    primaryContainer = Color(0xFF066841), onPrimaryContainer = Color.White,
    secondary = Color(0xFF2563A6), onSecondary = Color.White,
    secondaryContainer = Color(0xFFDCEBFA), onSecondaryContainer = Color(0xFF14395B),
    tertiary = Color(0xFF8B570F), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFE9C5), onTertiaryContainer = Color(0xFF573300),
    background = Color(0xFFF5F7F6), onBackground = Color(0xFF17251E),
    surface = Color.White, onSurface = Color(0xFF17251E),
    surfaceVariant = Color(0xFFE9EFEC), onSurfaceVariant = Color(0xFF485A50),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF8FAF9),
    surfaceContainer = Color(0xFFF0F4F2), surfaceContainerHigh = Color(0xFFE9EFEC),
    surfaceContainerHighest = Color(0xFFE4EBE7), surfaceTint = Color(0xFF087C53),
    outline = Color(0xFF56675D), outlineVariant = Color(0xFFCCD7D0),
    error = Color(0xFFB83D3D), onError = Color.White,
    errorContainer = Color(0xFFFDE9E8), onErrorContainer = Color(0xFF6F1D1B),
    inverseSurface = Color(0xFF28372F), inverseOnSurface = Color(0xFFF0F4F2),
    inversePrimary = Color(0xFF65D5A5),
)

private val DarkPalette = darkColorScheme(
    primary = Color(0xFF65D5A5), onPrimary = Color(0xFF062519),
    primaryContainer = Color(0xFF3BBD83), onPrimaryContainer = Color(0xFF062519),
    secondary = Color(0xFF70A7E5), onSecondary = Color(0xFF092440),
    secondaryContainer = Color(0xFF183C60), onSecondaryContainer = Color(0xFFDCEBFA),
    tertiary = Color(0xFFE9B86B), onTertiary = Color(0xFF442900),
    tertiaryContainer = Color(0xFF573C14), onTertiaryContainer = Color(0xFFFFE9C5),
    background = Color(0xFF0C0F10), onBackground = Color(0xFFEDF1EF),
    surface = Color(0xFF15191A), onSurface = Color(0xFFEDF1EF),
    surfaceVariant = Color(0xFF1B2021), onSurfaceVariant = Color(0xFFA8B0AD),
    surfaceContainerLowest = Color(0xFF0C0F10), surfaceContainerLow = Color(0xFF15191A),
    surfaceContainer = Color(0xFF101415), surfaceContainerHigh = Color(0xFF1B2021),
    surfaceContainerHighest = Color(0xFF202627), surfaceTint = Color(0xFF65D5A5),
    outline = Color(0xFF9AA8A0), outlineVariant = Color(0xFF2E3534),
    error = Color(0xFFF07878), onError = Color(0xFF420E12),
    errorContainer = Color(0xFF5C2428), onErrorContainer = Color(0xFFFFDAD9),
    inverseSurface = Color(0xFFEDF1EF), inverseOnSurface = Color(0xFF17251E),
    inversePrimary = Color(0xFF087C53),
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
                extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(6.dp),
                medium = RoundedCornerShape(8.dp), large = RoundedCornerShape(12.dp), extraLarge = RoundedCornerShape(20.dp),
            ),
            typography = Typography(
                headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 36.sp),
                titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 21.sp, lineHeight = 29.sp),
                titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 23.sp),
                bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 24.sp),
                bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 21.sp),
                bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 18.sp),
                labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, lineHeight = 19.sp),
                labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 17.sp),
                labelSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 10.sp, lineHeight = 15.sp),
            ),
            content = content,
        )
    }
}
