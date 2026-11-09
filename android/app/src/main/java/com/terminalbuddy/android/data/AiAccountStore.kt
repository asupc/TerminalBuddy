package com.terminalbuddy.android.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.UUID

internal const val AI_SESSION_KEY = "terminal_buddy_session_v1"

/**
 * 备注名合并：本次连接没填名字（自动迁移、重新登录）时沿用已有备注，
 * 只有显式填写新名字或调用 [AiAccountStore.rename] 才改写，
 * 避免每次冷启动把用户给服务端起的名抹掉。
 */
internal fun mergeAccountName(existing: String, incoming: String): String =
    incoming.trim().ifEmpty { existing }

/** 列表只暴露账号资料与登录状态，不向界面传递令牌。 */
data class AiAccount(val id: String, val server: String, val username: String, val loggedIn: Boolean,
    /** 用户给这台服务端起的备注名；为空时界面回退显示登录账号。 */
    val name: String = "") {
    val label get() = name.ifBlank { username }
}

internal data class AiConnection(val server: String, val username: String, val token: String, val name: String = "")

/** 账号索引与令牌分开保存，每个账号沿用 Android Keystore 加密的 SessionStore。 */
class AiAccountStore(context: Context, private val active: SessionStore) {
    @Serializable private data class Record(val id: String, val server: String, val username: String, val name: String = "")

    private val context = context.applicationContext
    private val preferences = context.getSharedPreferences("terminal_buddy_accounts", Context.MODE_PRIVATE)
    private val sessions = mutableMapOf<String, SessionStore>()
    private var records = runCatching {
        ApiJson.decodeFromString<List<Record>>(preferences.getString("accounts", "[]").orEmpty())
    }.getOrDefault(emptyList())

    init {
        // 升级时将原来的单账号自动纳入列表，保留当前登录。
        if (active.loggedIn) save(AiConnection(active.server, active.username, active.token))
    }

    val accounts: List<AiAccount>
        get() = records.map { AiAccount(it.id, it.server, it.username, session(it).loggedIn, it.name) }

    val activeId: String?
        get() = if (active.loggedIn) records.find { it.server == active.server && it.username == active.username }?.id else null

    internal fun save(connection: AiConnection) {
        val existing = records.find { it.server == connection.server && it.username == connection.username }
        // 未填写名称时保留原备注名：init 的自动迁移与重新登录都不携带 name。
        val name = if (existing != null) mergeAccountName(existing.name, connection.name) else connection.name.trim()
        val record = existing
            ?.takeIf { it.name == name } ?: existing?.copy(name = name)
            ?: Record(UUID.randomUUID().toString(), connection.server, connection.username, name)
        session(record).save(connection.server, connection.username, connection.token)
        if (existing == null) persist(records + record)
        else if (record != existing) persist(records.map { if (it.id == record.id) record else it })
    }

    internal fun connection(id: String): AiConnection? {
        val record = records.find { it.id == id } ?: return null
        val saved = session(record)
        return if (saved.loggedIn) AiConnection(record.server, record.username, saved.token, record.name) else null
    }

    fun invalidate(id: String) {
        records.find { it.id == id }?.let { session(it).clear() }
    }

    /** 修改已保存服务端的备注名；留空表示清除，列表回退显示登录账号。 */
    fun rename(id: String, name: String) {
        val trimmed = name.trim()
        val record = records.find { it.id == id } ?: return
        if (record.name == trimmed) return
        persist(records.map { if (it.id == id) it.copy(name = trimmed) else it })
    }

    fun remove(id: String) {
        val record = records.find { it.id == id } ?: return
        persist(records.filterNot { it.id == id })
        session(record).clear()
        sessions.remove(id)
        context.deleteSharedPreferences(namespace(id))
    }

    private fun persist(value: List<Record>) {
        check(preferences.edit().putString("accounts", ApiJson.encodeToString(value)).commit()) { "无法保存 AI 账号列表" }
        records = value
    }

    private fun session(record: Record): SessionStore = sessions.getOrPut(record.id) {
        SessionStore(context, namespace(record.id), AI_SESSION_KEY)
    }

    private fun namespace(id: String) = "terminal_buddy_account_$id"
}
