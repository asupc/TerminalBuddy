package com.terminalbuddy.android.data

import android.content.Context
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** TerminalBuddy 直连；账号令牌独立加密，首页配置与已读记录按服务地址和用户名隔离。 */
class AiRepository(context: Context) {
    val store = SessionStore(context)
    val accounts = AiAccountStore(context, store)
    val sessionCache = AiSessionCache(context, store)
    private val preferences = context.getSharedPreferences("terminal_buddy_ui", Context.MODE_PRIVATE)

    private fun accountKey(server: String = store.server, username: String = store.username) =
        "${server.length}:$server${username.length}:$username:"
    private fun preferenceKey(key: String) = accountKey() + key

    init {
        // 原有的单账号偏好只迁给升级时已登录的账号，避免同服务器的其他账号继承。
        if (store.loggedIn) {
            val edit = preferences.edit()
            if (preferences.getString("selection_server", "") == store.server) {
                listOf("project", "provider", "model").forEach { key ->
                    edit.putString(preferenceKey(key), preferences.getString(key, ""))
                }
            }
            if (preferences.getString("viewed_revisions_server", "") == store.server && preferences.contains("viewed_revisions")) {
                edit.putStringSet(preferenceKey("viewed_revisions"), preferences.getStringSet("viewed_revisions", emptySet()))
            }
            edit.remove("selection_server").remove("project").remove("provider").remove("model")
                .remove("viewed_revisions_server").remove("viewed_revisions").remove("session").apply()
        }
    }

    var lastSession: String
        get() = preferences.getString(preferenceKey("session"), "").orEmpty()
        set(value) { preferences.edit().putString(preferenceKey("session"), value).apply() }

    val selectedProject get() = preferences.getString(preferenceKey("project"), "").orEmpty()
    val selectedProvider get() = preferences.getString(preferenceKey("provider"), "").orEmpty()
    val selectedModel get() = preferences.getString(preferenceKey("model"), "").orEmpty()

    fun saveSelection(project: String, provider: String, model: String) {
        preferences.edit().putString(preferenceKey("project"), project)
            .putString(preferenceKey("provider"), provider).putString(preferenceKey("model"), model).apply()
    }

    /** null 表示尚未初始化，空表表示这个账号已经建立过已读基线。 */
    fun viewedRevisions(): Map<String, Long>? {
        val key = preferenceKey("viewed_revisions")
        if (!preferences.contains(key)) return null
        return preferences.getStringSet(key, emptySet()).orEmpty().mapNotNull { item ->
            val revision = item.substringAfter(':', "").toLongOrNull() ?: return@mapNotNull null
            item.substringBefore(':').takeIf(String::isNotBlank)?.let { it to revision }
        }.toMap()
    }

    fun saveViewedRevisions(revisions: Map<String, Long>) {
        preferences.edit().putStringSet(preferenceKey("viewed_revisions"),
            revisions.map { (id, revision) -> "$id:$revision" }.toSet()).apply()
    }

    internal fun activate(connection: AiConnection) {
        accounts.save(connection)
        store.save(connection.server, connection.username, connection.token)
        lastSession = ""
    }

    fun logout() {
        accounts.activeId?.let(accounts::invalidate)
        sessionCache.removeAccount(store.server, store.username)
        lastSession = ""
        store.clear()
    }

    fun removeAccount(id: String) {
        val account = accounts.accounts.find { it.id == id } ?: return
        val current = accounts.activeId == id
        accounts.remove(id)
        if (current) store.clear()
        sessionCache.removeAccount(account.server, account.username)
        val prefix = accountKey(account.server, account.username)
        val edit = preferences.edit()
        preferences.all.keys.filter { it.startsWith(prefix) }.forEach { edit.remove(it) }
        edit.apply()
    }

