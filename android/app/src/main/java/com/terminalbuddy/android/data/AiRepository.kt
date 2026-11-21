package com.terminalbuddy.android.data

import android.content.Context
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
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

    /** 冷启动同步恢复展示数据；缓存损坏时回退到服务端同步，不影响进入页面。 */
    fun cachedQuickStart(): AiQuickStartCache? {
        if (!store.loggedIn) return null
        val key = preferenceKey("quick_start_v1")
        val snapshot = preferences.getString(key, null) ?: return null
        return runCatching { ApiJson.decodeFromString<AiQuickStartCache>(snapshot) }.getOrElse {
            preferences.edit().remove(key).apply()
            null
        }
    }

    /** 最近任务只缓存首页的两条摘要，不将完整对话写入 SharedPreferences。 */
    fun cachedRecentSessions(): List<AiSession> {
        if (!store.loggedIn) return emptyList()
        val key = preferenceKey("recent_sessions_v1")
        val snapshot = preferences.getString(key, null) ?: return emptyList()
        return runCatching { ApiJson.decodeFromString<List<AiSession>>(snapshot) }.getOrElse {
            preferences.edit().remove(key).apply()
            emptyList()
        }
    }

    fun saveRecentSessions(sessions: List<AiSession>) {
        if (!store.loggedIn) return
        val recent = sessions.take(2).map { session ->
            AiSession(
                id = session.id, title = session.title, provider = session.provider, projectPath = session.projectPath,
                providerId = session.providerId, providerName = session.providerName, model = session.model,
                status = session.status, updatedAt = session.updatedAt, revision = session.revision,
                resultRevision = session.resultRevision,
            )
        }
        val key = preferenceKey("recent_sessions_v1")
        val snapshot = ApiJson.encodeToString(recent)
        if (preferences.getString(key, null) != snapshot) preferences.edit().putString(key, snapshot).apply()
    }

    /** 同一助手的模型可能来自不同供应商，两者一起按当前账号保存。 */
    fun selectedAgentProvider(agent: String) = preferences.getString(preferenceKey("provider:$agent"), "").orEmpty()
    fun selectedAgentModel(agent: String) = preferences.getString(preferenceKey("model:$agent"), "").orEmpty()

    /**
     * 斜杠命令清单缓存：新建的本地会话要等首次发送启动 CLI 后才有 `system/init`，
     * 这段时间先借用同一 Agent 最近一次拿到的清单，避免输入 `/` 没有候选。
     */
    fun cachedSlashCatalog(agent: String): AiSlashCatalog? = runCatching {
        preferences.getString(preferenceKey("slash_catalog:$agent"), null)
            ?.let { ApiJson.decodeFromString<AiSlashCatalog>(it) }
    }.getOrNull()

    fun saveSlashCatalog(agent: String, catalog: AiSlashCatalog) {
        val key = preferenceKey("slash_catalog:$agent")
        val encoded = ApiJson.encodeToString(catalog)
        // 快照每个回合都会重建，内容没变时不重复落盘。
        if (preferences.getString(key, null) != encoded) preferences.edit().putString(key, encoded).apply()
    }

    /** 连续发送方式是全局偏好，不随账号隔离：false 等当前回合任务完成后排队续发，true 原生插话。 */
    var sendSteer: Boolean
        get() = preferences.getBoolean("ai_send_steer", preferences.getBoolean("ai_send_immediate", false))
        set(value) { preferences.edit().putBoolean("ai_send_steer", value).apply() }

    fun saveSelection(
        project: String, provider: String, model: String, agent: String?, quickStart: AiQuickStartCache? = null,
    ) {
        val edit = preferences.edit().putString(preferenceKey("project"), project)
            .putString(preferenceKey("provider"), provider).putString(preferenceKey("model"), model)
        if (!agent.isNullOrBlank() && provider.isNotBlank()) {
            edit.putString(preferenceKey("provider:$agent"), provider)
                .putString(preferenceKey("model:$agent"), model)
        }
        // 选择与展示快照一次性更新内存，再异步落盘，下一次启动可直接还原整张配置卡。
        if (quickStart != null) edit.putString(preferenceKey("quick_start_v1"), ApiJson.encodeToString(quickStart))
        edit.apply()
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

    fun renameAccount(id: String, name: String) {
        accounts.rename(id, name)
    }

    /** 登录及其他普通接口沿用连接和请求超时。 */
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(40, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build()

    /**
     * AI 正文流不设整体超时，支持长时间执行与完整历史同步；
     * 但连接建立仍必须有上限，否则 WireGuard / 代理切换后的半开连接会无限转圈。
     */
    private val ai = http.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS).writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    /** 独立心跳及时发现后台半断开的连接，不影响正文上传的超时配置。 */
    private val realtime = ai.newBuilder().pingInterval(15, TimeUnit.SECONDS).build()

    /** 后台通知独立调度和超时，不与页面长请求争用队列或跟随页面 Socket 取消。 */
    private val notificationHttp = http.newBuilder().dispatcher(Dispatcher()).build()
    private val notificationRealtime = notificationHttp.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS).callTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS).build()

    /** 先认证及确认原生 AI 接口，成功后由主线程统一激活，失败保留当前账号。 */
    internal suspend fun login(server: String, username: String, password: String, name: String = ""): AiConnection {
        val address = ServerAddress.normalize(server)
        val result = request(
            "POST", listOf("auth", "login"),
            jsonBody { put("username", username); put("password", password) },
            server = address, token = "",
        ).asObject()
        val token = result.text("token")
        require(token.isNotBlank()) { "服务未返回登录令牌，请确认这是 TerminalBuddy 服务地址" }
        val connection = AiConnection(address, result.text("username", fallback = username), token, name)
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
            server = connection.server, token = connection.token, client = notificationHttp))

    suspend fun catalog(): AiCatalog = ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "catalog")))
    suspend fun projects(): List<AiProject> = ApiJson.decodeFromJsonElement(request("GET", listOf("projects")))
    /** 复用桌面端已有历史命令；重扫采用服务端的发起即返回、异步轮询协议。 */
    private suspend fun historyCommand(command: String, args: JsonObject = JsonObject(emptyMap())): JsonElement {
        val connection = AiConnection(store.server, store.username, store.token)
        val result = request("POST", listOf("desktop", "invoke", command), args,
            server = connection.server, token = connection.token, client = ai)
        val jobId = (result as? JsonObject)?.text("\$jobId").orEmpty()
        if (jobId.isBlank()) return result
        while (true) {
            delay(500)
            val job = request("GET", listOf("desktop", "jobs", jobId),
                server = connection.server, token = connection.token, client = ai).asObject()
            when (job.text("status")) {
                "done" -> return job["value"] ?: throw ApiException(502, "历史索引任务未返回结果")
                "failed" -> throw ApiException(400, job.text("message", fallback = "历史索引失败"))
                "running" -> Unit
                else -> throw ApiException(502, "历史索引任务状态不正确，请更新服务端")
            }
        }
    }

    suspend fun scanCodexHistory(): AiHistoryScan =
        ApiJson.decodeFromJsonElement(historyCommand("codex_history_rescan"))

    suspend fun codexHistory(): List<AiHistorySession> = ApiJson.decodeFromJsonElement(
        historyCommand("codex_history_list", jsonBody {
            put("includeArchived", false)
            put("projectDir", JsonNull)
        }),
    )

    suspend fun codexHistoryReplay(id: String, offset: Int): AiHistoryReplay = ApiJson.decodeFromJsonElement(
        historyCommand("codex_history_get_replay", jsonBody {
            put("sessionId", id)
            put("offset", offset)
            put("limit", 50)
        }),
    )

    suspend fun resumeCodexHistory(id: String, target: AiProvider, model: AiModel): AiSession =
        ApiJson.decodeFromJsonElement(request("POST", listOf("ai", "codex-history", id, "resume"), jsonBody {
            // 兜底的「服务端默认配置」不是服务端真实供应商，发出去会被旧版服务端判为已删除。
            if (!target.localDefault && target.id.isNotBlank()) put("providerId", target.id)
            if (model.id.isNotBlank()) put("model", model.id)
        }))
    /** 后台正文补偿固定使用任务所属账号，且不占用页面请求队列。 */
    internal suspend fun backgroundSession(id: String, connection: AiConnection): AiSession =
        ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "sessions", id),
            server = connection.server, token = connection.token, client = notificationHttp))

    suspend fun session(id: String): AiSession = ApiJson.decodeFromJsonElement(request("GET", listOf("ai", "sessions", id)))

    suspend fun create(project: AiProject, provider: AiProvider, model: String, resumeSessionId: String? = null): AiSession =
        ApiJson.decodeFromJsonElement(
            request(
                "POST", listOf("ai", "sessions"),
                jsonBody {
                    put("projectPath", project.path)
                    put("provider", provider.agent)
                    // 兜底的「服务端默认配置」不是服务端真实供应商：省略 providerId 让服务端按默认 CLI 配置启动。
                    if (!provider.localDefault && provider.id.isNotBlank()) put("providerId", provider.id)
                    if (model.isNotBlank()) put("model", model.trim())
                    // 恢复历史会话时服务端以历史所在项目为准，此处的项目路径仅作初始提示。
                    if (!resumeSessionId.isNullOrBlank()) put("resumeSessionId", resumeSessionId)
                },
            )
        )

    /** 展开历史列表前的增量索引：本批同步返回，剩余由服务端后台补齐。 */
    suspend fun rescanHistory(agent: String) {
        request("POST", listOf("ai", "history", "rescan"), query = mapOf("agent" to agent))
    }

    suspend fun history(agent: String, projectPath: String): List<AiHistorySession> =
        ApiJson.decodeFromJsonElement(
            request(
                "GET", listOf("ai", "history"),
                query = mapOf("agent" to agent, "projectDir" to projectPath),
            )
        )

    /** requestId 由调用方生成并持久化在内存里；失败重试复用同一个值，服务端据此去重。
     *  steer 为「原生插话」：回复进行中发送时，服务端把消息直接交给当前 CLI 进程。
     *  images 为 base64 图片：服务端校验、落盘后随消息交给多模态模型。 */
    suspend fun send(
        id: String, text: String, requestId: String, steer: Boolean = false,
        images: List<AiSendImage> = emptyList(),
    ): AiSendResult =
        decodeSendResult(
            request("POST", listOf("ai", "sessions", id, "messages"), jsonBody {
                put("text", text)
                put("requestId", requestId)
                if (steer) put("steer", true)
                if (images.isNotEmpty()) put("images", buildJsonArray {
                    images.forEach { image ->
                        addJsonObject {
                            put("data", image.data)
                            put("mediaType", image.mediaType)
                            put("name", image.name)
                        }
                    }
                })
            })
        )

    /** 兼容新服务端的轻量确认与旧服务端返回的完整会话。 */
    private fun decodeSendResult(value: kotlinx.serialization.json.JsonElement): AiSendResult {
        val objectValue = value.asObject()
        return AiSendResult(
            id = objectValue.text("id"),
            requestId = objectValue.text("requestId"),
            revision = objectValue.number("revision")?.toLong() ?: 0,
        )
    }

    /** 「原生插话」排队消息：把该消息直接交给运行中的 CLI 进程，返回最新会话。 */
    suspend fun flush(id: String, requestId: String?): AiSession =
        ApiJson.decodeFromJsonElement(
            request("POST", listOf("ai", "sessions", id, "flush"), jsonBody {
                if (!requestId.isNullOrBlank()) put("requestId", requestId)
            })
        )

    suspend fun deletePendingInput(id: String, requestId: String): AiSession =
        ApiJson.decodeFromJsonElement(
            request("DELETE", listOf("ai", "sessions", id, "pending", requestId))
        )

    suspend fun stop(id: String) {
        request("POST", listOf("ai", "sessions", id, "stop"))
    }

    /** 强制结束：服务端立即摘掉旧 worker 并返回已经落盘的终止快照。 */
    suspend fun forceStop(id: String): AiSession =
        ApiJson.decodeFromJsonElement(request("POST", listOf("ai", "sessions", id, "force-stop")))

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
    fun observe(id: String) = observe(id, AiConnection(store.server, store.username, store.token))

    /** 服务端任务通知：首帧为待决策快照，之后是完成 / 失败 / 决策事件与心跳。 */
    internal fun observeServerNotifications(connection: AiConnection) = callbackFlow<ServerNotificationFrame> {
        val socket = notificationRealtime.newWebSocket(
            Request.Builder().url(ServerAddress.serverNotificationsSocket(connection.server, connection.token))
                .header("User-Agent", USER_AGENT).build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val body = ApiJson.parseToJsonElement(text).asObject()
                        when (body.text("type")) {
                            "snapshot" -> {
                                val decisions = ApiJson.decodeFromJsonElement<List<ServerNotificationEvent>>(
                                    body["decisions"] ?: JsonArray(emptyList()),
                                )
                                trySend(ServerNotificationFrame.Snapshot(decisions))
                            }
                            "event" -> trySend(ServerNotificationFrame.Event(
                                ApiJson.decodeFromJsonElement(body.getValue("event")),
                            ))
                            "heartbeat" -> trySend(ServerNotificationFrame.Heartbeat)
                        }
                    } catch (_: Exception) {
                        close(ApiException(502, "服务端通知消息格式不正确，请更新服务端"))
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    response?.close()
                    close(when (response?.code) {
                        401 -> ApiException(401, "服务登录已过期，请重新登录")
                        404 -> ApiException(404, "服务端暂不支持任务通知，请更新服务端")
                        else -> IOException("服务端通知连接断开", t)
                    })
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    close(IOException("服务端通知连接已关闭"))
                }
            },
        )
        awaitClose { socket.cancel() }
    }.buffer(Channel.CONFLATED)

    /** 服务端通知断线时的决策补偿；服务端较旧时返回 404，由调用方忽略。 */
    internal suspend fun serverDecisions(connection: AiConnection): List<ServerNotificationEvent> =
        ApiJson.decodeFromJsonElement(
            request("GET", listOf("notifications", "decisions"),
                server = connection.server, token = connection.token),
        )

    /** 回答服务端终端决策：answers 以原始问题文本为键，全部回答后由服务端回填 CLI。 */
    internal suspend fun answerServerDecision(
        connection: AiConnection, decisionId: String, answers: Map<String, String>,
    ) {
        request("POST", listOf("notifications", "decisions", decisionId, "answer"), jsonBody {
            put("answers", buildJsonObject { answers.forEach { (question, answer) -> put(question, answer) } })
        }, server = connection.server, token = connection.token)
    }

    /** 首帧、增量快照和空闲心跳均包含全部会话元数据，不传输消息正文。 */
    internal fun observeNotificationSessions(connection: AiConnection) = callbackFlow<List<AiSession>> {
        val socket = notificationRealtime.newWebSocket(
            Request.Builder().url(ServerAddress.aiNotificationsSocket(connection.server, connection.token))
                .header("User-Agent", USER_AGENT).build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val body = ApiJson.parseToJsonElement(text).asObject()
                        if (body.text("type") == "sessions") {
                            trySend(ApiJson.decodeFromJsonElement<List<AiSession>>(body.getValue("sessions")))
                        }
                    } catch (_: Exception) {
                        close(ApiException(502, "AI 通知消息格式不正确，请更新服务端"))
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    val code = response?.code
                    response?.close()
                    close(if (code == 401) ApiException(401, "AI 服务登录已过期，请重新登录")
                        else IOException("AI 后台通知连接断开", t))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close(IOException("AI 后台通知连接已关闭")) }
            },
        )
        awaitClose { socket.cancel() }
    }.buffer(Channel.CONFLATED)

    internal fun observeBackground(id: String, connection: AiConnection) = observe(id, connection, notificationRealtime)

    private fun observe(id: String, connection: AiConnection, client: OkHttpClient = realtime) = callbackFlow<AiSession> {
        val url = ServerAddress.aiSocket(connection.server, id, connection.token)
        var latest: AiSession? = null
        val socket = client.newWebSocket(
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
                        when (response?.code) {
                            401 -> ApiException(401, "AI 服务登录已过期，请重新登录")
                            404 -> ApiException(404, "该任务已删除或当前账号无法访问")
                            else -> IOException("AI 实时连接断开", t)
                        }
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
        server: String = store.server, token: String = store.token, client: OkHttpClient? = null,
        query: Map<String, String> = emptyMap(),
    ): JsonElement = suspendCancellableCoroutine { continuation ->
        val request = Request.Builder()
            .url(ServerAddress.endpoint(server, path, query))
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .apply { if (token.isNotBlank()) header("Authorization", "Bearer $token") }
            .method(method, payloadFor(method, body))
            .build()
        val call = (client ?: if (path.firstOrNull() == "ai") ai else http).newCall(request)
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
