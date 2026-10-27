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
import kotlinx.coroutines.flow.collect
import java.util.concurrent.TimeUnit

/** 长期直连消息接收不使用有六小时后台配额的 dataSync 服务。 */
class AiTaskMonitorService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val notifications get() = (applicationContext as TerminalBuddyApplication).taskNotifications
    private var foregroundStarted = false
    private var watching: Job? = null
    private var healthCheck: Job? = null
    private var keepAwake: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        foregroundStarted = runCatching {
            ServiceCompat.startForeground(
                this, AiTaskNotifications.MONITOR_ID, notifications.monitoringNotification(),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
            )
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TerminalBuddy:AiTaskMonitor")
                .apply { setReferenceCounted(false); acquire(TimeUnit.MINUTES.toMillis(10)) }
        }.onFailure { notifications.monitorFailed(it) }.isSuccess
        if (!foregroundStarted) {
            stopSelf()
            return
        }
        // 只有 startForeground 真正成功后才能标记服务运行。
        notifications.monitorStarted()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundStarted) return START_NOT_STICKY
        if (watching?.isActive != true) watching = scope.launch {
            notifications.monitorState.collect { state ->
                if (!state.active) {
                    stopSelf()
                } else {
                    runCatching {
                        getSystemService(android.app.NotificationManager::class.java).notify(
                            AiTaskNotifications.MONITOR_ID,
                            notifications.monitoringNotification(state.reconnecting, state.tasksRunning, state.pollingFallback),
                        )
                    }.onFailure { notifications.recordDiagnostic("更新常驻通知失败：${it.javaClass.simpleName}") }
                }
            }
        }
        if (healthCheck?.isActive != true) healthCheck = scope.launch {
            while (isActive) {
                notifications.refreshMonitoring()
                delay(5_000)
            }
        }
        if (keepAwake?.isActive != true) keepAwake = scope.launch {
            while (isActive) {
                // 空闲期间也必须接收新任务，不能等收到了 running 才唤醒接收线程。
                // 超时锁配合续期，服务退出释放；Doze 网络访问仍需用户允许后台运行。
                wakeLock?.acquire(TimeUnit.MINUTES.toMillis(10))
                delay(TimeUnit.MINUTES.toMillis(9))
            }
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        notifications.recordDiagnostic("应用从最近任务划走，前台接收服务继续运行")
        super.onTaskRemoved(rootIntent)
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        notifications.monitorFailed(IllegalStateException(), "系统限制后台服务运行时间")
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        notifications.monitorStopped()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
