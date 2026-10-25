package com.terminalbuddy.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.BatteryFull
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.terminalbuddy.android.notifications.AiTaskNotifications

/** 将通知权限、任务提醒和后台运行入口集中在同一个面板，返回系统设置后刷新状态。 */
@Composable
internal fun AiNotificationSettings(dismiss: () -> Unit) {
    val context = LocalContext.current
    var enabled by remember { mutableStateOf(AiTaskNotifications.notificationsEnabled(context)) }
    var decisionAlerts by remember { mutableStateOf(AiTaskNotifications.decisionAlertsEnabled(context)) }
    var resultAlerts by remember { mutableStateOf(AiTaskNotifications.resultAlertsEnabled(context)) }
    var backgroundRestricted by remember { mutableStateOf(AiTaskNotifications.backgroundRestricted(context)) }
    LifecycleResumeEffect(Unit) {
        enabled = AiTaskNotifications.notificationsEnabled(context)
        decisionAlerts = AiTaskNotifications.decisionAlertsEnabled(context)
        resultAlerts = AiTaskNotifications.resultAlertsEnabled(context)
        backgroundRestricted = AiTaskNotifications.backgroundRestricted(context)
        onPauseOrDispose { }
    }
    AiSheet("通知设置", dismiss) {
        Column(
            Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            AiNotificationSettingRow(
                Icons.Outlined.Notifications, "应用通知",
                if (enabled) "已开启 · 管理通知权限、声音和振动" else "未开启 · 允许接收任务提醒",
            ) { AiTaskNotifications.openSettings(context) }
            AiNotificationSettingRow(
                Icons.Outlined.NotificationsActive, "决策横幅通知",
                when {
                    !enabled -> "需先开启应用通知 · 需要选择、回答或授权时提醒"
                    decisionAlerts -> "已启用提醒 · 管理声音、振动和横幅"
                    else -> "设置声音、振动和横幅，及时处理待办决策"
                },
            ) { AiTaskNotifications.openDecisionSettings(context) }
            AiNotificationSettingRow(
                Icons.Outlined.TaskAlt, "结束横幅通知",
                when {
                    !enabled -> "需先开启应用通知 · 任务完成、失败或中断时提醒"
                    resultAlerts -> "已启用提醒 · 管理声音、振动和横幅"
                    else -> "设置声音、振动和横幅，及时查看任务结果"
                },
            ) { AiTaskNotifications.openResultSettings(context) }
            AiNotificationSettingRow(
                Icons.Outlined.BatteryFull, "后台运行设置",
                if (backgroundRestricted) "后台运行受限 · 允许后台运行，减少提醒延迟" else "已允许后台运行 · 管理应用电池设置",
            ) { AiTaskNotifications.openBackgroundSettings(context) }
        }
    }
}

@Composable
private fun AiNotificationSettingRow(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    Surface(onClick = onClick, color = TbColors.Surface, shape = RoundedCornerShape(10.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AiSmallIcon(icon)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = TbColors.TextMuted)
        }
    }
}
