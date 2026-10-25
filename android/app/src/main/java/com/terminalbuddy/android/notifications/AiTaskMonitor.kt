package com.terminalbuddy.android.notifications

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
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
    val pollingFallback: Boolean = false,
)

/** 账号级通知连接由 Application 持有，不随页面 Socket 的停止或账号切换而关闭。 */
internal class AiTaskMonitor(
    private val context: Context,
    private val repository: AiRepository,
    private val notifications: AiTaskNotifications,
) {
    private data class Subscription(val accountId: String, val connection: AiConnection)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val refresh = Channel<Unit>(Channel.CONFLATED)
    private val subscriptions = mutableMapOf<Subscription, Job>()
    private val connected = mutableSetOf<Subscription>()
    private val lastReceived = mutableMapOf<Subscription, Long>()
    private val mutableState = MutableStateFlow(AiTaskMonitorState())
    val state = mutableState.asStateFlow()
    val running get() = mutableState.value.active
    private var polling: Job? = null
    private var lastPollSucceeded = false
    private var lastPollAt = 0L
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var networkRegistered = false
    private var network: Network? = null
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(available: Network) {
            if (network == available) return
            network = available
            resetConnections()
            update()
            refresh.trySend(Unit)
        }

        override fun onLost(lost: Network) {
            if (network != lost) return
            network = null
            resetConnections()
            publishState()
            refresh.trySend(Unit)
        }
    }

    private fun resetConnections() {
        subscriptions.values.toList().forEach { it.cancel() }
        subscriptions.clear()
        connected.clear()
        lastReceived.clear()
        lastPollSucceeded = false
    }

    /** 服务每五秒检查一次，接收停滞或协程意外退出后无需打开 Activity 即可恢复。 */
    fun update() {
        val accounts = notifications.monitoredAccounts()
        if (accounts.isEmpty()) {
            polling?.cancel()
            polling = null
            resetConnections()
            if (networkRegistered) runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
            networkRegistered = false
            network = null
            publishState()
            return
        }
        val desired = accounts.mapNotNullTo(mutableSetOf()) { id ->
            repository.accounts.connection(id)?.let { Subscription(id, it) }
        }
        val now = SystemClock.elapsedRealtime()
        subscriptions.keys.toList().filter { subscription ->
            subscription !in desired || subscriptions[subscription]?.isActive != true ||
                now - (lastReceived[subscription] ?: now) >= RECEIVE_TIMEOUT
        }.forEach { subscription ->
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
        if (polling?.isActive != true) polling = scope.launch {
            var failures = 0
            while (isActive) {
                lastPollSucceeded = try {
                    syncTaskNotifications(context.applicationContext as TerminalBuddyApplication)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w("AiTaskMonitor", "后台摘要同步异常，将继续重试", e)
                    false
                }
                lastPollAt = SystemClock.elapsedRealtime()
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
                lastReceived[subscription] = SystemClock.elapsedRealtime()
                repository.observeNotificationSessions(subscription.connection).collect { sessions ->
                    if (repository.accounts.connection(subscription.accountId) == subscription.connection) {
                        lastReceived[subscription] = SystemClock.elapsedRealtime()
                        connected.add(subscription)
                        retries = 0
                        publishState()
                        // 删除由 REST 的请求前基线处理，避免删除刚在手机上发送的新任务。
                        notifications.observe(subscription.accountId, sessions)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                Log.w("AiTaskMonitor", "账号 ${subscription.accountId} 的后台通知连接已断开，将自动重连")
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

    private fun publishState() {
        val accounts = notifications.monitoredAccounts()
        val active = accounts.isNotEmpty()
        val reconnecting = active && !connected.map { it.accountId }.containsAll(accounts)
        mutableState.value = AiTaskMonitorState(
            active, reconnecting, notifications.hasActiveTasks(),
            reconnecting && lastPollSucceeded && SystemClock.elapsedRealtime() - lastPollAt < RECEIVE_TIMEOUT,
        )
    }

    private companion object { const val RECEIVE_TIMEOUT = 35_000L }
}
