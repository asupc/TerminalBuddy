package com.terminalbuddy.android.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.UUID

internal const val AI_SESSION_KEY = "terminal_buddy_session_v1"

/** 列表只暴露账号资料与登录状态，不向界面传递令牌。 */
data class AiAccount(val id: String, val server: String, val username: String, val loggedIn: Boolean)

internal data class AiConnection(val server: String, val username: String, val token: String)

/** 账号索引与令牌分开保存，每个账号沿用 Android Keystore 加密的 SessionStore。 */
class AiAccountStore(context: Context, private val active: SessionStore) {
    @Serializable private data class Record(val id: String, val server: String, val username: String)

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
        get() = records.map { AiAccount(it.id, it.server, it.username, session(it).loggedIn) }

    val activeId: String?
        get() = if (active.loggedIn) records.find { it.server == active.server && it.username == active.username }?.id else null

    internal fun save(connection: AiConnection) {
        val record = records.find { it.server == connection.server && it.username == connection.username }
            ?: Record(UUID.randomUUID().toString(), connection.server, connection.username)
        session(record).save(connection.server, connection.username, connection.token)
        if (records.none { it.id == record.id }) persist(records + record)
    }

    internal fun connection(id: String): AiConnection? {
        val record = records.find { it.id == id } ?: return null
        val saved = session(record)
        return if (saved.loggedIn) AiConnection(record.server, record.username, saved.token) else null
    }

    fun invalidate(id: String) {
        records.find { it.id == id }?.let { session(it).clear() }
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
