package com.terminalbuddy.android.notifications

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import com.terminalbuddy.android.TerminalBuddyApplication
import com.terminalbuddy.android.data.AiConnection
import com.terminalbuddy.android.data.AiRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect

internal data class AiTaskMonitorState(
    val active: Boolean = false, val reconnecting: Boolean = false, val tasksRunning: Boolean = false,
)

/** 应用级监听不依赖 Activity；前台服务只负责保活，启动失败也不丢弃存活进程中的接收。 */
internal class AiTaskMonitor(
    private val context: Context,
    private val repository: AiRepository,
    private val notifications: AiTaskNotifications,
) {
    private data class Subscription(val target: AiNotificationTarget, val connection: AiConnection)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val refresh = Channel<Unit>(Channel.CONFLATED)
    private val subscriptions = mutableMapOf<Subscription, Job>()
    private val connected = mutableSetOf<Subscription>()
    private val mutableState = MutableStateFlow(AiTaskMonitorState())
    val state = mutableState.asStateFlow()
    val running get() = mutableState.value.active
    private var polling: Job? = null
    private var lastPollSucceeded = false
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var networkRegistered = false
    private var network: Network? = null
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(available: Network) {
            if (network == available) return
            network = available
            // 取消旧网络上的连接和退避等待，立即重建账号各自的实时订阅。
            subscriptions.values.toList().forEach { it.cancel() }
            subscriptions.clear()
            connected.clear()
            update()
            refresh.trySend(Unit)
        }

        override fun onLost(lost: Network) {
            if (network != lost) return
            network = null
            connected.clear()
            lastPollSucceeded = false
            publishState()
            refresh.trySend(Unit)
        }
    }

    /** 所有状态与通知基线均在主线程串行处理；发送新任务会立即唤醒摘要补偿。 */
    fun update() {
        if (notifications.monitoredAccounts().isEmpty()) {
            polling?.cancel()
            polling = null
            subscriptions.values.toList().forEach { it.cancel() }
            subscriptions.clear()
            connected.clear()
            if (networkRegistered) runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
            networkRegistered = false
            network = null
            lastPollSucceeded = false
            publishState()
            return
        }
        val desired = notifications.monitoredTasks().mapNotNullTo(mutableSetOf()) { target ->
            repository.accounts.connection(target.accountId)?.let { Subscription(target, it) }
        }
        subscriptions.keys.toList().filterNot { it in desired }.forEach { subscription ->
            subscriptions.remove(subscription)?.cancel()
            connected.remove(subscription)
        }
        desired.filterNot { it in subscriptions }.forEach { subscription ->
            // LAZY 保证首帧即使同步到达，也不会在订阅登记前重新创建相同任务。
            val job = scope.launch(start = CoroutineStart.LAZY) { subscribe(subscription) }
            subscriptions[subscription] = job
            job.start()
        }
        publishState()
        if (!networkRegistered) {
            network = connectivity.activeNetwork
            networkRegistered = runCatching {
                connectivity.registerDefaultNetworkCallback(networkCallback, Handler(Looper.getMainLooper()))
            }.isSuccess
        }
        if (polling?.isActive != true) polling = scope.launch {
            var failures = 0
            while (isActive) {
                lastPollSucceeded = syncTaskNotifications(context.applicationContext as TerminalBuddyApplication)
                if (!running) break
                failures = if (lastPollSucceeded) 0 else (failures + 1).coerceAtMost(4)
                publishState()
                val delayMillis = if (lastPollSucceeded) 3_000L else (3_000L shl failures).coerceAtMost(30_000)
                withTimeoutOrNull(delayMillis) { refresh.receive() }
            }
        }
    }

    fun refreshNow() { refresh.trySend(Unit) }

    private suspend fun subscribe(subscription: Subscription) {
        var retries = 0
        while (currentCoroutineContext().isActive) {
            try {
                repository.observeNotifications(subscription.target.sessionId, subscription.connection).collect { session ->
                    if (repository.accounts.connection(subscription.target.accountId) == subscription.connection) {
                        connected.add(subscription)
                        retries = 0
                        publishState()
                        notifications.observe(subscription.target.accountId, listOf(session))
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // REST 补偿负责失效账号和删除会话，单条订阅失败不影响其他任务。
            } finally {
                // 网络切换后的旧协程不能清除新订阅的连接状态。
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

    private fun publishState() {
        val active = notifications.monitoredAccounts().isNotEmpty()
        mutableState.value = AiTaskMonitorState(
            active, active && !lastPollSucceeded && connected.isEmpty(), notifications.hasActiveTasks(),
        )
    }
}
