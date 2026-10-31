package com.terminalbuddy.android

import android.content.Context

/** 简版 / 完整版是同一安装包的两种界面模式，选择只在设备本地持久化。 */
object AppUiMode {
    private const val PREFERENCES = "terminal_buddy_ui"
    private const val SIMPLE_MODE = "simple_mode"

    /** 首次安装默认进入简版；已有用户切换后沿用上次选择。 */
    const val DEFAULT_SIMPLE = true

    fun isSimple(context: Context): Boolean = context
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getBoolean(SIMPLE_MODE, DEFAULT_SIMPLE)

    fun setSimple(context: Context, simple: Boolean) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit().putBoolean(SIMPLE_MODE, simple).apply()
    }
}
