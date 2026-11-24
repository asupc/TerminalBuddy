package com.terminalbuddy.android.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.LinkedHashMap
import java.util.concurrent.Executors

/** AI 正文的内存 + SQLite 缓存；只接收服务端完整快照，不保存本地发送占位消息。 */
class AiSessionCache(context: Context, private val store: SessionStore) {
    @ConsistentCopyVisibility
    data class Scope internal constructor(
        val server: String, val username: String, internal val version: Long, internal val accountVersion: Long,
    )
    private data class Key(val server: String, val username: String, val id: String)
    private data class Snapshot(val scope: Scope, val session: AiSession)

    private val database = Database(context.applicationContext)
    private val dispatcher = Executors.newSingleThreadExecutor { task ->
        Thread(task, "ai-session-cache").apply { isDaemon = true }
    }.asCoroutineDispatcher()
    private val writer = CoroutineScope(SupervisorJob() + dispatcher)
    private val memory = LinkedHashMap<Key, AiSession>(16, .75f, true)
    // 仅数据库线程访问，用于跳过未变化的消息行。
    private val written = LinkedHashMap<Key, AiSession>(16, .75f, true)
    private val pending = mutableMapOf<Key, Snapshot>()
    private val removed = mutableSetOf<Key>()
    private var flushJob: Job? = null
    private var version = 0L
    private val accountVersions = mutableMapOf<Pair<String, String>, Long>()
    private val changes = MutableSharedFlow<Snapshot>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    @Synchronized fun scope(): Scope? = if (store.loggedIn) scope(store.server, store.username) else null

    /** 后台调用方先核对账号连接，再取得该账号独立的缓存范围。 */
    @Synchronized internal fun scope(connection: AiConnection): Scope = scope(connection.server, connection.username)

    private fun scope(server: String, username: String) =
        Scope(server, username, version, accountVersions[server to username] ?: 0L)

    /** 仅发布完整正文快照；后台接收的新结果可以直接更新当前页面。 */
    fun observe(scope: Scope, id: String) = changes
        .filter { it.scope == scope && it.session.id == id && canUse(scope, keyOf(scope, id)) }
        .map { it.session }

    /** 同一次运行中再次进入会话时同步取内存，不在主线程访问数据库。 */
    @Synchronized fun peek(scope: Scope, id: String): AiSession? =
        if (isCurrent(scope) && keyOf(scope, id) !in removed) memory[keyOf(scope, id)] else null

    suspend fun read(scope: Scope, id: String): AiSession? = withContext(dispatcher) {
        peek(scope, id)?.let { return@withContext it }
        val key = keyOf(scope, id)
        if (!canUse(scope, key)) return@withContext null
        val session = runCatching {
            val db = database.readableDatabase
            val metadata = db.query("ai_sessions", arrayOf("snapshot"), SESSION_WHERE, args(scope, id), null, null, null).use { cursor ->
                if (!cursor.moveToFirst()) return@withContext null
                ApiJson.decodeFromString<AiSession>(cursor.getString(0)).also { require(it.id == id) }
            }
            val messages = db.query("ai_messages", arrayOf("snapshot"), MESSAGE_WHERE, args(scope, id), null, null, "position ASC").use { cursor ->
                buildList {
                    while (cursor.moveToNext()) add(ApiJson.decodeFromString<AiMessage>(cursor.getString(0)))
                }
            }
            metadata.copy(messages = messages)
        }.getOrElse {
            // 损坏的展示缓存可由网络重建，不能阻断进入页面。
            written.remove(key)
            runCatching { database.writableDatabase.delete("ai_sessions", SESSION_WHERE, args(scope, id)) }
            null
        }
        synchronized(this@AiSessionCache) {
            if (!canUse(scope, key)) null
            else memory[key] ?: session?.also {
                putBounded(memory, key, it)
                putBounded(written, key, it)
            }
        }
    }

    /** 内存立即更新；流式回复每半秒合并落盘，完成结果立即安排写入。 */
    @Synchronized fun save(scope: Scope, session: AiSession) {
        val key = keyOf(scope, session.id)
        if (!canUse(scope, key) || session.id.startsWith("local-")) return
        val previous = memory[key]
        if (previous == session || (previous != null && previous.revision > session.revision)) return
        putBounded(memory, key, session)
        changes.tryEmit(Snapshot(scope, session))
        pending[key] = Snapshot(scope, session)
        if (flushJob?.isActive == true && session.running) return
        flushJob?.cancel()
        flushJob = writer.launch {
            if (session.running) delay(500)
            val snapshots = synchronized(this@AiSessionCache) {
                pending.values.toList().also { pending.clear(); flushJob = null }
            }
            snapshots.forEach { snapshot ->
                val snapshotKey = keyOf(snapshot.scope, snapshot.session.id)
                if (canUse(snapshot.scope, snapshotKey)) runCatching { persist(snapshot.scope, snapshot.session) }
            }
        }
    }

    @Synchronized fun remove(scope: Scope, id: String) {
        if (!isCurrent(scope)) return
        val key = keyOf(scope, id)
        removed.add(key)
        memory.remove(key)
        pending.remove(key)
        writer.launch {
            written.remove(key)
            runCatching { database.writableDatabase.delete("ai_sessions", SESSION_WHERE, args(scope, id)) }
        }
    }

