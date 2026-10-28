package com.terminalbuddy.android.notifications

import android.Manifest
import android.app.ActivityManager
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
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
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
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.concurrent.TimeUnit

/** 通知只携带账号 ID 和会话 ID，凭据始终从本机加密存储读取。 */
data class AiNotificationTarget(val accountId: String, val sessionId: String)

internal data class AiTaskServiceState(
    val running: Boolean = false, val starting: Boolean = false, val error: String? = null,
)

/** 所有入口在主线程串行合并，前台实时流、后台服务和补偿任务共用一份事件基线。 */
class AiTaskNotifications(private val context: Context, private val repository: AiRepository) {
    @Serializable
    private data class Snapshot(
        val revision: Long, val status: String, val approvals: Set<String> = emptySet(),
        val submittedAt: Long = 0,
        val notifiedApprovals: Set<String> = emptySet(), val resultPending: Boolean = false,
        val resultRevision: Long = 0,
    ) {
        val active get() = status in setOf("running", "background", "approval", "stopping")
    }

    private val preferences = context.getSharedPreferences("terminal_buddy_notifications", Context.MODE_PRIVATE)
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val snapshots = runCatching {
        ApiJson.decodeFromString<Map<String, Map<String, Snapshot>>>(preferences.getString("snapshots", "{}").orEmpty())
            .mapValues { (_, value) -> value.toMutableMap() }.toMutableMap()
    }.getOrDefault(mutableMapOf())
    // 老版本已保存过的账号沿用现有基线；新账号只在收到完整列表后建立基线。
    private val initializedAccounts = preferences.getStringSet("initialized_accounts", snapshots.keys)
        .orEmpty().toMutableSet()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val diagnostics = AiNotificationDiagnostics(context)
    private val mutableServiceState = MutableStateFlow(AiTaskServiceState())
    internal val serviceState = mutableServiceState.asStateFlow()
    private val mutableBackgroundReception = MutableStateFlow(AiBackgroundReceptionState())
    internal val backgroundReception = mutableBackgroundReception.asStateFlow()
    private val mutableVivoGuideChecked = MutableStateFlow(AiBackgroundCompatibility.vivoGuideChecked(context))
    internal val vivoGuideChecked = mutableVivoGuideChecked.asStateFlow()
    private var backgroundStartedAt: Long? = null
    private var serviceStartWatchdog: Job? = null
    private var foreground = false
    private var monitoringSuspended = false
    internal val serviceRunning get() = mutableServiceState.value.running
    private var workScheduled = false
    private val monitor by lazy { AiTaskMonitor(context.applicationContext, repository, this) }
    internal val monitorState get() = monitor.state

    fun initialize() {
        recordDiagnostic("通知进程启动 pid=${Process.myPid()}")
        manager.createNotificationChannels(listOf(
            alertChannel(DECISION_CHANNEL, LEGACY_DECISION_CHANNEL, "任务决策横幅通知",
                "AI 需要选择、回答或授权时，通过声音、振动和横幅提醒"),
            alertChannel(RESULT_CHANNEL, LEGACY_RESULT_CHANNEL, "任务结束横幅通知",
                "AI 任务完成、失败或中断时，通过声音、振动和横幅提醒"),
            NotificationChannel(MONITOR_CHANNEL, "后台任务提醒", NotificationManager.IMPORTANCE_LOW).apply {
                description = "用于后台接收任务决策和执行结果"
                setShowBadge(false)
            },
        ))
        syncAccounts()
    }

