package com.terminalbuddy.android.notifications

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import com.terminalbuddy.android.TerminalBuddyApplication
import kotlinx.coroutines.*
import java.util.concurrent.TimeUnit

/** 仅在有运行中或等待决策的任务时驻留；服务端任务不依赖 Activity 生命周期。 */
class AiTaskMonitorService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val taskApplication get() = applicationContext as TerminalBuddyApplication
    private val notifications get() = taskApplication.taskNotifications
    private var foregroundStarted = false
    private var polling: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        foregroundStarted = runCatching {
            ServiceCompat.startForeground(
                this, AiTaskNotifications.MONITOR_ID, notifications.monitoringNotification(),
                if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
            )
        }.isSuccess
        if (!foregroundStarted) {
            notifications.suspendMonitoring()
            stopSelf()
            return
        }
        notifications.serviceRunning = true
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TerminalBuddy:AiTaskMonitor")
            .apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundStarted) return START_NOT_STICKY
        if (polling?.isActive != true) polling = scope.launch {
            var failures = 0
            while (isActive) {
                notifications.syncAccounts()
                if (notifications.monitoredAccounts().isEmpty()) break
                // 有任务时维持网络同步；分段超时保护保证异常退出也不会永久持锁。
                wakeLock?.let { if (!it.isHeld) it.acquire(TimeUnit.MINUTES.toMillis(10)) }
                val success = syncTaskNotifications(taskApplication, activeOnly = true)
                if (notifications.monitoredAccounts().isEmpty()) break
                failures = if (success) 0 else (failures + 1).coerceAtMost(4)
                getSystemService(android.app.NotificationManager::class.java).notify(
                    AiTaskNotifications.MONITOR_ID, notifications.monitoringNotification(reconnecting = !success),
                )
                delay(if (success) 3_000 else (3_000L shl failures).coerceAtMost(60_000))
            }
            stopSelf()
        }
        return START_STICKY
    }

    /** Android 15+ 限制 dataSync 前台服务时长；停止驻留后继续由定时任务补偿。 */
    override fun onTimeout(startId: Int, fgsType: Int) {
        notifications.suspendMonitoring()
        polling?.cancel()
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
        notifications.monitorStopped()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
