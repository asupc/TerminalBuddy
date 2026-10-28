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
    val previewColors: List<Color> = emptyList(),
    val diffuseBackground: Boolean = false,
    /** 固定纯色皮肤的明暗状态；其他皮肤继续使用单独保存的外观模式。 */
    val fixedDarkTheme: Boolean? = null,
) {
    PureBlack(
        id = "pure_black", title = "纯黑", description = "固定深色 · 黑色系按钮",
        lightColors = desktopColorScheme(darkTheme = true),
        darkColors = desktopColorScheme(darkTheme = true),
        fixedDarkTheme = true,
    ),

    PureWhite(
        id = "pure_white", title = "纯白", description = "固定浅色 · 黑色系按钮",
        lightColors = desktopColorScheme(darkTheme = false),
        darkColors = desktopColorScheme(darkTheme = false),
        fixedDarkTheme = false,
    ),

    Pine(
        id = "pine", title = "松柏绿", description = "默认配色 · 清爽自然",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFF206C54),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFF6F8F5),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFEEF3E9),
            tint = Color(0xFFE6EFE2),
            text = Color(0xFF243D32),
            muted = lerp(Color(0xFF63746A), Color(0xFF243D32), .08f),
            border = Color(0xFFE3EAE0),
            primaryContainerInk = Color(0xFF194F3E),
            secondary = Color(0xFF557C46),
            secondarySoft = Color(0xFFE8F0E1),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFF95D3B2),
            ink = Color(0xFF102D1F),
            background = Color(0xFF101C16),
            surface = Color(0xFF192A20),
            field = Color(0xFF24392B),
            tint = Color(0xFF294532),
            text = Color(0xFFEEF5EA),
            muted = Color(0xFFA9BEAB),
            border = Color(0xFF344E3B),
            secondary = Color(0xFFBDD598),
            secondarySoft = Color(0xFF33452B),
        ),
        previewColors = listOf(Color(0xFF206C54), Color(0xFFD5E9B8), Color(0xFFE6EFE2)),
    ),

    SeaSalt(
        id = "sea_salt", title = "海盐蓝绿", description = "晴空蓝 · 薄荷绿 · 湖水青",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFF3562BD),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFF4F9FC),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFECF3F9),
            tint = Color(0xFFE2ECFC),
            text = Color(0xFF223B50),
            muted = Color(0xFF596E7B),
            border = Color(0xFFDCE8EF),
            primaryContainerInk = Color(0xFF254681),
            secondary = Color(0xFF247785),
            secondarySoft = Color(0xFFDCF1ED),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFF9BB7FF),
            ink = Color(0xFF112342),
            background = Color(0xFF0E1B27),
            surface = Color(0xFF142B36),
            field = Color(0xFF1F3842),
            tint = Color(0xFF253D60),
            text = Color(0xFFEAF5F8),
            muted = Color(0xFFB0C5CF),
            border = Color(0xFF304C5B),
            secondary = Color(0xFF83D7CC),
            secondarySoft = Color(0xFF173F40),
        ),
        previewColors = listOf(Color(0xFF598BFD), Color(0xFF9AD4CB), Color(0xFF35B3C9)),
        diffuseBackground = true,
    ),

    Sunset(
        id = "sunset", title = "落霞紫粉", description = "柔雾紫 · 樱花粉 · 蜜桃白",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFF7742C2),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFFBF6FC),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFF5ECF8),
            tint = Color(0xFFEEE3FC),
            text = Color(0xFF43314E),
            muted = Color(0xFF76617D),
            border = Color(0xFFEBDFEE),
            primaryContainerInk = Color(0xFF57308C),
            secondary = Color(0xFFA44870),
            secondarySoft = Color(0xFFFBE3EC),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFFC8A6FA),
            ink = Color(0xFF2D1648),
            background = Color(0xFF211529),
            surface = Color(0xFF302037),
            field = Color(0xFF402A48),
            tint = Color(0xFF493057),
            text = Color(0xFFFAEDFA),
            muted = Color(0xFFCAB2CF),
            border = Color(0xFF573D61),
            secondary = Color(0xFFF4A9C6),
            secondarySoft = Color(0xFF532B43),
        ),
        previewColors = listOf(Color(0xFF945FFA), Color(0xFFF698B8), Color(0xFFF7DFD9)),
        diffuseBackground = true,
    ),

    Blossom(
        id = "blossom", title = "奶油花漾", description = "淡丁香 · 奶油黄 · 玫瑰粉",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFF74609E),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFFCF9F4),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFF5EEF3),
            tint = Color(0xFFEEE7F8),
            text = Color(0xFF493B4C),
            muted = lerp(Color(0xFF786A76), Color(0xFF493B4C), .08f),
            border = Color(0xFFECE2E7),
            primaryContainerInk = Color(0xFF51416F),
            secondary = Color(0xFF946123),
            secondarySoft = Color(0xFFFFEFCD),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFFD2BFEF),
            ink = Color(0xFF30223F),
            background = Color(0xFF211B23),
            surface = Color(0xFF312935),
            field = Color(0xFF433648),
            tint = Color(0xFF4B395C),
            text = Color(0xFFFAF1F6),
            muted = Color(0xFFCDBDCA),
            border = Color(0xFF58485D),
            secondary = Color(0xFFF1D18B),
            secondarySoft = Color(0xFF4C3E28),
        ),
        previewColors = listOf(Color(0xFFBBADE6), Color(0xFFFEC96D), Color(0xFFE2ADB4)),
        diffuseBackground = true,
    ),

    Coral(
        id = "coral", title = "珊瑚暖阳", description = "珊瑚橘 · 杏桃粉 · 香草奶油",
        lightColors = skinColorScheme(
            darkTheme = false,
            primary = Color(0xFFAC503D),
            ink = Color(0xFFFFFFFF),
            background = Color(0xFFFFF8F3),
            surface = Color(0xFFFFFFFF),
            field = Color(0xFFFBEEE7),
            tint = Color(0xFFFBE5DC),
            text = Color(0xFF50382F),
            muted = lerp(Color(0xFF806A60), Color(0xFF50382F), .08f),
            border = Color(0xFFF0E1D8),
            primaryContainerInk = Color(0xFF7C382B),
            secondary = Color(0xFF896529),
            secondarySoft = Color(0xFFFBF1D7),
        ),
        darkColors = skinColorScheme(
            darkTheme = true,
            primary = Color(0xFFF4B09A),
            ink = Color(0xFF3D2019),
            background = Color(0xFF281B16),
            surface = Color(0xFF39281F),
            field = Color(0xFF4A352B),
            tint = Color(0xFF56392E),
            text = Color(0xFFFCEFE3),
            muted = Color(0xFFD4BBAA),
            border = Color(0xFF654B3C),
            secondary = Color(0xFFF1DAA0),
            secondarySoft = Color(0xFF4A4028),
        ),
        previewColors = listOf(Color(0xFFEC826C), Color(0xFFEAB4A6), Color(0xFFFFFADE)),
        diffuseBackground = true,
    ),

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

    fun isDark(darkTheme: Boolean): Boolean = fixedDarkTheme ?: darkTheme

    fun colorScheme(darkTheme: Boolean): ColorScheme = if (isDark(darkTheme)) darkPalette else lightColors

    companion object {
        /** 未保存或无效的皮肤标识回退到默认松柏绿。 */
        fun fromId(id: String?): AppSkin = entries.firstOrNull { it.id == id } ?: Pine
    }
}

