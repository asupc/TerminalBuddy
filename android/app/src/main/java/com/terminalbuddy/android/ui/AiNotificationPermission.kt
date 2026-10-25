package com.terminalbuddy.android.ui

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.terminalbuddy.android.notifications.AiTaskNotifications

/** 请求通知权限，并在决策提醒降级或静音时提供对应渠道的设置入口。 */
@Composable
internal fun AiNotificationPermission() {
    val context = LocalContext.current
    val preferences = remember(context) { context.getSharedPreferences("terminal_buddy_notifications", Context.MODE_PRIVATE) }
    var enabled by remember { mutableStateOf(AiTaskNotifications.notificationsEnabled(context)) }
    var decisionAlerts by remember { mutableStateOf(AiTaskNotifications.decisionAlertsEnabled(context)) }
    fun refreshSettings() {
        enabled = AiTaskNotifications.notificationsEnabled(context)
        decisionAlerts = AiTaskNotifications.decisionAlertsEnabled(context)
    }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refreshSettings() }
    LifecycleResumeEffect(Unit) {
        refreshSettings()
        onPauseOrDispose { }
    }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && !enabled && !preferences.getBoolean("permission_requested", false)) {
            preferences.edit().putBoolean("permission_requested", true).apply()
            request.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    if (!enabled || !decisionAlerts) Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (enabled) "开启决策悬浮提醒，切换应用也能及时处理" else "开启通知，接收任务决策和完成提醒",
            Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
        TextButton({
            if (enabled) AiTaskNotifications.openDecisionSettings(context) else AiTaskNotifications.openSettings(context)
        }) { Text(if (enabled) "设置提醒" else "开启通知") }
    }
}
