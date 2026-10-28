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
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 复用葫芦娃的 TerminalBuddy 构建接口，认证与终端服务完全独立。 */
class AppUpdateRepository(context: Context) {
    val store = SessionStore(context, "terminal_buddy_build_connection", "terminal_buddy_build_session_v1")
    private val preferences = context.getSharedPreferences("terminal_buddy_build_selection", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    private val project = listOf("terminalbuddy", "android")

    fun selectedServer(): String = preferences.getString(store.server, "local").orEmpty().ifBlank { "local" }
    fun selectServer(id: String) { preferences.edit().putString(store.server, id).apply() }

    suspend fun login(address: String, username: String, password: String) {
        val server = normalizeAddress(address)
        val user = username.trim().ifBlank { "admin" }
        val data = request("POST", listOf("auth", "login"), jsonBody {
            put("username", user); put("password", password)
        }, server = server, token = "").asObject()
        val token = data.text("token")
        require(token.isNotBlank()) { "服务未返回登录令牌，请确认葫芦娃服务地址" }
        // 登录成功还需确认项目接口存在，避免误连终端服务或旧版本后端。
        request("GET", project + "servers", server = server, token = token)
        store.save(server, data.text("username", fallback = user), token)
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
        server: String = store.server, token: String = store.token,
    ): JsonElement = suspendCancellableCoroutine { continuation ->
        val builder = Request.Builder().url(ServerAddress.endpoint(server, path, query)).header("Accept", "application/json")
        if (token.isNotBlank()) builder.header("Authorization", "Bearer $token")
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
                                "服务未提供 TerminalBuddy 打包接口，请确认葫芦娃服务地址及后端版本" else "请求失败（${response.code}）")
                        if (raw == null || !raw.containsKey("code")) throw ApiException(502, "返回格式不正确，请填写葫芦娃服务地址")
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
        /** 同时接受主服务地址和葫芦娃已有的打包 API 地址，保留反向代理子路径。 */
        fun normalizeAddress(input: String): String {
            val parsed = input.trim().toHttpUrlOrNull()
                ?: throw IllegalArgumentException("请输入完整的葫芦娃服务地址，例如 http://taihe.678120.cn:8086")
            val path = parsed.encodedPath.trimEnd('/')
            val suffix = listOf("/api/terminalbuddy/android", "/api/android").firstOrNull { path.endsWith(it) }
            val url = if (suffix == null) parsed else parsed.newBuilder().encodedPath(path.removeSuffix(suffix).ifBlank { "/" }).build()
            return ServerAddress.normalize(url.toString())
        }
    }
}
