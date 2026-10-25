package com.terminalbuddy.android.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.terminalbuddy.android.MainActivity
import com.terminalbuddy.android.R
import com.terminalbuddy.android.data.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.concurrent.TimeUnit

/** 通知只携带账号 ID 和会话 ID，凭据始终从本机加密存储读取。 */
data class AiNotificationTarget(val accountId: String, val sessionId: String)

/** 所有入口在主线程串行合并，前台实时流、后台服务和补偿任务共用一份事件基线。 */
class AiTaskNotifications(private val context: Context, private val repository: AiRepository) {
    @Serializable
    private data class Snapshot(
        val revision: Long, val status: String, val approvals: Set<String> = emptySet(),
        val submittedAt: Long = 0,
    ) {
        val active get() = status in setOf("running", "background", "approval", "stopping")
    }

    private val preferences = context.getSharedPreferences("terminal_buddy_notifications", Context.MODE_PRIVATE)
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val snapshots = runCatching {
        ApiJson.decodeFromString<Map<String, Map<String, Snapshot>>>(preferences.getString("snapshots", "{}").orEmpty())
            .mapValues { (_, value) -> value.toMutableMap() }.toMutableMap()
    }.getOrDefault(mutableMapOf())
    private var foreground = false
    private var monitoringSuspended = false
    internal var serviceRunning = false
    private var workScheduled = false

    fun initialize() {
        manager.createNotificationChannels(listOf(
            decisionChannel(),
            NotificationChannel(RESULT_CHANNEL, "任务结果", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "AI 任务完成、失败或中断时提醒"
            },
            NotificationChannel(MONITOR_CHANNEL, "任务后台监听", NotificationManager.IMPORTANCE_LOW).apply {
                description = "任务执行期间保持后台同步，以便及时接收提醒"
                setShowBadge(false)
            },
        ))
        syncAccounts()
    }

