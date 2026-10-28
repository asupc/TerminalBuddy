package com.terminalbuddy.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Sync
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.terminalbuddy.android.TerminalBuddyApplication
import com.terminalbuddy.android.notifications.AiBackgroundCompatibility
import com.terminalbuddy.android.notifications.AiTaskNotifications

/** 将通知权限、任务提醒和后台运行入口集中在同一个面板，返回系统设置后刷新状态。 */
@Composable
internal fun AiNotificationSettings(dismiss: () -> Unit) {
    val context = LocalContext.current
    val notifications = remember(context) { (context.applicationContext as TerminalBuddyApplication).taskNotifications }
    val monitor by notifications.monitorState.collectAsStateWithLifecycle()
    val service by notifications.serviceState.collectAsStateWithLifecycle()
    val reception by notifications.backgroundReception.collectAsStateWithLifecycle()
    val isVivo = remember { AiBackgroundCompatibility.isVivoDevice() }
    var showVivoGuide by remember { mutableStateOf(false) }
    val vivoGuideChecked by notifications.vivoGuideChecked.collectAsStateWithLifecycle()
    var copied by remember { mutableStateOf(false) }
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
                Icons.Outlined.Sync, "后台消息接收",
                when {
                    !monitor.active -> "登录后开启后台消息接收"
                    service.error != null -> "${service.error} · 点击重试"
                    service.starting -> "正在启动后台接收服务"
                    !service.running -> "后台接收服务未运行 · 点击重试"
                    monitor.networkBlocked -> "系统正在限制后台网络，请允许后台联网"
                    monitor.pollingFallback -> "服务运行中 · 正在通过后台同步接收"
                    monitor.reconnecting -> "服务运行中 · 正在恢复消息连接"
                    else -> "服务运行中 · 消息连接正常"
                },
            ) { notifications.retryMonitoring() }
            AiNotificationSettingRow(
                Icons.Outlined.BatteryFull, if (isVivo) "vivo 后台运行设置" else "后台运行设置",
                when {
                    isVivo && backgroundRestricted -> "检查电池优化、后台耗电和自启动设置"
                    isVivo && !vivoGuideChecked -> "仍需检查 vivo 后台耗电和自启动设置"
                    isVivo -> "已检查设置指引 · 后台接收仍需实际验证"
                    backgroundRestricted -> "后台运行受限 · 请允许后台运行和自启动"
                    else -> "系统电池限制已解除 · 持续接收消息会增加耗电"
                },
            ) {
                if (isVivo) showVivoGuide = true else AiTaskNotifications.openBackgroundSettings(context)
            }
            if (isVivo) AiNotificationSettingRow(
                Icons.Outlined.Sync, "上次后台接收记录",
                when {
                    !reception.checked -> "尚无记录 · 在后台运行至少90秒后返回查看"
                    reception.interrupted -> "约${reception.receptionGapMillis / 1000}秒没有状态更新 · 请检查后台设置"
                    else -> "返回前台前收到过状态 · 请确认实际任务提醒是否及时"
                },
            ) { showVivoGuide = true }
            AiNotificationSettingRow(
                Icons.Outlined.ContentCopy, if (copied) "已复制通知诊断" else "复制通知诊断",
                "复制服务、网络和最近通知记录，帮助排查后台延迟；不包含凭据和对话内容",
            ) {
                context.getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText("Terminal Buddy 通知诊断", notifications.diagnosticReport()))
                copied = true
            }
        }
    }
    if (showVivoGuide) AiVivoBackgroundGuide {
        showVivoGuide = false
        backgroundRestricted = AiTaskNotifications.backgroundRestricted(context)
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
