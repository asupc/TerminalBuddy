package com.terminalbuddy.android.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.terminalbuddy.android.TerminalBuddyApplication
import com.terminalbuddy.android.data.AiConnection
import com.terminalbuddy.android.data.AiRepository
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.AiSessionBodySync
import com.terminalbuddy.android.data.ApiException
import com.terminalbuddy.android.data.ServerNotificationFrame
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect

internal data class AiTaskMonitorState(
    val active: Boolean = false, val reconnecting: Boolean = false, val tasksRunning: Boolean = false,
    val pollingFallback: Boolean = false, val networkBlocked: Boolean = false,
)

/** 账号级通知连接由 Application 持有，不随页面 Socket 的停止或账号切换而关闭。 */
internal class AiTaskMonitor(
    private val context: Context,
    private val repository: AiRepository,
    private val notifications: AiTaskNotifications,
) {
    private enum class SubscriptionKind(val label: String) {
        AiSessions("AI 会话"),
        ServerNotifications("服务端任务"),
    }
    private data class Subscription(val accountId: String, val connection: AiConnection, val kind: SubscriptionKind)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val bodies = AiSessionBodySync(repository, scope)
    private val refresh = Channel<Unit>(Channel.CONFLATED)
    private val subscriptions = mutableMapOf<Subscription, Job>()
    private val retry404Jobs = mutableMapOf<Subscription, Job>()
    private val connected = mutableSetOf<Subscription>()
    private val unsupported = mutableSetOf<Subscription>()
    private val lastReceived = mutableMapOf<Subscription, Long>()
    private val mutableState = MutableStateFlow(AiTaskMonitorState())
    val state = mutableState.asStateFlow()
    val running get() = mutableState.value.active
    private var polling: Job? = null
    private var lastPollSucceeded = false
    private var lastPollAt = 0L
    internal var lastFrameAt = 0L
        private set
    internal var lastSyncAt = 0L
        private set
    private var networkBlocked = false
    private var powerReceiverRegistered = false
    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val power = context.getSystemService(PowerManager::class.java)
            notifications.recordDiagnostic("电源状态变化：休眠=${power.isDeviceIdleMode}，省电=${power.isPowerSaveMode}")
            resetConnections()
            update()
            refresh.trySend(Unit)
        }
    }
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var networkRegistered = false
    private var network: Network? = null
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(available: Network) {
            if (network == available) return
            network = available
            notifications.recordDiagnostic("默认网络可用，重建通知连接")
            resetConnections()
            update()
            refresh.trySend(Unit)
        }

        override fun onLost(lost: Network) {
            if (network != lost) return
            network = null
            networkBlocked = false
            notifications.recordDiagnostic("默认网络断开")
            resetConnections()
            publishState()
            refresh.trySend(Unit)
        }

        override fun onBlockedStatusChanged(changed: Network, blocked: Boolean) {
            if (changed != network || networkBlocked == blocked) return
            networkBlocked = blocked
            notifications.recordDiagnostic("系统限制后台网络：$blocked")
            if (!blocked) { resetConnections(); update() }
            publishState()
            refresh.trySend(Unit)
        }
    }

    private fun resetConnections() {
        bodies.reset()
        subscriptions.values.toList().forEach { it.cancel() }
        subscriptions.clear()
        retry404Jobs.values.toList().forEach { it.cancel() }
        retry404Jobs.clear()
        connected.clear()
        unsupported.clear()
        lastReceived.clear()
        lastPollSucceeded = false
    }

    /** 服务每五秒检查一次，接收停滞或协程意外退出后无需打开 Activity 即可恢复。 */
    fun update() {
        bodies.updateAccounts()
        val accounts = notifications.monitoredAccounts()
        if (accounts.isEmpty()) {
            polling?.cancel()
            polling = null
            resetConnections()
            if (networkRegistered) runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
            networkRegistered = false
            network = null
            networkBlocked = false
            if (powerReceiverRegistered) runCatching { context.unregisterReceiver(powerReceiver) }
            powerReceiverRegistered = false
            publishState()
            return
        }
        val desired = accounts.flatMapTo(mutableSetOf()) { id ->
            repository.accounts.connection(id)?.let { connection ->
                SubscriptionKind.entries.map { kind -> Subscription(id, connection, kind) }
            }.orEmpty()
        }
        desired.removeAll(unsupported)
        val now = SystemClock.elapsedRealtime()
        subscriptions.keys.toList().filter { subscription ->
            subscription !in desired || subscriptions[subscription]?.isActive != true ||
                now - (lastReceived[subscription] ?: now) >= RECEIVE_TIMEOUT
        }.forEach { subscription ->
            if (subscription in desired) notifications.recordDiagnostic("接收超时或订阅已退出，重建通知连接")
            subscriptions.remove(subscription)?.cancel()
            connected.remove(subscription)
            lastReceived.remove(subscription)
        }
        desired.filterNot { it in subscriptions }.forEach { subscription ->
            val job = scope.launch(start = CoroutineStart.LAZY) { subscribe(subscription) }
            subscriptions[subscription] = job
            lastReceived[subscription] = now
            job.start()
        }
        publishState()
        if (!networkRegistered) {
            network = connectivity.activeNetwork
            networkRegistered = runCatching {
                connectivity.registerDefaultNetworkCallback(networkCallback, Handler(Looper.getMainLooper()))
            }.isSuccess
        }
        if (!powerReceiverRegistered) powerReceiverRegistered = runCatching {
            ContextCompat.registerReceiver(context, powerReceiver, IntentFilter().apply {
                addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
                addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            }, ContextCompat.RECEIVER_NOT_EXPORTED)
        }.isSuccess
        if (polling?.isActive != true) polling = scope.launch {
            var failures = 0
            while (isActive) {
                val previousSuccess = lastPollSucceeded
                lastPollSucceeded = try {
                    syncTaskNotifications(context.applicationContext as TerminalBuddyApplication)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    notifications.recordDiagnostic("后台摘要同步异常：${e.javaClass.simpleName}")
                    false
                }
                lastPollAt = SystemClock.elapsedRealtime()
                if (lastPollSucceeded) lastSyncAt = lastPollAt
                if (lastPollSucceeded != previousSuccess) {
                    notifications.recordDiagnostic(if (lastPollSucceeded) "后台摘要同步成功" else "后台摘要同步失败，等待重试")
                }
                if (!running) break
                failures = if (lastPollSucceeded) 0 else (failures + 1).coerceAtMost(4)
                publishState()
                // 实时连接健康时降低补偿频率；断线时才使用三秒轮询，避免长期后台高频请求。
                val realtimeHealthy = notifications.monitoredAccounts().all { account ->
                    connected.any { it.accountId == account && it.kind == SubscriptionKind.AiSessions }
                }
                val delayMillis = if (lastPollSucceeded) { if (realtimeHealthy) 30_000L else 3_000L }
                    else (3_000L shl failures).coerceAtMost(30_000)
                withTimeoutOrNull(delayMillis) { refresh.receive() }
            }
        }
    }

    fun refreshNow() { refresh.trySend(Unit) }

    fun syncSessionBodies(accountId: String, sessions: List<AiSession>) {
        if (running) bodies.observe(accountId, sessions)
    }

    private suspend fun subscribe(subscription: Subscription) {
        var retries = 0
        while (currentCoroutineContext().isActive) {
            try {
                lastReceived[subscription] = SystemClock.elapsedRealtime()
                when (subscription.kind) {
                    SubscriptionKind.AiSessions -> repository.observeNotificationSessions(subscription.connection)
                        .collect { sessions ->
                            if (repository.accounts.connection(subscription.accountId) != subscription.connection) return@collect
                            received(subscription)
                            retries = 0
                            // 删除由 REST 的请求前基线处理，避免删除刚在手机上发送的新任务。
                            notifications.observe(subscription.accountId, sessions, accountSnapshot = true)
                        }
                    SubscriptionKind.ServerNotifications -> repository.observeServerNotifications(subscription.connection)
                        .collect { frame ->
                            if (repository.accounts.connection(subscription.accountId) != subscription.connection) return@collect
                            received(subscription)
                            retries = 0
                            when (frame) {
                                is ServerNotificationFrame.Snapshot ->
                                    notifications.replaceServerDecisions(subscription.accountId, frame.decisions)
                                is ServerNotificationFrame.Event ->
                                    notifications.observeServerNotification(subscription.accountId, frame.event)
                                ServerNotificationFrame.Heartbeat -> Unit
                            }
                        }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val code = if (e is ApiException) "，HTTP ${e.code}" else ""
                val isUnsupported = subscription.kind == SubscriptionKind.ServerNotifications &&
                    e is ApiException && e.code == 404
                notifications.recordDiagnostic(
                    if (isUnsupported) "服务端不支持任务通知，已暂停该通道"
                    else "${subscription.kind.label}通知连接断开：${e.javaClass.simpleName}$code，将自动重连"
                )
                if (isUnsupported) {
                    // 旧服务端不提供该接口；记录后不再反复重连，十分钟后或网络切换时重试。
                    unsupported.add(subscription)
                    retry404Jobs.remove(subscription)?.cancel()
                    retry404Jobs[subscription] = scope.launch {
                        delay(600_000)
                        retry404Jobs.remove(subscription)
                        unsupported.remove(subscription)
                        update()
                    }
                    return
                }
            } finally {
                if (subscriptions[subscription] == currentCoroutineContext()[Job]) {
                    connected.remove(subscription)
                    publishState()
                }
            }
            refresh.trySend(Unit)
            delay(500L shl retries.coerceAtMost(4))
            retries = (retries + 1).coerceAtMost(4)
        }
    }

    private fun received(subscription: Subscription) {
        lastFrameAt = SystemClock.elapsedRealtime()
        lastReceived[subscription] = lastFrameAt
        if (connected.add(subscription)) {
            notifications.recordDiagnostic("${subscription.kind.label}通知连接已收到消息帧")
        }
        publishState()
    }

    private fun publishState() {
        val accounts = notifications.monitoredAccounts()
        val active = accounts.isNotEmpty()
        // 连接健康只由 AI 会话通道决定；旧服务端没有服务端任务通知通道时，
        // 不能让整套后台监听一直显示“重连中”。服务端通道自行退避重试。
        val aiConnected = connected.filter { it.kind == SubscriptionKind.AiSessions }
            .mapTo(mutableSetOf()) { it.accountId }
        val reconnecting = active && (networkBlocked || !aiConnected.containsAll(accounts))
        mutableState.value = AiTaskMonitorState(
            active, reconnecting, notifications.hasActiveTasks(),
            reconnecting && !networkBlocked && lastPollSucceeded && SystemClock.elapsedRealtime() - lastPollAt < RECEIVE_TIMEOUT,
            networkBlocked,
        )
    }

    private companion object { const val RECEIVE_TIMEOUT = 35_000L }
}
