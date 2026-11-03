package com.terminalbuddy.android.data

import android.os.SystemClock
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect

/** 通知监听同时维护运行中会话的正文缓存，生命周期独立于聊天页面。所有入口均在主线程。 */
internal class AiSessionBodySync(private val repository: AiRepository, private val scope: CoroutineScope) {
    private data class Target(val accountId: String, val connection: AiConnection, val id: String)

    private val summaries = mutableMapOf<Target, AiSession>()
    private val revisions = mutableMapOf<Target, Long>()
    private val jobs = mutableMapOf<Target, Job>()

    fun updateAccounts() {
        summaries.keys.toList().filter { repository.accounts.connection(it.accountId) != it.connection }.forEach { target ->
            jobs.remove(target)?.cancel()
            summaries.remove(target)
            revisions.remove(target)
        }
    }

    fun reset() {
        jobs.values.toList().forEach { it.cancel() }
        jobs.clear()
    }

    fun observe(accountId: String, sessions: List<AiSession>) {
        val connection = repository.accounts.connection(accountId) ?: return
        updateAccounts()
        val cache = repository.sessionCache
        val cacheScope = cache.scope(connection)
        // 冷启动只预取最近结果；其他空闲历史按需读取，避免下载整个账号的正文。
        val recent = sessions.sortedByDescending { it.updatedAt }.take(2).mapTo(mutableSetOf()) { it.id }
        for (session in sessions) {
            if (session.id.startsWith("local-")) continue
            val target = Target(accountId, connection, session.id)
            val previous = summaries[target]
            if (previous != null && previous.revision > session.revision) continue
            summaries[target] = session.copy(messages = emptyList())
            val cached = cache.peek(cacheScope, session.id)
            val revision = maxOf(revisions[target] ?: 0L, cached?.revision ?: 0L)
            if (!session.running && revision >= session.revision) {
                jobs.remove(target)?.cancel()
                continue
            }
            val completed = session.resultRevision > 0 &&
                (session.id in recent || previous != null && session.resultRevision > previous.resultRevision)
            if (!session.running && jobs[target]?.isActive != true && cached == null && !completed) continue
            if (jobs[target]?.isActive == true) continue
            val job = scope.launch(start = CoroutineStart.LAZY) { synchronize(target) }
            jobs[target] = job
            job.start()
        }
    }

    private suspend fun synchronize(target: Target) = coroutineScope {
        val finished = CompletableDeferred<Unit>()
        var lastFrameAt = 0L

        fun accept(session: AiSession) {
            if (repository.accounts.connection(target.accountId) != target.connection) {
                finished.complete(Unit)
                return
            }
            val cache = repository.sessionCache
            cache.save(cache.scope(target.connection), session)
            revisions[target] = maxOf(revisions[target] ?: 0L, session.revision)
            // 完成摘要可能先于正文到达；取得对应版本的全文后才停止正文订阅。
            if (!session.running && session.revision >= (summaries[target]?.revision ?: 0L)) finished.complete(Unit)
        }

        fun unavailable(error: Throwable): Boolean {
            if (error !is ApiException || error.code !in setOf(401, 404)) return false
            revisions[target] = maxOf(revisions[target] ?: 0L, summaries[target]?.revision ?: 0L)
            finished.complete(Unit)
            return true
        }

        launch {
            var retries = 0
            while (isActive && !finished.isCompleted) {
                try {
                    repository.observeBackground(target.id, target.connection).collect { session ->
                        lastFrameAt = SystemClock.elapsedRealtime()
                        retries = 0
                        accept(session)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (unavailable(e)) return@launch
                }
                delay(500L shl retries.coerceAtMost(4))
                retries = (retries + 1).coerceAtMost(4)
            }
        }
        launch {
            // 给实时首帧一次机会；代理拦截 WS 时仍能补拉，不必等到回到聊天页。
            delay(1_000)
            while (isActive && !finished.isCompleted) {
                if (lastFrameAt == 0L || SystemClock.elapsedRealtime() - lastFrameAt >= 15_000) {
                    try {
                        val session = withTimeoutOrNull(25_000) { repository.backgroundSession(target.id, target.connection) }
                        if (session != null) accept(session)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        if (unavailable(e)) return@launch
                    }
                }
                delay(3_000)
            }
        }
        try {
            finished.await()
        } finally {
            coroutineContext.cancelChildren()
        }
    }
}