    /** 登录及其他普通接口沿用连接和请求超时。 */
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(40, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build()

    /** AI 请求和实时流不设固定超时，支持长文本上传及完整历史同步。 */
    private val ai = http.newBuilder()
        .connectTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    /** 先认证及确认原生 AI 接口，成功后由主线程统一激活，失败保留当前账号。 */
    internal suspend fun login(server: String, username: String, password: String): AiConnection {
        val address = ServerAddress.normalize(server)
        val result = request(
            "POST", listOf("auth", "login"),
            jsonBody { put("username", username); put("password", password) },
            server = address, token = "",
        ).asObject()
        val token = result.text("token")
        require(token.isNotBlank()) { "服务未返回登录令牌，请确认这是 TerminalBuddy 服务地址" }
        val connection = AiConnection(address, result.text("username", fallback = username), token)
        validate(connection)
        return connection
    }

    internal suspend fun savedConnection(id: String): AiConnection {
        val connection = accounts.connection(id) ?: throw ApiException(401, "该账号需要重新登录")
        validate(connection)
        return connection
    }

    private suspend fun validate(connection: AiConnection) {
        request("GET", listOf("ai", "sessions"), server = connection.server, token = connection.token)
        request("GET", listOf("ai", "catalog"), server = connection.server, token = connection.token)
    }

    suspend fun sessions(): List<AiSession> = ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "sessions")))
    /** 后台监听固定使用对应账号的连接，切换前台账号不会改变在途请求的身份。 */
    internal suspend fun notificationSessions(connection: AiConnection): List<AiSession> =
        ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "sessions"),
            server = connection.server, token = connection.token))

    suspend fun catalog(): AiCatalog = ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "catalog")))
    suspend fun projects(): List<AiProject> = ApiJson.decodeFromJsonElement(request("GET", listOf("projects")))
    suspend fun session(id: String): AiSession = ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "sessions", id)))

    suspend fun create(project: AiProject, provider: AiProvider, model: String): AiSession =
        ApiJson.decodeFromJsonElement(
            request(
                "POST", listOf("ai", "sessions"),
                jsonBody {
                    put("projectPath", project.path)
                    put("provider", provider.agent)
                    put("providerId", provider.id)
                    if (model.isNotBlank()) put("model", model.trim())
                },
            )
        )

    /** requestId 由调用方生成并持久化在内存里；失败重试复用同一个值，服务端据此去重。 */
    suspend fun send(id: String, text: String, requestId: String): AiSession =
        ApiJson.decodeFromJsonElement(
            request("POST", listOf("ai", "sessions", id, "messages"), jsonBody {
                put("text", text)
                put("requestId", requestId)
            })
        )

    suspend fun stop(id: String) {
        request("POST", listOf("ai", "sessions", id, "stop"))
    }

    suspend fun delete(id: String) {
        request("DELETE", listOf("ai", "sessions", id))
    }

    suspend fun answer(id: String, approval: AiApproval, decision: String, answers: JsonObject = JsonObject(emptyMap())) {
        request("POST", listOf("ai", "sessions", id, "approvals"), jsonBody {
            put("approvalId", approval.id)
            put("decision", decision)
            put("answers", answers)
        })
    }

    /**
     * 实时会话流：首帧是完整会话，之后只推送变化的消息。
     * 客户端按消息 ID 合并，保证流式回复不会重复堆积；断线由上层负责重连与 REST 补偿。
     */
    fun observe(id: String) = callbackFlow<AiSession> {
        val url = ServerAddress.aiSocket(store.server, id, store.token)
        var latest: AiSession? = null
        val socket = ai.newWebSocket(
            Request.Builder().url(url).header("User-Agent", USER_AGENT).build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val body = ApiJson.parseToJsonElement(text).asObject()
                        when (body.text("type")) {
                            "session" -> latest = ApiJson.decodeFromJsonElement<AiSession>(body.getValue("session"))
                            "update" -> {
                                val metadata = ApiJson.decodeFromJsonElement<AiSession>(body.getValue("session"))
                                val previous = latest ?: throw IllegalStateException("缺少会话首帧")
                                val messages = previous.messages.associateByTo(linkedMapOf()) { it.id }
                                ApiJson.decodeFromJsonElement<List<AiMessage>>(body.getValue("messages"))
                                    .forEach { messages[it.id] = it }
                                latest = metadata.copy(messages = messages.values.toList())
                            }
                        }
                        latest?.let { trySend(it) }
                    } catch (_: Exception) {
                        close(ApiException(502, "AI 实时消息格式不正确，请更新服务端"))
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    response?.close()
                    close(
                        if (response?.code == 401) ApiException(401, "AI 服务登录已过期，请重新登录")
                        else IOException("AI 实时连接断开", t)
                    )
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close(IOException("AI 实时连接断开")) }
            },
        )
        awaitClose { socket.cancel() }
    }.buffer(Channel.CONFLATED)

    private suspend fun request(
        method: String, path: List<String>, body: JsonElement? = null,
        server: String = store.server, token: String = store.token,
    ): JsonElement = suspendCancellableCoroutine { continuation ->
        val request = Request.Builder()
            .url(ServerAddress.endpoint(server, path))
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .apply { if (token.isNotBlank()) header("Authorization", "Bearer $token") }
            .method(method, payloadFor(method, body))
            .build()
        val call = (if (path.firstOrNull() == "ai") ai else http).newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val result = runCatching {
                        val raw = response.body?.string().orEmpty()
                        val value = runCatching { ApiJson.parseToJsonElement(raw) }.getOrNull()
                        if (!response.isSuccessful) {
                            val message = when (response.code) {
                                401 -> "AI 服务账号或密码错误，或登录已过期"
                                404 -> "服务不支持原生 AI 会话，请更新 TerminalBuddy 服务端"
                                429 -> "请求过于频繁，请在 ${response.header("Retry-After") ?: "几"} 秒后重试"
                                else -> value.asObject().text("message", fallback = "AI 服务请求失败（${response.code}）")
                            }
                            throw ApiException(response.code, message)
                        }
                        value ?: throw ApiException(502, "AI 服务返回格式不正确，请确认地址指向 TerminalBuddy")
                    }
                    if (continuation.isActive) {
                        result.fold({ continuation.resume(it) }, { continuation.resumeWithException(it) })
                    }
                }
            }
        })
    }

    private companion object { const val USER_AGENT = "TerminalBuddy-Android/1.0" }
}

/**
 * OkHttp 硬约束：POST / PUT / PATCH 必须带请求体，没传时补空 JSON；
 * DELETE 可以不传正文。
 */
internal fun payloadFor(method: String, body: JsonElement?): RequestBody? = when {
    method in setOf("POST", "PUT", "PATCH") ->
        (body?.toString() ?: "{}").toRequestBody("application/json; charset=utf-8".toMediaType())
    method == "DELETE" && body != null ->
        body.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
    else -> null
}
