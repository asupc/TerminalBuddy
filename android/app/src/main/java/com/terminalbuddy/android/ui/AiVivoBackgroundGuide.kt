package com.terminalbuddy.android.ui

import android.os.PowerManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.terminalbuddy.android.TerminalBuddyApplication
import com.terminalbuddy.android.notifications.AiBackgroundCompatibility
import com.terminalbuddy.android.notifications.AiBackgroundSettingsResult

/** 专用引导只在用户操作时打开设置；确认仅记录已检查，不伪造厂商授权结果。 */
@Composable
internal fun AiVivoBackgroundGuide(dismiss: () -> Unit) {
    val context = LocalContext.current
    val notifications = remember(context) { (context.applicationContext as TerminalBuddyApplication).taskNotifications }
    var batteryExempt by remember { mutableStateOf(
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
    ) }
    var settingsMessage by remember { mutableStateOf<String?>(null) }
    fun record(result: AiBackgroundSettingsResult) {
        settingsMessage = result.message
        notifications.recordDiagnostic("vivo 设置引导：打开成功=${result.opened}，${result.message}")
    }
    LifecycleResumeEffect(Unit) {
        batteryExempt = context.getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(context.packageName)
        onPauseOrDispose { }
    }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("vivo 后台运行设置") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("vivo / iQOO 的后台管理可能暂停消息接收，请分别检查以下设置。")
                Text("1. 后台耗电", style = MaterialTheme.typography.titleSmall)
                Text("进入电池 → 后台耗电管理，找到 TerminalBuddy，选择允许后台高耗电。不同系统版本的名称可能略有差异。")
                OutlinedButton(
                    onClick = { record(AiBackgroundCompatibility.openPowerSettings(context)) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("打开电池设置") }
                Text("2. 自启动和关联启动", style = MaterialTheme.typography.titleSmall)
                Text("在自启动管理中允许 TerminalBuddy；如有单独的关联启动或后台启动选项，也请允许。")
                OutlinedButton(
                    onClick = { record(AiBackgroundCompatibility.openVivoAutoStart(context)) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("打开自启动管理") }
                Text("3. 最近任务保留", style = MaterialTheme.typography.titleSmall)
                Text("在最近任务中锁定 TerminalBuddy，避免一键清理时结束后台接收。")
                Text("系统电池优化：${if (batteryExempt) "已豁免" else "尚未豁免"}", style = MaterialTheme.typography.titleSmall)
                if (!batteryExempt) OutlinedButton(
                    onClick = { record(AiBackgroundCompatibility.openBatteryOptimizationSettings(context)) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("申请电池优化豁免") }
                Text("电池优化豁免与 vivo 后台设置需要分别检查。完成后请让任务在后台结束，确认能及时收到提醒。", style = MaterialTheme.typography.bodySmall)
                settingsMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                notifications.markVivoGuideChecked()
                dismiss()
            }) { Text("我已检查") }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("稍后设置") } },
    )
}
