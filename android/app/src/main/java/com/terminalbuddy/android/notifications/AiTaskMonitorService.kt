package com.terminalbuddy.android.notifications

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import com.terminalbuddy.android.TerminalBuddyApplication
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import java.util.concurrent.TimeUnit

/** 只负责运行任务的进程保活，实时接收与摘要补偿由 Application 持有。 */
class AiTaskMonitorService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val notifications get() = (applicationContext as TerminalBuddyApplication).taskNotifications
    private var foregroundStarted = false
    private var watching: Job? = null
    private var keepAwake: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        foregroundStarted = runCatching {
            ServiceCompat.startForeground(
                this, AiTaskNotifications.MONITOR_ID, notifications.monitoringNotification(),
                if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
            )
        }.onFailure { Log.w("AiTaskMonitorService", "系统未允许任务后台保活", it) }.isSuccess
        if (!foregroundStarted) {
            notifications.suspendMonitoring()
            stopSelf()
            return
        }
        notifications.monitorStarted()
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TerminalBuddy:AiTaskMonitor")
            .apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundStarted) return START_NOT_STICKY
        if (watching?.isActive != true) watching = scope.launch {
            notifications.monitorState.collect { state ->
                if (!state.active) {
                    stopSelf()
                } else {
                    // 仅连接状态变化时更新常驻提示，避免周期更新干扰决策横幅。
                    runCatching {
                        getSystemService(android.app.NotificationManager::class.java).notify(
                            AiTaskNotifications.MONITOR_ID, notifications.monitoringNotification(state.reconnecting),
                        )
                    }.onFailure { Log.w("AiTaskMonitorService", "更新任务监听通知失败", it) }
                }
            }
        }
        if (keepAwake?.isActive != true) keepAwake = scope.launch {
            while (isActive) {
                // 分段超时保护，锁屏期间也让实时连接与重连协程继续运行。
                wakeLock?.let { it.acquire(TimeUnit.MINUTES.toMillis(10)) }
                delay(TimeUnit.MINUTES.toMillis(9))
            }
        }
        return START_STICKY
    }

    /** Android 15+ 限制 dataSync 前台服务时长；应用存活时仍接收，进程回收后由定时任务补偿。 */
    override fun onTimeout(startId: Int, fgsType: Int) {
        notifications.suspendMonitoring()
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