    private fun alertChannel(id: String, legacyId: String, title: String, detail: String): NotificationChannel {
        manager.getNotificationChannel(id)?.let { existing ->
            return existing.apply { name = title; description = detail }
        }
        // 已创建渠道的重要性不能升级；新建结果渠道，让旧版的普通通知也能弹出横幅。
        val previous = manager.getNotificationChannel(legacyId)
        val importance = if (previous != null && (previous.importance == NotificationManager.IMPORTANCE_NONE ||
                (Build.VERSION.SDK_INT >= 29 && previous.hasUserSetImportance()))) previous.importance
            else NotificationManager.IMPORTANCE_HIGH
        return NotificationChannel(id, title, importance).apply {
            description = detail
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
        val now = SystemClock.elapsedRealtime()
        // 在前台补拉前判断上次后台接收间隔，避免恢复后的新响应掩盖停收。
        if (active && !foreground) inspectBackgroundReception(now)
        if (!active && foreground) backgroundStartedAt = now
        if (active) backgroundStartedAt = null
        foreground = active
        fun age(time: Long) = if (time == 0L) "尚未成功" else "${(now - time).coerceAtLeast(0) / 1000}秒前"
        // 在前台恢复触发补拉之前保存间隔，避免新响应掩盖此前后台停收的证据。
        recordDiagnostic("${if (active) "应用进入前台" else "应用进入后台"}，服务运行=$serviceRunning，" +
            "最近帧=${age(monitor.lastFrameAt)}，最近同步=${age(monitor.lastSyncAt)}")
        if (active) {
            monitoringSuspended = false
            syncAccounts()
        }
        ensureMonitoring()
        monitor.refreshNow()
    }

    private fun inspectBackgroundReception(now: Long) {
        if (!AiBackgroundCompatibility.isVivoDevice() || monitoredAccounts().isEmpty()) return
        val startedAt = backgroundStartedAt ?: return
        val reception = AiBackgroundReceptionState.afterBackground(
            startedAt, now, maxOf(monitor.lastFrameAt, monitor.lastSyncAt),
        ) ?: return
        mutableBackgroundReception.value = reception
        recordDiagnostic("vivo 后台接收记录：后台=${reception.backgroundMillis / 1000}秒，" +
            "最近状态更新=${reception.receptionGapMillis / 1000}秒前，长时间停收=${reception.interrupted}")
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
        // 登录、退出或切换账号后立即调整监听，不等待页面收到运行中的会话。
        ensureMonitoring()
        monitor.refreshNow()
    }

    /** 在发送前建立运行基线，极短任务也能识别完成，不依赖曾经读到 running。 */
    fun expectTask(accountId: String, session: AiSession) {
        val account = snapshots.getOrPut(accountId) { mutableMapOf() }
        val previous = account[session.id]
        account[session.id] = Snapshot(
            maxOf(previous?.revision ?: 0, session.revision), "running",
            previous?.approvals.orEmpty(), System.currentTimeMillis(), previous?.notifiedApprovals.orEmpty(),
            resultRevision = maxOf(previous?.resultRevision ?: 0, session.resultRevision),
        )
        cancelEvent(accountId, session.id, decision = false)
        persist()
        ensureMonitoring()
        monitor.refreshNow()
    }

    fun replaceExpectedTask(accountId: String, temporaryId: String, session: AiSession) {
        snapshots[accountId]?.remove(temporaryId)
        expectTask(accountId, session)
    }

    fun observe(
        accountId: String, sessions: List<AiSession>, completeList: Boolean = false,
        knownBeforeRequest: Set<String> = emptySet(), accountSnapshot: Boolean = false,
    ) {
        if (repository.accounts.connection(accountId) == null) return
        val account = snapshots.getOrPut(accountId) { mutableMapOf() }
        var changed = false
        for (session in sessions) {
            if (session.id.startsWith("local-")) continue
            val old = account[session.id]
            // 在途的旧响应不能撤回新事件，也不能把已提醒的任务重新变成运行中。
            if (old != null && session.revision < old.revision) continue
            if (old != null && session.revision == old.revision && old.submittedAt != 0L) {
                // 发送明确未生效时释放预先建立的运行基线，不凭空发出完成提醒。
                if (old.submittedAt != 0L && !session.running && session.revision == old.revision &&
                    System.currentTimeMillis() - old.submittedAt > 120_000) {
                    account[session.id] = Snapshot(session.revision, session.status, session.approvals.map { it.id }.toSet(),
                        resultRevision = session.resultRevision)
                    changed = true
                }
                continue
            }
            val approvalIds = session.approvals.mapTo(mutableSetOf()) { it.id }
            var notifiedApprovals = old?.notifiedApprovals.orEmpty().intersect(approvalIds)
            if ((approvalIds - notifiedApprovals).isNotEmpty() && showEvent(accountId, session, decision = true)) {
                notifiedApprovals = approvalIds
            }
            if (approvalIds.isEmpty()) cancelEvent(accountId, session.id, decision = true)
            // 后台断线期间可能错过 running → idle 的整个回合；完成版本仍可补发提醒。
            val missedResult = if (old != null) session.resultRevision > old.resultRevision
                else accountId in initializedAccounts && session.resultRevision > 0
            var resultPending = !session.running && (old?.active == true || old?.resultPending == true || missedResult)
            if (resultPending && showEvent(accountId, session, decision = false)) resultPending = false
            // 新回合开始后移除上一回合结果，保留各任务相互独立的提醒。
            if (session.running && old?.active != true) cancelEvent(accountId, session.id, decision = false)
            val next = Snapshot(session.revision, session.status, approvalIds,
                notifiedApprovals = notifiedApprovals, resultPending = resultPending, resultRevision = session.resultRevision)
            account[session.id] = next
            // 流式正文更新不必每个 token 写一次磁盘，只保存事件变化。
            if (old == null || old.status != next.status || old.approvals != next.approvals || old.submittedAt != 0L ||
                old.notifiedApprovals != next.notifiedApprovals || old.resultPending != next.resultPending ||
                old.resultRevision != next.resultRevision) changed = true
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
        // 首次完整列表只接纳历史；此后新增会话即使整个回合都发生在断线期间也能补报。
        if ((completeList || accountSnapshot) && initializedAccounts.add(accountId)) changed = true
        if (changed) persist()
        ensureMonitoring()
    }

    fun forgetSession(accountId: String, id: String) {
        snapshots[accountId]?.remove(id)
        cancelSession(accountId, id)
        persist()
        ensureMonitoring()
    }

    fun removeAccount(accountId: String) {
        initializedAccounts.remove(accountId)
        snapshots.remove(accountId)?.keys?.forEach { cancelSession(accountId, it) }
        persist()
        ensureMonitoring()
    }

    internal fun knownSessionIds(accountId: String): Set<String> = snapshots[accountId]?.keys?.toSet().orEmpty()

    /** 登录期间持续同步所有账号，空闲或尚未打开的会话也能在后台发现新事件。 */
    internal fun monitoredAccounts(): Set<String> = repository.accounts.accounts.filter { it.loggedIn }.mapTo(mutableSetOf()) { it.id }

    internal fun hasActiveTasks(): Boolean = snapshots.values.any { account -> account.values.any { it.active } }

    internal fun recordDiagnostic(message: String) { diagnostics.record(message) }

    internal fun markVivoGuideChecked() {
        AiBackgroundCompatibility.markVivoGuideChecked(context)
        mutableVivoGuideChecked.value = true
        recordDiagnostic("用户已检查 vivo 设置指引；厂商后台授权仍需实际接收验证")
        retryMonitoring()
    }

    internal fun monitorStarted() {
        serviceStartWatchdog?.cancel()
        serviceStartWatchdog = null
        mutableServiceState.value = AiTaskServiceState(running = true)
        recordDiagnostic("前台接收服务已启动，持续持有接收唤醒锁")
        ensureMonitoring()
    }

    internal fun refreshMonitoring() { ensureMonitoring() }

    internal fun monitorFailed(error: Throwable, reason: String = "后台接收服务启动失败") {
        serviceStartWatchdog?.cancel()
        serviceStartWatchdog = null
        monitoringSuspended = true
        val detail = "$reason（${error.javaClass.simpleName}）"
        mutableServiceState.value = AiTaskServiceState(error = reason)
        recordDiagnostic(detail)
    }

    internal fun monitorStopped() {
        mutableServiceState.value = mutableServiceState.value.copy(running = false, starting = false)
        recordDiagnostic("前台接收服务停止")
        ensureMonitoring()
    }

    internal fun retryMonitoring() {
        if (!foreground) return
        monitoringSuspended = false
        ensureMonitoring()
        monitor.refreshNow()
    }

    internal fun restoreFromSystem(action: String) {
        recordDiagnostic("系统恢复接收服务：${action.substringAfterLast('.')}")
        ensureMonitoring(allowBackgroundStart = true)
    }

    private fun ensureMonitoring(allowBackgroundStart: Boolean = false) {
        // 监听只由 Application 持有；服务从后台被系统重建时也需要先恢复订阅。
        if (foreground || serviceRunning || monitor.running || allowBackgroundStart) monitor.update()
        // 普通入口只从已 Resume 的 Activity 启动；仅系统开机/升级广播允许后台恢复。
        if ((!foreground && !allowBackgroundStart) || monitoringSuspended || serviceRunning ||
            mutableServiceState.value.starting || monitoredAccounts().isEmpty()) return
        mutableServiceState.value = AiTaskServiceState(starting = true)
        recordDiagnostic("申请启动前台接收服务")
        runCatching { ContextCompat.startForegroundService(context, Intent(context, AiTaskMonitorService::class.java)) }
            .onSuccess {
                serviceStartWatchdog = scope.launch {
                    delay(10_000)
                    if (mutableServiceState.value.starting) {
                        monitorFailed(IllegalStateException(), "后台接收服务未响应启动请求")
                    }
                }
            }
            .onFailure { monitorFailed(it) }
    }

    internal fun diagnosticReport(): String {
        val state = monitorState.value
        val service = serviceState.value
        val power = context.getSystemService(PowerManager::class.java)
        val reception = backgroundReception.value
        return buildString {
            appendLine("Terminal Buddy 通知诊断")
            appendLine("设备：${Build.MANUFACTURER} ${Build.MODEL}，Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}")
            appendLine("进程：${Process.myPid()}，应用前台：$foreground，登录账号：${monitoredAccounts().size}")
            appendLine("服务运行：${service.running}，启动中：${service.starting}，错误：${service.error ?: "无"}")
            appendLine("通知权限：${notificationsEnabled(context)}，决策横幅：${decisionAlertsEnabled(context)}，结束横幅：${resultAlertsEnabled(context)}")
            appendLine("标准后台受限：${backgroundRestricted(context)}，电池优化豁免：${power.isIgnoringBatteryOptimizations(context.packageName)}")
            if (AiBackgroundCompatibility.isVivoDevice()) {
                appendLine("vivo 设置指引已检查：${AiBackgroundCompatibility.vivoGuideChecked(context)}；厂商后台授权无法通过公开接口确认")
                appendLine(if (reception.checked) "上次后台=${reception.backgroundMillis / 1000}秒，" +
                    "返回前最近状态更新=${reception.receptionGapMillis / 1000}秒前，长时间停收=${reception.interrupted}"
                    else "上次后台接收记录：尚无持续至少90秒的后台记录")
                appendLine("后台停收不等于已确认冻结，实际任务通知仍需在手机后台验证")
            }
            appendLine("设备休眠：${power.isDeviceIdleMode}，省电模式：${power.isPowerSaveMode}")
            appendLine("监听账号：${state.active}，重连中：${state.reconnecting}，轮询补偿：${state.pollingFallback}，网络被系统限制：${state.networkBlocked}")
            val now = SystemClock.elapsedRealtime()
            fun age(time: Long) = if (time == 0L) "本进程尚未成功" else "${(now - time).coerceAtLeast(0) / 1000} 秒前"
            appendLine("最近通知帧：${age(monitor.lastFrameAt)}，最近摘要同步：${age(monitor.lastSyncAt)}")
            appendLine("最近状态记录（不包含账号凭据与对话内容）：")
            append(diagnostics.text())
        }
    }

    internal fun monitoringNotification(): Notification {
        val state = monitorState.value
        return NotificationCompat.Builder(context, MONITOR_CHANNEL)
            .setSmallIcon(R.drawable.ic_task_notification)
            .setContentTitle("Terminal Buddy 后台提醒")
            .setContentText(when {
                state.networkBlocked -> "后台联网受限，请在系统设置中允许后台联网"
                state.pollingFallback -> "正在后台同步任务状态，决策和执行结果会通知你"
                state.reconnecting -> if (monitor.lastFrameAt == 0L && monitor.lastSyncAt == 0L)
                    "正在连接服务器，连接后接收任务提醒"
                else "连接暂时中断，正在自动恢复任务提醒"
                state.tasksRunning -> "任务执行中，需要决策或执行结束时会通知你"
                else -> "正在后台接收任务提醒，点击返回应用"
            })
            .setContentIntent(PendingIntent.getActivity(context, 0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setOngoing(true).setSilent(true).setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE).build()
    }

    private fun showEvent(accountId: String, session: AiSession, decision: Boolean): Boolean {
        val channel = if (decision) DECISION_CHANNEL else RESULT_CHANNEL
        if (!notificationsEnabled(context) || manager.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        val title = if (decision) "需要你决策 · ${session.title}" else when (session.status) {
            "error" -> "任务执行失败 · ${session.title}"
            "interrupted" -> "任务已中断 · ${session.title}"
            else -> "任务已完成 · ${session.title}"
        }
        val text = if (decision) "有 ${session.approvals.size} 项待处理，请点击查看并回复"
            else "点击返回任务，查看执行结果"
        val account = repository.accounts.accounts.find { it.id == accountId }
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_task_notification)
            .setContentTitle(title).setContentText(text)
            .setSubText(listOfNotNull(account?.username, session.providerLabel).joinToString(" · "))
            .setStyle(NotificationCompat.BigTextStyle().bigText("$title\n$text"))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setOnlyAlertOnce(false)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(taskIntent(accountId, session.id)).setAutoCancel(true).build()
        // 用户可在调用间隙撤销权限，不能因此中断任务同步。
        return runCatching { manager.notify(eventTag(accountId, session.id, decision), EVENT_ID, notification) }
            .onSuccess { recordDiagnostic("${if (decision) "决策" else "结束"}通知已交给系统，应用前台=$foreground，服务运行=$serviceRunning") }
            .onFailure { recordDiagnostic("发送任务通知失败：${it.javaClass.simpleName}，等待后续同步重试") }.isSuccess
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
    private fun persist() {
        preferences.edit().putString("snapshots", ApiJson.encodeToString(snapshots))
            .putStringSet("initialized_accounts", initializedAccounts.toSet()).apply()
    }

    companion object {
        private const val LEGACY_DECISION_CHANNEL = "ai_task_decisions"
        private const val DECISION_CHANNEL = "ai_task_decisions_v2"
        private const val LEGACY_RESULT_CHANNEL = "ai_task_results"
        private const val RESULT_CHANNEL = "ai_task_results_v2"
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
        fun decisionAlertsEnabled(context: Context): Boolean = alertsEnabled(context, DECISION_CHANNEL)

        fun resultAlertsEnabled(context: Context): Boolean = alertsEnabled(context, RESULT_CHANNEL)

        private fun alertsEnabled(context: Context, channelId: String): Boolean {
            val channel = context.getSystemService(NotificationManager::class.java)
                .getNotificationChannel(channelId) ?: return false
            return channel.importance >= NotificationManager.IMPORTANCE_HIGH &&
                (channel.sound != null || channel.shouldVibrate())
        }

        fun backgroundRestricted(context: Context): Boolean =
            (Build.VERSION.SDK_INT >= 28 && context.getSystemService(ActivityManager::class.java).isBackgroundRestricted) ||
                !context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

        /** 跳转应用电池管理，由用户允许后台运行；系统不提供该入口时回退应用详情。 */
        fun openBackgroundSettings(context: Context) {
            val optimized = !context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
            val battery = if (optimized) Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
            battery.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { context.startActivity(battery) }.isFailure) {
                context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }

        fun openDecisionSettings(context: Context) = openChannelSettings(context, DECISION_CHANNEL)

        fun openResultSettings(context: Context) = openChannelSettings(context, RESULT_CHANNEL)

        private fun openChannelSettings(context: Context, channelId: String) {
            context.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        fun openSettings(context: Context) {
            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
        }
    }
}
