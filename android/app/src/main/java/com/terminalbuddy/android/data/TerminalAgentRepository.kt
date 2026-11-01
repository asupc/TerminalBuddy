package com.terminalbuddy.android.data

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 终端 Agent 会话接力的 REST + WS 客户端。
 * 列表是不受 owner 过滤的独立数据源（与 `/api/terminals` 不同，不能互相推导）；
 * 错误统一抛 [TerminalAgentException]，保留 409 的 decisionId 与 429 的 Retry-After。
 */
internal class TerminalAgentRepository {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS).retryOnConnectionFailure(false)
        .followRedirects(false).followSslRedirects(false).build()

    /** 镜像推送：服务端每 10 秒发协议 Ping，OkHttp 自动回 Pong，客户端不发业务帧。 */
    private val realtime = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS).pingInterval(15, TimeUnit.SECONDS).build()

    suspend fun sessions(connection: AiConnection): List<TerminalAgentSession> =
        ApiJson.decodeFromJsonElement(request(connection, "GET", listOf("terminal-agents")))

    /**
     * 消息页：不带 afterSeq 为首屏尾页快照（调用方清空后整体采用）；
     * 带 afterSeq 且 revision 相同为增量。resetRequired=true 时同样必须清空重建。
     */
    suspend fun messages(
        connection: AiConnection, terminalId: String,
        afterSeq: Long? = null, limit: Int? = null, revision: Long? = null,
    ): TerminalAgentPage {
        val query = buildMap {
            afterSeq?.let { put("afterSeq", it.toString()) }
            limit?.let { put("limit", it.toString()) }
            revision?.let { put("revision", it.toString()) }
        }
        return ApiJson.decodeFromJsonElement(
            request(connection, "GET", listOf("terminal-agents", terminalId, "messages"), query = query),
        )
    }

    suspend fun reply(
        connection: AiConnection, terminalId: String, text: String, requestId: String,
    ): TerminalAgentReplyOutcome = ApiJson.decodeFromJsonElement(
        request(connection, "POST", listOf("terminal-agents", terminalId, "reply"), jsonBody {
            put("text", text)
            put("requestId", requestId)
        }),
    )

    fun connect(connection: AiConnection, terminalId: String, listener: WebSocketListener): WebSocket {
        val url = ServerAddress.terminalAgentSocket(connection.server, terminalId, connection.token)
        return realtime.newWebSocket(Request.Builder().url(url).header("User-Agent", USER_AGENT).build(), listener)
    }

    private suspend fun request(
        connection: AiConnection, method: String, path: List<String>,
        body: JsonElement? = null, query: Map<String, String> = emptyMap(),
    ): JsonElement = suspendCancellableCoroutine { continuation ->
        val payload = if (method == "POST") (body ?: JsonObject(emptyMap())).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType()) else null
        val call = http.newCall(Request.Builder()
            .url(ServerAddress.endpoint(connection.server, path, query))
            .header("Authorization", "Bearer ${connection.token}")
            .header("User-Agent", USER_AGENT).header("Accept", "application/json")
            .method(method, payload).build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }
            override fun onResponse(call: Call, response: Response) {
                val result = response.use {
                    runCatching {
                        val value = runCatching { ApiJson.parseToJsonElement(response.body?.string().orEmpty()) }.getOrNull()
                        if (!response.isSuccessful) throw errorOf(response, value.asObject())
                        value ?: throw TerminalAgentException(502, "服务端返回格式不正确，请更新 TerminalBuddy 服务端")
                    }
                }
                result.fold({ if (continuation.isActive) continuation.resume(it) },
                    { if (continuation.isActive) continuation.resumeWithException(it) })
            }
        })
    }

    /** 组装结构化异常：429 读 Retry-After 头，409 保留 decisionId / replyBlockedReason。 */
    private fun errorOf(response: Response, body: JsonObject): TerminalAgentException {
        val fallback = when (response.code) {
            401 -> "登录已过期，请重新登录"
            403 -> "没有操作此终端的权限"
            404 -> "该终端没有正在运行的 Agent 或已关闭"
            else -> "服务端请求失败（${response.code}）"
        }
        val message = body.text("message", fallback = fallback)
        val retryAfter = response.header("Retry-After")?.trim()?.toIntOrNull()?.takeIf { it >= 0 }
        return TerminalAgentException(
            code = response.code,
            message = message,
            decisionId = body.textOrNull("decisionId"),
            replyBlockedReason = body.textOrNull("replyBlockedReason"),
            retryAfterSecs = retryAfter,
        )
    }

    private fun JsonObject.textOrNull(key: String): String? =
        (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank)

    private companion object { const val USER_AGENT = "TerminalBuddy-Android/1.0" }
}
