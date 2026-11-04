package com.terminalbuddy.android.data

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 与网页端共用项目、配置与 PTY 接口。创建终端的 POST 不自动重试。 */
internal class ServerTerminalRepository {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS).retryOnConnectionFailure(false)
        .followRedirects(false).followSslRedirects(false).build()
    private val realtime = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS).pingInterval(15, TimeUnit.SECONDS).build()

    suspend fun catalog(connection: AiConnection): ServerTerminalCatalog = coroutineScope {
        val projects = async { ApiJson.decodeFromJsonElement<List<AiProject>>(request(connection, "GET", listOf("projects"))) }
        val profiles = async { ApiJson.decodeFromJsonElement<List<ServerProfile>>(request(connection, "GET", listOf("profiles"))) }
        val activeTerminals = async { terminals(connection) }
        ServerTerminalCatalog(projects.await(), profiles.await(), activeTerminals.await())
    }

    suspend fun terminals(connection: AiConnection): List<ServerTerminal> =
        ApiJson.decodeFromJsonElement<List<ServerTerminal>>(request(connection, "GET", listOf("terminals")))
            .filter { it.owner == "web" }

    suspend fun start(connection: AiConnection, profileId: String): ServerTerminal =
        ApiJson.decodeFromJsonElement(request(connection, "POST", listOf("terminals"), jsonBody {
            put("profileId", profileId)
            put("rows", 0)
            put("cols", 0)
        }))

    /** Agent 基础启动命令：手机「开始对话」按所选助手在服务端开一个真实终端。 */
    suspend fun runtimeInfo(connection: AiConnection): AgentRuntimeInfo =
        ApiJson.decodeFromJsonElement(request(connection, "GET", listOf("runtime")))

    /**
     * 创建空白终端并注入 Agent 启动命令（空 profileId 走 `create_blank_terminal`）。
     * 终端归属 Web、创建来源按 User-Agent 记为 Mobile；电脑端终端列表立即可见。
     */
    suspend fun startAgent(
        connection: AiConnection, startupCommand: String, projectPath: String, projectName: String,
    ): ServerTerminal = ApiJson.decodeFromJsonElement(request(connection, "POST", listOf("terminals"), jsonBody {
        put("profileId", "")
        put("rows", 0)
        put("cols", 0)
        put("startupPath", projectPath)
        put("startupCommand", startupCommand)
        put("displayName", projectName)
        put("startupGroup", projectName)
    }))

    suspend fun close(connection: AiConnection, id: String) {
        request(connection, "DELETE", listOf("terminals", id))
    }

    fun connect(connection: AiConnection, id: String, listener: WebSocketListener): WebSocket {
        val url = ServerAddress.terminalSocket(connection.server, id, connection.token)
        return realtime.newWebSocket(Request.Builder().url(url).header("User-Agent", USER_AGENT).build(), listener)
    }

    private suspend fun request(
        connection: AiConnection, method: String, path: List<String>, body: JsonElement? = null,
    ): JsonElement = suspendCancellableCoroutine { continuation ->
        val payload = if (method == "POST") (body ?: JsonObject(emptyMap())).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType()) else null
        val call = http.newCall(Request.Builder()
            .url(ServerAddress.endpoint(connection.server, path))
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
                        if (!response.isSuccessful) {
                            val fallback = when (response.code) {
                                401 -> "登录已过期，请重新登录"
                                403 -> "没有操作此终端的权限"
                                404 -> "配置或终端已不存在，请刷新列表"
                                else -> "服务端请求失败（${response.code}）"
                            }
                            throw ApiException(response.code, value.asObject().text("message", fallback = fallback))
                        }
                        value ?: throw ApiException(502, "服务端返回格式不正确，请更新 TerminalBuddy 服务端")
                    }
                }
                if (continuation.isActive) result.fold({ continuation.resume(it) }, { continuation.resumeWithException(it) })
            }
        })
    }

    private companion object { const val USER_AGENT = "TerminalBuddy-Android/1.0" }
}
