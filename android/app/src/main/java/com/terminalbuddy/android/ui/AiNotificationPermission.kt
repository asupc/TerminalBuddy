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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.terminalbuddy.android.TerminalBuddyApplication
import com.terminalbuddy.android.notifications.AiBackgroundCompatibility
import com.terminalbuddy.android.notifications.AiTaskNotifications

/** 首页与对话页都可处理通知和后台运行权限，返回系统设置时刷新实际状态。 */
@Composable
internal fun AiNotificationPermission() {
    val context = LocalContext.current
    val preferences = remember(context) { context.getSharedPreferences("terminal_buddy_notifications", Context.MODE_PRIVATE) }
    var enabled by remember { mutableStateOf(AiTaskNotifications.notificationsEnabled(context)) }
    var decisionAlerts by remember { mutableStateOf(AiTaskNotifications.decisionAlertsEnabled(context)) }
    var resultAlerts by remember { mutableStateOf(AiTaskNotifications.resultAlertsEnabled(context)) }
    var backgroundRestricted by remember { mutableStateOf(AiTaskNotifications.backgroundRestricted(context)) }
    val notifications = remember(context) { (context.applicationContext as TerminalBuddyApplication).taskNotifications }
    val monitor by notifications.monitorState.collectAsStateWithLifecycle()
    val service by notifications.serviceState.collectAsStateWithLifecycle()
    val reception by notifications.backgroundReception.collectAsStateWithLifecycle()
    val isVivo = remember { AiBackgroundCompatibility.isVivoDevice() }
    var showVivoGuide by remember { mutableStateOf(false) }
    val vivoGuideChecked by notifications.vivoGuideChecked.collectAsStateWithLifecycle()
    fun refreshSettings() {
        enabled = AiTaskNotifications.notificationsEnabled(context)
        decisionAlerts = AiTaskNotifications.decisionAlertsEnabled(context)
        resultAlerts = AiTaskNotifications.resultAlertsEnabled(context)
        backgroundRestricted = AiTaskNotifications.backgroundRestricted(context)
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
    if (!enabled || !decisionAlerts || !resultAlerts) Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(when {
            !enabled -> "开启通知，接收任务决策和结束横幅"
            !decisionAlerts -> "开启决策横幅，切换应用也能及时处理"
            else -> "开启结束横幅，任务完成后及时提醒"
        }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
        TextButton({
            when {
                !enabled -> AiTaskNotifications.openSettings(context)
                !decisionAlerts -> AiTaskNotifications.openDecisionSettings(context)
                else -> AiTaskNotifications.openResultSettings(context)
            }
        }) { Text(if (enabled) "设置横幅" else "开启通知") }
    }
    if (enabled && monitor.active && !service.running && !service.starting) Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("后台接收服务未运行，切换应用后提醒可能延迟", Modifier.weight(1f),
            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
        TextButton({ notifications.retryMonitoring() }) { Text("重试接收") }
    }
    val vivoNeedsAttention = isVivo && (!vivoGuideChecked || reception.interrupted)
    if (enabled && monitor.active && (backgroundRestricted || vivoNeedsAttention)) Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(when {
            isVivo && reception.interrupted -> "上次后台长时间未收到状态，请检查 vivo 后台设置"
            isVivo -> "检查 vivo 后台耗电和自启动设置，减少提醒延迟"
            else -> "允许后台运行，避免切换应用后提醒延迟"
        }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
        TextButton({
            if (isVivo) showVivoGuide = true else AiTaskNotifications.openBackgroundSettings(context)
        }) { Text(if (isVivo) "后台设置" else "允许后台") }
    }
    if (showVivoGuide) AiVivoBackgroundGuide {
        showVivoGuide = false
        refreshSettings()
    }
}
