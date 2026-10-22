package com.terminalbuddy.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 配色取自桌面端网页 `web/src/styles.css` 的 CSS 变量：
 * 深色画布 + 薄荷绿强调色（--accent #65d5a5 / --accent-strong #3bbd83），
 * 这里按 Material 3 的语义色重新分配，保持和桌面端同一套视觉语言。
 */
object TbColors {
    val Canvas = Color(0xFF0C0F10)
    val CanvasSoft = Color(0xFF101415)
    val Surface = Color(0xFF15191A)
    val SurfaceRaised = Color(0xFF1B2021)
    val SurfaceHover = Color(0xFF202627)
    val Accent = Color(0xFF65D5A5)
    val AccentStrong = Color(0xFF3BBD83)
    val AccentInk = Color(0xFF062519)
    val Text = Color(0xFFEDF1EF)
    val TextSoft = Color(0xFFA8B0AD)
    val TextMuted = Color(0xFF747E7A)
    val Border = Color(0xFF2E3534)
    val BorderSoft = Color(0xFF242A29)
    val Blue = Color(0xFF70A7E5)
    val Danger = Color(0xFFF07878)
    val Warning = Color(0xFFE9B86B)
}

private val DarkPalette = darkColorScheme(
    primary = TbColors.Accent, onPrimary = TbColors.AccentInk,
    primaryContainer = TbColors.AccentStrong, onPrimaryContainer = TbColors.AccentInk,
    secondary = TbColors.Blue,
    background = TbColors.Canvas, onBackground = TbColors.Text,
    surface = TbColors.Surface, onSurface = TbColors.Text,
    surfaceVariant = TbColors.SurfaceRaised, onSurfaceVariant = TbColors.TextSoft,
    surfaceContainer = TbColors.CanvasSoft, surfaceContainerHigh = TbColors.SurfaceRaised,
    surfaceContainerHighest = TbColors.SurfaceHover,
    outline = TbColors.TextMuted, outlineVariant = TbColors.Border,
    error = TbColors.Danger,
)

// 设备切换浅色时仍沿用同一套深色终端视觉，只把背景略微提亮，避免纯白页面刺眼。
private val LightPalette = darkColorScheme(
    primary = TbColors.AccentStrong, onPrimary = Color.White,
    primaryContainer = Color(0xFFD8F5E8), onPrimaryContainer = Color(0xFF062519),
    secondary = Color(0xFF3C6FA8),
    background = Color(0xFFF2F5F3), onBackground = Color(0xFF12201A),
    surface = Color.White, onSurface = Color(0xFF12201A),
    surfaceVariant = Color(0xFFE4EAE6), onSurfaceVariant = Color(0xFF4C5B54),
    surfaceContainer = Color(0xFFEDF1EE), surfaceContainerHigh = Color(0xFFE4EAE6),
    surfaceContainerHighest = Color(0xFFDCE3DE),
    outline = Color(0xFF75837C), outlineVariant = Color(0xFFD3DBD6),
    error = Color(0xFFB44452),
)

@Composable
fun TerminalBuddyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkPalette else LightPalette,
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
