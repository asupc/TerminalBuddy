package com.terminalbuddy.android.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

/** 稳定的皮肤标识用于本机保存，深浅配色与设计稿保持一致。 */
enum class AppSkin(
    val id: String,
    val title: String,
    val description: String,
    private val lightColors: ColorScheme,
    darkColors: ColorScheme,
) {
    Green(
        id = "green", title = "青松绿", description = "安静、熟悉、专注",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFF087C53),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFF5F7F6),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFEDF3EF),
            tint = Color(0xFFE5F3EB),
            text = Color(0xFF17251E),
            muted = Color(0xFF56675D),
            border = Color(0xFFD8E4DC),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFF65D5A5),
            ink = Color(0xFF082C1D),
            background = Color(0xFF0C1915),
            surface = Color(0xFF142820),
            field = Color(0xFF1C362B),
            tint = Color(0xFF1B3B2B),
            text = Color(0xFFECF5EF),
            muted = Color(0xFFAEC1B5),
            border = Color(0xFF2A4537),
        ),
    ),

    Blue(
        id = "blue", title = "晴空蓝", description = "清爽、精确、专业",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFF315ED8),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFF3F6FC),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFEDF2FA),
            tint = Color(0xFFE8EEFF),
            text = Color(0xFF172540),
            muted = Color(0xFF586B88),
            border = Color(0xFFDCE4F1),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFF91B1FF),
            ink = Color(0xFF10234D),
            background = Color(0xFF0F1829),
            surface = Color(0xFF18263D),
            field = Color(0xFF21334F),
            tint = Color(0xFF233959),
            text = Color(0xFFEDF3FF),
            muted = Color(0xFFA8B9D3),
            border = Color(0xFF2C415F),
        ),
    ),

    Violet(
        id = "violet", title = "鸢尾紫", description = "柔和、细腻、灵感",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFF6E56CF),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFF7F5FC),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFF0ECF8),
            tint = Color(0xFFEEE8FC),
            text = Color(0xFF292039),
            muted = Color(0xFF6C607C),
            border = Color(0xFFE4DDEF),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFFC0ACFF),
            ink = Color(0xFF271B45),
            background = Color(0xFF181322),
            surface = Color(0xFF251D34),
            field = Color(0xFF332743),
            tint = Color(0xFF372B4C),
            text = Color(0xFFF4EFFB),
            muted = Color(0xFFBFB1CE),
            border = Color(0xFF453551),
        ),
    ),

    Clay(
        id = "clay", title = "陶土橙", description = "温暖、松弛、耐看",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFFA95136),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFFBF7F1),
            surface = Color(0xFFFFFEFB),
            field = Color(0xFFF5EDE3),
            tint = Color(0xFFF8E9DF),
            text = Color(0xFF382A23),
            muted = Color(0xFF7C6858),
            border = Color(0xFFEADFD3),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFFF0AE8B),
            ink = Color(0xFF3D2116),
            background = Color(0xFF211712),
            surface = Color(0xFF30231C),
            field = Color(0xFF402F25),
            tint = Color(0xFF4A3023),
            text = Color(0xFFF9EFE5),
            muted = Color(0xFFD0B8A5),
            border = Color(0xFF533D30),
        ),
    );

    // Material 固定色角色在深浅模式间保持同一份皮肤色，避免回落到默认紫色。
    private val darkPalette = darkColors.copy(
        primaryFixed = lightColors.primaryFixed, primaryFixedDim = lightColors.primaryFixedDim,
        onPrimaryFixed = lightColors.onPrimaryFixed, onPrimaryFixedVariant = lightColors.onPrimaryFixedVariant,
        secondaryFixed = lightColors.secondaryFixed, secondaryFixedDim = lightColors.secondaryFixedDim,
        onSecondaryFixed = lightColors.onSecondaryFixed, onSecondaryFixedVariant = lightColors.onSecondaryFixedVariant,
        tertiaryFixed = lightColors.tertiaryFixed, tertiaryFixedDim = lightColors.tertiaryFixedDim,
        onTertiaryFixed = lightColors.onTertiaryFixed, onTertiaryFixedVariant = lightColors.onTertiaryFixedVariant,
    )

    fun colorScheme(darkTheme: Boolean): ColorScheme = if (darkTheme) darkPalette else lightColors

    companion object {
        /** 新用户、旧版本或无效的保存值统一回退到原有绿色皮肤。 */
        fun fromId(id: String?): AppSkin = entries.firstOrNull { it.id == id } ?: Green
    }
}

/** 补齐 Material 语义色，确保正文、弹层、选中态和背景使用同一套皮肤。 */
private fun skinColorScheme(
    darkTheme: Boolean, primary: Color, ink: Color, background: Color, surface: Color,
    field: Color, tint: Color, text: Color, muted: Color, border: Color,
): ColorScheme {
    val base = if (darkTheme) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = primary, onPrimary = ink,
        primaryFixed = tint, primaryFixedDim = lerp(tint, primary, .08f),
        onPrimaryFixed = text, onPrimaryFixedVariant = text,
        secondaryFixed = tint, secondaryFixedDim = lerp(tint, primary, .08f),
        onSecondaryFixed = text, onSecondaryFixedVariant = text,
        tertiaryFixed = Color(0xFFFFEECF), tertiaryFixedDim = Color(0xFFF4D9A2),
        onTertiaryFixed = Color(0xFF513600), onTertiaryFixedVariant = Color(0xFF825B18),
        primaryContainer = tint, onPrimaryContainer = primary,
        secondary = primary, onSecondary = ink,
        secondaryContainer = tint, onSecondaryContainer = text,
        tertiary = if (darkTheme) Color(0xFFE8C078) else Color(0xFF825B18),
        onTertiary = if (darkTheme) Color(0xFF3E2B0B) else Color.White,
        tertiaryContainer = if (darkTheme) Color(0xFF473719) else Color(0xFFFFEECF),
        onTertiaryContainer = if (darkTheme) Color(0xFFFFEECF) else Color(0xFF513600),
        background = background, onBackground = text,
        surface = surface, onSurface = text,
        surfaceVariant = field, onSurfaceVariant = muted,
        surfaceDim = background, surfaceBright = field,
        surfaceContainerLowest = if (darkTheme) background else surface,
        surfaceContainerLow = surface, surfaceContainer = background,
        surfaceContainerHigh = field, surfaceContainerHighest = field,
        surfaceTint = primary, outline = muted, outlineVariant = border,
        error = if (darkTheme) Color(0xFFFF9292) else Color(0xFFB83232),
        onError = if (darkTheme) Color(0xFF4A1515) else Color.White,
        errorContainer = if (darkTheme) Color(0xFF4A2424) else Color(0xFFFFEDED),
        onErrorContainer = if (darkTheme) Color(0xFFFFDADA) else Color(0xFF7C2020),
        inverseSurface = text, inverseOnSurface = background,
        inversePrimary = if (darkTheme) ink else lerp(primary, Color.White, .55f),
    )
}
