package com.terminalbuddy.android.notifications

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.terminalbuddy.android.TerminalBuddyApplication
import com.terminalbuddy.android.data.ApiException
import kotlinx.coroutines.*

/** 系统回收进程、服务超时或设备重启后的补偿；不从后台违规启动前台服务。 */
class AiTaskSyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val application = applicationContext as TerminalBuddyApplication
        return if (syncTaskNotifications(application)) Result.success() else Result.retry()
    }
}

internal suspend fun syncTaskNotifications(application: TerminalBuddyApplication): Boolean =
    withContext(Dispatchers.Main.immediate) {
        val repository = application.aiRepository
        val notifications = application.taskNotifications
        val ids = notifications.monitoredAccounts()
        coroutineScope {
            ids.mapNotNull { id ->
                repository.accounts.connection(id)?.let { connection ->
                    val knownIds = notifications.knownSessionIds(id)
                    async {
                        try {
                            // AI 正文请求不设超时；摘要同步单独设限，网络断开后仍能重试。
                            val sessions = withTimeout(25_000) { repository.notificationSessions(connection) }
                            if (repository.accounts.connection(id) == connection) {
                                notifications.observe(id, sessions, completeList = true, knownBeforeRequest = knownIds)
                            }
                            true
                        } catch (_: TimeoutCancellationException) {
                            false
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            if (e is ApiException && e.code == 401 && repository.accounts.connection(id) == connection) {
                                if (repository.accounts.activeId == id) repository.store.clear()
                                repository.accounts.invalidate(id)
                                notifications.removeAccount(id)
                                true
                            } else false
                        }
                    }
                }
            }.awaitAll().all { it }
        }
    }
