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

/**
 * TerminalBuddy 直连：服务端账号密码登录 → JWT → REST + WebSocket。
 * 认证与桌面/网页端完全一致，语音/会话数据都由服务端保存，手机只保留令牌和首页选择。
 */
class AiRepository(context: Context) {
    val store = SessionStore(context)
    private val preferences = context.getSharedPreferences("terminal_buddy_ui", Context.MODE_PRIVATE)

    /** 上一次打开的会话；首页选择项按服务地址分别记住，换服务器不会串用。 */
    var lastSession: String
        get() = preferences.getString("session", "").orEmpty()
        set(value) { preferences.edit().putString("session", value).apply() }

    private fun selected(key: String): String =
        if (preferences.getString("selection_server", "") == store.server) preferences.getString(key, "").orEmpty() else ""

    val selectedProject get() = selected("project")
    val selectedProvider get() = selected("provider")
    val selectedModel get() = selected("model")

    fun saveSelection(project: String, provider: String, model: String) {
        preferences.edit().putString("selection_server", store.server).putString("project", project)
            .putString("provider", provider).putString("model", model).apply()
    }

    /** 按服务地址隔离；null 表示尚未初始化，空表则表示已经建立过基线。 */
    fun viewedRevisions(): Map<String, Long>? {
        if (preferences.getString("viewed_revisions_server", "") != store.server ||
            !preferences.contains("viewed_revisions")) return null
        return preferences.getStringSet("viewed_revisions", emptySet()).orEmpty().mapNotNull { item ->
            val revision = item.substringAfter(':', "").toLongOrNull() ?: return@mapNotNull null
            item.substringBefore(':').takeIf(String::isNotBlank)?.let { it to revision }
        }.toMap()
    }

    fun saveViewedRevisions(revisions: Map<String, Long>) {
        preferences.edit()
            .putString("viewed_revisions_server", store.server)
            .putStringSet("viewed_revisions", revisions.map { (id, revision) -> "$id:$revision" }.toSet())
            .apply()
    }

    /** 普通请求：40 秒足够创建会话和发送消息；WebSocket 单独使用无超时的客户端。 */
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(40, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build()

    private val realtime = http.newBuilder()
        .callTimeout(0, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(10, TimeUnit.SECONDS).build()

    /**
     * 登录后先确认目标服务确实提供原生 AI 接口，再替换已保存的连接，
     * 避免把普通 huluwa 服务或旧版 TerminalBuddy 误存成 AI 服务。
     */
    suspend fun login(server: String, username: String, password: String) {
        val address = ServerAddress.normalize(server)
        val result = request(
            "POST", listOf("auth", "login"),
            jsonBody { put("username", username); put("password", password) },
            server = address, token = "",
        ).asObject()
        val token = result.text("token")
        require(token.isNotBlank()) { "服务未返回登录令牌，请确认这是 TerminalBuddy 服务地址" }
        request("GET", listOf("ai", "sessions"), server = address, token = token)
        request("GET", listOf("ai", "catalog"), server = address, token = token)
        store.save(address, result.text("username", fallback = username), token)
        lastSession = ""
    }

    suspend fun sessions(): List<AiSession> = ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "sessions")))
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
        val socket = realtime.newWebSocket(
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
        val call = http.newCall(request)
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
