package com.terminalbuddy.android.data

import android.content.Context
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 仅连接 TerminalBuddy 免登录更新接口，永不请求或发送葫芦娃后台令牌。 */
class AppUpdateRepository(context: Context) {
    private val preferences = context.getSharedPreferences("terminal_buddy_build_selection", Context.MODE_PRIVATE)
    private val legacy = context.getSharedPreferences("terminal_buddy_build_connection", Context.MODE_PRIVATE)
    @Volatile var server: String = preferences.getString("public_server", null)
        ?: legacy.getString("server", "").orEmpty(); private set
    val connected get() = server.isNotBlank()

    init {
        // 旧版只迁移地址；删除构建功能曾保存的后台令牌，不再实例化旧认证存储。
        if (server.isNotBlank()) preferences.edit().putString("public_server", server).apply()
        legacy.edit().clear().apply()
    }
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    private val project = listOf("public", "terminalbuddy", "android")

    fun selectedServer(): String = preferences.getString(server, "local").orEmpty().ifBlank { "local" }
    fun selectServer(id: String) { preferences.edit().putString(server, id).apply() }

    suspend fun connect(address: String) {
        val normalized = normalizeAddress(address)
        val servers = request("GET", project + "servers", server = normalized)
        require(servers is JsonArray) { "此地址未提供独立更新接口，请先更新葫芦娃后端" }
        check(preferences.edit().putString("public_server", normalized).commit()) { "无法保存服务地址" }
        server = normalized
    }

    @Synchronized private fun clientId(address: String): String {
        val key = "client:$address"
        preferences.getString(key, null)?.let { return it }
        val id = UUID.randomUUID().toString().replace("-", "")
        check(preferences.edit().putString(key, id).commit()) { "无法保存更新客户端标识" }
        return id
    }

    suspend fun status(serverId: String): AndroidBuildStatus = try {
        AndroidBuildStatus.from(request("GET", project + "status", query = mapOf("serverId" to serverId)).asObject())
    } catch (error: ApiException) {
        // 曾选节点被移除时回到服务端默认节点，避免永久卡在无法选择节点的首屏。
        if (error.code == 404 && serverId != "local") status("local") else throw error
    }
    suspend fun tasks(): List<AndroidBuildTask> = request("GET", project + "tasks").asArray().map { AndroidBuildTask.from(it.asObject()) }
    suspend fun logs(id: Long, cursor: Long) = AndroidLogChunk.from(
        request("GET", project + listOf("tasks", "$id", "logs"), query = mapOf("cursor" to "$cursor")).asObject())
    suspend fun build(serverId: String) = AndroidBuildTask.from(
        request("POST", project + "build", query = mapOf("serverId" to serverId)).asObject())
    suspend fun cancel(id: Long) = request("POST", project + listOf("tasks", "$id", "cancel"))
    suspend fun ticket(id: Long, logFile: Boolean) = request("POST", project + listOf("tasks", "$id", "download-ticket"),
        jsonBody { put("logFile", logFile) }).asObject()

    private suspend fun request(
        method: String, path: List<String>, body: JsonElement? = null, query: Map<String, String> = emptyMap(),
        server: String = this.server,
    ): JsonElement = suspendCancellableCoroutine { continuation ->
        val builder = Request.Builder().url(ServerAddress.endpoint(server, path, query)).header("Accept", "application/json")
        builder.header("X-TerminalBuddy-Client", clientId(server))
        builder.method(method, if (method == "POST") (body?.toString() ?: "{}")
            .toRequestBody("application/json; charset=utf-8".toMediaType()) else null)
        val call = http.newCall(builder.build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }
            override fun onResponse(call: Call, response: Response) {
                val result = response.use {
                    runCatching {
                        val raw = runCatching { ApiJson.parseToJsonElement(response.body?.string().orEmpty()) }.getOrNull() as? JsonObject
                        if (!response.isSuccessful) throw ApiException(response.code,
                            raw?.text("message")?.ifBlank { null } ?: if (response.code == 404)
                                "服务未提供免登录更新接口，请先更新葫芦娃后端或确认服务地址" else "请求失败（${response.code}）")
                        if (raw == null || !raw.containsKey("code")) throw ApiException(502, "返回格式不正确，请填写 TerminalBuddy 更新服务地址")
                        val code = raw.number("code")?.toInt() ?: 502
                        if (code != 200) throw ApiException(code, raw.text("message", fallback = "操作失败"))
                        raw["data"] ?: JsonNull
                    }
                }
                if (continuation.isActive) result.fold({ continuation.resume(it) }, { continuation.resumeWithException(it) })
            }
        })
    }

    companion object {
        /** 支持独立更新接口完整地址及旧版服务地址，保留反向代理子路径。 */
        fun normalizeAddress(input: String): String {
            val parsed = input.trim().toHttpUrlOrNull()
                ?: throw IllegalArgumentException("请输入完整的更新服务地址，例如 http://taihe.678120.cn:8086")
            val path = parsed.encodedPath.trimEnd('/')
            val suffix = listOf("/api/public/terminalbuddy/android", "/api/terminalbuddy/android", "/api/android").firstOrNull { path.endsWith(it) }
            val url = if (suffix == null) parsed else parsed.newBuilder().encodedPath(path.removeSuffix(suffix).ifBlank { "/" }).build()
            return ServerAddress.normalize(url.toString())
        }
    }
}