/** 纯黑画布搭配深色面板；强调文字保持可读，实心控件使用独立的黑色填充。 */
private fun desktopColorScheme(darkTheme: Boolean): ColorScheme {
    val primary = if (darkTheme) Color(0xFFE3E5E8) else Color(0xFF111111)
    val background = if (darkTheme) Color.Black else Color(0xFFF3F4F6)
    val surface = if (darkTheme) Color(0xFF202226) else Color(0xFFFFFFFF)
    return skinColorScheme(
        darkTheme = darkTheme,
        primary = primary,
        ink = if (darkTheme) Color(0xFF181A1D) else Color.White,
        background = background,
        surface = surface,
        field = if (darkTheme) Color(0xFF2A2D31) else Color(0xFFE9EBEE),
        tint = if (darkTheme) lerp(background, primary, .17f) else lerp(surface, primary, .11f),
        text = if (darkTheme) Color(0xFFE3E5E8) else Color(0xFF24272C),
        muted = if (darkTheme) Color(0xFF9AA0A8) else Color(0xFF626870),
        border = if (darkTheme) Color(0xFF34383D) else Color(0xFFD6D9DE),
        primaryContainerInk = if (darkTheme) Color(0xFFE3E5E8) else Color(0xFF363A40),
    ).copy(
        outline = if (darkTheme) Color(0xFF6F767F) else Color(0xFF8A9098),
        surfaceContainerHigh = if (darkTheme) Color(0xFF25282C) else Color(0xFFFFFFFF),
        surfaceContainerHighest = if (darkTheme) Color(0xFF292C30) else Color(0xFFEDF0F3),
        surfaceTint = Color.Transparent,
        tertiary = if (darkTheme) Color(0xFFD9A441) else Color(0xFF9A6B12),
        error = if (darkTheme) Color(0xFFEF6B73) else Color(0xFFC9434D),
    )
}

/** 补齐 Material 语义色，确保正文、弹层、选中态和背景使用同一套皮肤。 */
private fun skinColorScheme(
    darkTheme: Boolean, primary: Color, ink: Color, background: Color, surface: Color,
    field: Color, tint: Color, text: Color, muted: Color, border: Color,
    primaryContainerInk: Color = primary, secondary: Color = primary, secondarySoft: Color = tint,
): ColorScheme {
    val base = if (darkTheme) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = primary, onPrimary = ink,
        primaryFixed = tint, primaryFixedDim = lerp(tint, primary, .08f),
        onPrimaryFixed = text, onPrimaryFixedVariant = text,
        secondaryFixed = secondarySoft, secondaryFixedDim = lerp(secondarySoft, secondary, .08f),
        onSecondaryFixed = text, onSecondaryFixedVariant = text,
        tertiaryFixed = Color(0xFFFFEECF), tertiaryFixedDim = Color(0xFFF4D9A2),
        onTertiaryFixed = Color(0xFF513600), onTertiaryFixedVariant = Color(0xFF825B18),
        primaryContainer = tint, onPrimaryContainer = primaryContainerInk,
        secondary = secondary, onSecondary = ink,
        secondaryContainer = secondarySoft, onSecondaryContainer = text,
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
