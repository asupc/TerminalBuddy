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
import com.terminalbuddy.android.notifications.AiNotificationTarget
import com.terminalbuddy.android.notifications.AiTaskNotifications
import com.terminalbuddy.android.ui.TerminalBuddyRoot
import com.terminalbuddy.android.ui.TerminalBuddyTheme

class MainActivity : ComponentActivity() {
    private var notificationTarget by mutableStateOf<AiNotificationTarget?>(null)

    override fun onStart() {
        super.onStart()
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
        updateSystemBars(initialDarkTheme)
        setContent {
            var darkTheme by rememberSaveable { mutableStateOf(initialDarkTheme) }
            SideEffect { updateSystemBars(darkTheme) }
            TerminalBuddyTheme(
                darkTheme = darkTheme,
                onDarkThemeChange = { enabled ->
                    darkTheme = enabled
                    preferences.edit().putBoolean("dark_theme", enabled).apply()
                },
            ) {
                TerminalBuddyRoot(
                    notificationTarget = notificationTarget,
                    onNotificationConsumed = { notificationTarget = null },
                )
            }
        }
    }

    private fun updateSystemBars(darkTheme: Boolean) {
        enableEdgeToEdge(
            statusBarStyle = if (darkTheme) SystemBarStyle.dark(Color.TRANSPARENT)
                else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            // Android 8.0 不支持深色导航图标，浅色模式下用深色底保护白色系统按钮。
            navigationBarStyle = if (darkTheme) SystemBarStyle.dark(Color.TRANSPARENT)
                else SystemBarStyle.light(Color.TRANSPARENT, Color.rgb(16, 20, 21)),
        )
        window.setBackgroundDrawable(ColorDrawable(
            if (darkTheme) Color.rgb(12, 15, 16) else Color.rgb(245, 247, 246)
        ))
    }
}
