package com.terminalbuddy.android

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import com.terminalbuddy.android.notifications.AiNotificationTarget
import com.terminalbuddy.android.notifications.AiTaskNotifications
import com.terminalbuddy.android.ui.AppSkin
import com.terminalbuddy.android.ui.TerminalBuddyRoot
import com.terminalbuddy.android.ui.TerminalBuddyTheme

class MainActivity : ComponentActivity() {
    private var notificationTarget by mutableStateOf<AiNotificationTarget?>(null)

    override fun onResume() {
        super.onResume()
        (application as TerminalBuddyApplication).taskNotifications.setForeground(true)
    }

    override fun onStop() {
        (application as TerminalBuddyApplication).taskNotifications.setForeground(false)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        notificationTarget = AiTaskNotifications.consumeTarget(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        notificationTarget = AiTaskNotifications.consumeTarget(intent)
        val preferences = getSharedPreferences("terminal_buddy_appearance", MODE_PRIVATE)
        val initialDarkTheme = preferences.getBoolean("dark_theme", false)
        val initialSkin = AppSkin.fromId(preferences.getString("color_skin", null))
        updateSystemBars(initialDarkTheme, initialSkin)
        setContent {
            var darkTheme by rememberSaveable { mutableStateOf(initialDarkTheme) }
            var skinId by rememberSaveable { mutableStateOf(initialSkin.id) }
            var simplified by rememberSaveable { mutableStateOf(AppUiMode.isSimple(applicationContext)) }
            val skin = AppSkin.fromId(skinId)
            SideEffect { updateSystemBars(darkTheme, skin) }
            TerminalBuddyTheme(
                darkTheme = darkTheme,
                skin = skin,
                onDarkThemeChange = { enabled ->
                    darkTheme = enabled
                    preferences.edit().putBoolean("dark_theme", enabled).apply()
                },
                onSkinChange = { selected ->
                    skinId = selected.id
                    preferences.edit().putString("color_skin", selected.id).apply()
                },
            ) {
                TerminalBuddyRoot(
                    notificationTarget = notificationTarget,
                    onNotificationConsumed = { notificationTarget = null },
                    simplified = simplified,
                    onSimplifiedChange = { enabled ->
                        simplified = enabled
                        AppUiMode.setSimple(applicationContext, enabled)
                    },
                )
            }
        }
    }

    private fun updateSystemBars(darkTheme: Boolean, skin: AppSkin) {
        val effectiveDarkTheme = skin.isDark(darkTheme)
        val navigationBarScrim = if (skin.fixedDarkTheme == false) {
            AppSkin.PureBlack.colorScheme(true).background
        } else {
            skin.colorScheme(true).background
        }
        enableEdgeToEdge(
            statusBarStyle = if (effectiveDarkTheme) SystemBarStyle.dark(Color.TRANSPARENT)
                else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            // Android 8.0 不支持深色导航图标，浅色模式下用深色底保护白色系统按钮。
            navigationBarStyle = if (effectiveDarkTheme) SystemBarStyle.dark(Color.TRANSPARENT)
                else SystemBarStyle.light(Color.TRANSPARENT, navigationBarScrim.toArgb()),
        )
        window.setBackgroundDrawable(ColorDrawable(
            skin.colorScheme(darkTheme).background.toArgb()
        ))
    }
}