    /** 切换账号时使旧读写失效，保留各账号独立的磁盘缓存。 */
    @Synchronized fun invalidate() {
        // 已接收的正文仍写回原账号，不能因切换账号丢掉最后半秒的结果。
        val snapshots = pending.values.filter {
            it.scope.accountVersion == (accountVersions[it.scope.server to it.scope.username] ?: 0L)
        }
        version++
        memory.clear(); pending.clear(); removed.clear()
        flushJob?.cancel(); flushJob = null
        writer.launch {
            snapshots.forEach { runCatching { persist(it.scope, it.session) } }
            written.clear()
        }
    }

    /** 删除或退出账号时只清理该账号，其他账号的缓存继续保留。 */
    @Synchronized fun removeAccount(server: String, username: String) {
        val account = server to username
        accountVersions[account] = (accountVersions[account] ?: 0L) + 1
        if (store.server == server && store.username == username) invalidate()
        memory.keys.removeAll { it.server == server && it.username == username }
        pending.keys.removeAll { it.server == server && it.username == username }
        removed.removeAll { it.server == server && it.username == username }
        writer.launch {
            written.keys.removeAll { it.server == server && it.username == username }
            runCatching { database.writableDatabase.delete("ai_sessions", "server = ? AND username = ?", arrayOf(server, username)) }
        }
    }

    private fun persist(scope: Scope, session: AiSession) {
        val key = keyOf(scope, session.id)
        val previous = written[key]
        if (previous == session || (previous != null && previous.revision > session.revision)) return
        val db = database.writableDatabase
        db.beginTransaction()
        try {
            // UPDATE 保留外键下的消息行，不能用会先删除旧行的 REPLACE。
            val metadata = ContentValues().apply {
                put("snapshot", ApiJson.encodeToString(session.copy(messages = emptyList())))
            }
            if (db.update("ai_sessions", metadata, SESSION_WHERE, args(scope, session.id)) == 0) {
                metadata.put("server", scope.server); metadata.put("username", scope.username); metadata.put("id", session.id)
                db.insertOrThrow("ai_sessions", null, metadata)
            }
            if (previous == null) db.delete("ai_messages", MESSAGE_WHERE, args(scope, session.id))
            val oldMessages = previous?.messages?.associateBy { it.id }.orEmpty()
            val oldPositions = previous?.messages?.mapIndexed { index, message -> message.id to index }?.toMap().orEmpty()
            val currentIds = session.messages.mapTo(mutableSetOf()) { it.id }
            oldMessages.keys.filterNot { it in currentIds }.forEach { id ->
                db.delete("ai_messages", "$MESSAGE_WHERE AND id = ?", args(scope, session.id) + id)
            }
            session.messages.forEachIndexed { position, message ->
                if (oldMessages[message.id] != message || oldPositions[message.id] != position) {
                    val values = ContentValues().apply {
                        put("server", scope.server); put("username", scope.username); put("session_id", session.id)
                        put("id", message.id); put("position", position); put("snapshot", ApiJson.encodeToString(message))
                    }
                    db.insertWithOnConflict("ai_messages", null, values, SQLiteDatabase.CONFLICT_REPLACE).also { check(it != -1L) }
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        putBounded(written, key, session)
    }

    @Synchronized private fun isCurrent(scope: Scope) = scope.version == version
        && scope.accountVersion == (accountVersions[scope.server to scope.username] ?: 0L)

    @Synchronized private fun canUse(scope: Scope, key: Key) = isCurrent(scope) && key !in removed

    private fun keyOf(scope: Scope, id: String) = Key(scope.server, scope.username, id)
    private fun args(scope: Scope, id: String) = arrayOf(scope.server, scope.username, id)

    private fun putBounded(target: LinkedHashMap<Key, AiSession>, key: Key, session: AiSession) {
        target[key] = session
        if (target.size > 16) target.remove(target.keys.first())
    }

    private class Database(context: Context) : SQLiteOpenHelper(context, "ai-session-cache.db", null, 1) {
        override fun onConfigure(db: SQLiteDatabase) { db.setForeignKeyConstraintsEnabled(true) }

        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("""
                CREATE TABLE ai_sessions (
                    server TEXT NOT NULL, username TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL,
                    PRIMARY KEY (server, username, id)
                )
            """.trimIndent())
            db.execSQL("""
                CREATE TABLE ai_messages (
                    server TEXT NOT NULL, username TEXT NOT NULL, session_id TEXT NOT NULL,
                    id TEXT NOT NULL, position INTEGER NOT NULL, snapshot TEXT NOT NULL,
                    PRIMARY KEY (server, username, session_id, id),
                    FOREIGN KEY (server, username, session_id) REFERENCES ai_sessions (server, username, id) ON DELETE CASCADE
                )
            """.trimIndent())
            db.execSQL("CREATE INDEX ai_messages_order ON ai_messages (server, username, session_id, position)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            db.execSQL("DROP TABLE IF EXISTS ai_messages")
            db.execSQL("DROP TABLE IF EXISTS ai_sessions")
            onCreate(db)
        }
    }

    private companion object {
        const val SESSION_WHERE = "server = ? AND username = ? AND id = ?"
        const val MESSAGE_WHERE = "server = ? AND username = ? AND session_id = ?"
    }
}