    private fun decisionChannel(): NotificationChannel {
        manager.getNotificationChannel(DECISION_CHANNEL)?.let { return it }
        // 已创建渠道的声音、振动和重要性不能由应用升级覆盖，使用新版渠道应用提醒配置。
        val previous = manager.getNotificationChannel(LEGACY_DECISION_CHANNEL)
        val importance = if (previous != null && (previous.importance == NotificationManager.IMPORTANCE_NONE ||
                (Build.VERSION.SDK_INT >= 29 && previous.hasUserSetImportance()))) previous.importance
            else NotificationManager.IMPORTANCE_HIGH
        return NotificationChannel(DECISION_CHANNEL, "任务决策悬浮提醒", importance).apply {
            description = "AI 需要选择、回答或授权时，通过声音、振动和悬浮横幅及时提醒"
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 300, 150, 300)
            // 保留用户明确设置的静音或自定义铃声，避免升级重置个人偏好。
            if (Build.VERSION.SDK_INT >= 30 && previous?.hasUserSetSound() == true) {
                setSound(previous.sound, previous.audioAttributes)
            }
        }
    }

    fun setForeground(active: Boolean) {
        foreground = active
        if (active) {
            monitoringSuspended = false
            syncAccounts()
            ensureMonitoring()
        }
    }

    /** 登出只停止对应账号的监听；切换账号保留原账号正在执行的任务。 */
    fun syncAccounts() {
        val valid = repository.accounts.accounts.filter { it.loggedIn }.mapTo(mutableSetOf()) { it.id }
        snapshots.keys.toList().filterNot { it in valid }.forEach(::removeAccount)
        if (valid.isEmpty()) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
            workScheduled = false
        } else if (!workScheduled) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<AiTaskSyncWorker>(15, TimeUnit.MINUTES).build(),
            )
            workScheduled = true
        }
    }

    /** 在发送前建立运行基线，极短任务也能识别完成，不依赖曾经读到 running。 */
    fun expectTask(accountId: String, session: AiSession) {
        val account = snapshots.getOrPut(accountId) { mutableMapOf() }
        val previous = account[session.id]
        account[session.id] = Snapshot(
            maxOf(previous?.revision ?: 0, session.revision), "running",
            previous?.approvals.orEmpty(), System.currentTimeMillis(),
        )
        cancelEvent(accountId, session.id, decision = false)
        persist()
        ensureMonitoring()
    }

    fun replaceExpectedTask(accountId: String, temporaryId: String, session: AiSession) {
        snapshots[accountId]?.remove(temporaryId)
        expectTask(accountId, session)
    }

    fun observe(
        accountId: String, sessions: List<AiSession>, completeList: Boolean = false,
        knownBeforeRequest: Set<String> = emptySet(),
    ) {
        if (repository.accounts.connection(accountId) == null) return
        val account = snapshots.getOrPut(accountId) { mutableMapOf() }
        var changed = false
        for (session in sessions) {
            if (session.id.startsWith("local-")) continue
            val old = account[session.id]
            // 在途的旧响应不能撤回新事件，也不能把已提醒的任务重新变成运行中。
            if (old != null && session.revision <= old.revision) {
                // 发送明确未生效时释放预先建立的运行基线，不凭空发出完成提醒。
                if (old.submittedAt != 0L && !session.running && session.revision == old.revision &&
                    System.currentTimeMillis() - old.submittedAt > 120_000) {
                    account[session.id] = Snapshot(session.revision, session.status, session.approvals.map { it.id }.toSet())
                    changed = true
                }
                continue
            }
            val approvalIds = session.approvals.mapTo(mutableSetOf()) { it.id }
            if (approvalIds.isNotEmpty() && (old == null || (approvalIds - old.approvals).isNotEmpty())) {
                showEvent(accountId, session, decision = true)
            }
            if (approvalIds.isEmpty()) cancelEvent(accountId, session.id, decision = true)
            if (old?.active == true && !session.running) {
                showEvent(accountId, session, decision = false)
            }
            // 新回合开始后移除上一回合结果，保留各任务相互独立的提醒。
            if (session.running && old?.active != true) cancelEvent(accountId, session.id, decision = false)
            val next = Snapshot(session.revision, session.status, approvalIds)
            account[session.id] = next
            // 流式正文更新不必每个 token 写一次磁盘，只保存事件变化。
            if (old == null || old.status != next.status || old.approvals != next.approvals || old.submittedAt != 0L) changed = true
        }
        if (completeList) {
            val ids = sessions.mapTo(mutableSetOf()) { it.id }
            account.keys.toList().filter { id ->
                id in knownBeforeRequest && id !in ids &&
                    // 首次创建尚未返回真实 ID 时保留监听，保证退后台之前已启动服务。
                    !(id.startsWith("local-") && System.currentTimeMillis() - (account[id]?.submittedAt ?: 0) < 120_000)
            }.forEach { id ->
                account.remove(id)
                cancelSession(accountId, id)
                changed = true
            }
        }
        if (changed) persist()
        ensureMonitoring()
    }

    fun forgetSession(accountId: String, id: String) {
        snapshots[accountId]?.remove(id)
        cancelSession(accountId, id)
        persist()
    }

    fun removeAccount(accountId: String) {
        snapshots.remove(accountId)?.keys?.forEach { cancelSession(accountId, it) }
        persist()
    }

    internal fun knownSessionIds(accountId: String): Set<String> = snapshots[accountId]?.keys?.toSet().orEmpty()

    internal fun monitoredAccounts(): Set<String> = snapshots.filterValues { account -> account.values.any { it.active } }.keys

    internal fun suspendMonitoring() { monitoringSuspended = true }

    internal fun monitorStopped() {
        serviceRunning = false
        ensureMonitoring()
    }

    private fun ensureMonitoring() {
        // Android 12+ 只允许从可见页面启动前台服务；后台恢复由 WorkManager 补偿。
        if (!foreground || monitoringSuspended || serviceRunning || monitoredAccounts().isEmpty()) return
        serviceRunning = true
        runCatching { ContextCompat.startForegroundService(context, Intent(context, AiTaskMonitorService::class.java)) }
            .onFailure {
                serviceRunning = false
                monitoringSuspended = true
            }
    }

    internal fun monitoringNotification(reconnecting: Boolean = false): Notification =
        NotificationCompat.Builder(context, MONITOR_CHANNEL)
            .setSmallIcon(R.drawable.ic_task_notification)
            .setContentTitle("正在监听 AI 任务")
            .setContentText(if (reconnecting) "连接中断，正在重连" else "需要决策或任务结束时会通知你")
            .setContentIntent(PendingIntent.getActivity(context, 0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setOngoing(true).setSilent(true).setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE).build()

    private fun showEvent(accountId: String, session: AiSession, decision: Boolean) {
        if (!notificationsEnabled(context)) return
        val title = if (decision) "需要你决策 · ${session.title}" else when (session.status) {
            "error" -> "任务执行失败 · ${session.title}"
            "interrupted" -> "任务已中断 · ${session.title}"
            else -> "任务已完成 · ${session.title}"
        }
        val text = if (decision) "有 ${session.approvals.size} 项待处理，请点击查看并回复"
            else "点击返回任务，查看执行结果"
        val account = repository.accounts.accounts.find { it.id == accountId }
        val notification = NotificationCompat.Builder(context, if (decision) DECISION_CHANNEL else RESULT_CHANNEL)
            .setSmallIcon(R.drawable.ic_task_notification)
            .setContentTitle(title).setContentText(text)
            .setSubText(listOfNotNull(account?.username, session.providerLabel).joinToString(" · "))
            .setStyle(NotificationCompat.BigTextStyle().bigText("$title\n$text"))
            .setCategory(if (decision) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (decision) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_DEFAULT)
            .apply { if (decision) setDefaults(NotificationCompat.DEFAULT_ALL) }
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(taskIntent(accountId, session.id)).setAutoCancel(true).build()
        // 用户可在调用间隙撤销权限，不能因此中断任务同步。
        runCatching { manager.notify(eventTag(accountId, session.id, decision), EVENT_ID, notification) }
    }

    private fun taskIntent(accountId: String, sessionId: String): PendingIntent = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).apply {
            action = OPEN_TASK
            data = Uri.Builder().scheme("terminalbuddy").authority("task").appendPath(accountId).appendPath(sessionId).build()
            putExtra(ACCOUNT_ID, accountId)
            putExtra(SESSION_ID, sessionId)
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun cancelEvent(accountId: String, id: String, decision: Boolean) {
        manager.cancel(eventTag(accountId, id, decision), EVENT_ID)
    }

    private fun cancelSession(accountId: String, id: String) {
        cancelEvent(accountId, id, true)
        cancelEvent(accountId, id, false)
    }

    private fun eventTag(accountId: String, id: String, decision: Boolean) = "$accountId:$id:${if (decision) "decision" else "result"}"
    private fun persist() { preferences.edit().putString("snapshots", ApiJson.encodeToString(snapshots)).apply() }

    companion object {
        private const val LEGACY_DECISION_CHANNEL = "ai_task_decisions"
        private const val DECISION_CHANNEL = "ai_task_decisions_v2"
        private const val RESULT_CHANNEL = "ai_task_results"
        private const val MONITOR_CHANNEL = "ai_task_monitor"
        private const val WORK_NAME = "ai_task_notification_sync"
        private const val OPEN_TASK = "com.terminalbuddy.android.OPEN_AI_TASK"
        private const val ACCOUNT_ID = "notification_account_id"
        private const val SESSION_ID = "notification_session_id"
        private const val EVENT_ID = 1
        internal const val MONITOR_ID = 1001

        fun consumeTarget(intent: Intent): AiNotificationTarget? {
            if (intent.action != OPEN_TASK) return null
            val account = intent.getStringExtra(ACCOUNT_ID)
            val session = intent.getStringExtra(SESSION_ID)
            intent.action = null
            intent.data = null
            intent.removeExtra(ACCOUNT_ID)
            intent.removeExtra(SESSION_ID)
            return if (!account.isNullOrBlank() && !session.isNullOrBlank()) AiNotificationTarget(account, session) else null
        }

        fun notificationsEnabled(context: Context): Boolean =
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
                NotificationManagerCompat.from(context).areNotificationsEnabled()

        /** 厂商额外的悬浮通知开关无法直接读取，始终提供进入渠道设置的入口。 */
        fun decisionAlertsEnabled(context: Context): Boolean {
            val channel = context.getSystemService(NotificationManager::class.java)
                .getNotificationChannel(DECISION_CHANNEL) ?: return false
            return channel.importance >= NotificationManager.IMPORTANCE_HIGH &&
                (channel.sound != null || channel.shouldVibrate())
        }

        fun openDecisionSettings(context: Context) {
            context.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, DECISION_CHANNEL)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        fun openSettings(context: Context) {
            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
        }
    }
}
