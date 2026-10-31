package com.terminalbuddy.android.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * TerminalBuddy 服务地址的规范化与接口拼接。
 * 支持反向代理子目录（例如 https://服务器/terminalbuddy/），末尾多余的 `/api` 会被去掉，
 * 因为本客户端自己按 `/api/<分段>` 拼路径。
 */
object ServerAddress {
    fun normalize(input: String): String {
        val url = input.trim().toHttpUrlOrNull()
            ?: throw IllegalArgumentException("请输入完整的服务地址，例如 http://192.168.1.10:9600")
        require(url.username.isEmpty() && url.password.isEmpty()) { "服务地址中不能包含账号或密码" }
        require(url.query == null && url.fragment == null) { "服务地址不能包含查询参数或页面锚点" }
        var path = url.encodedPath.trimEnd('/')
        if (path.endsWith("/api")) path = path.removeSuffix("/api")
        return url.newBuilder().encodedPath(if (path.isBlank()) "/" else "$path/").build().toString()
    }

    fun endpoint(server: String, segments: List<String>, query: Map<String, String> = emptyMap()): HttpUrl {
        val builder = normalize(server).toHttpUrlOrNull()!!.newBuilder().addPathSegment("api")
        segments.forEach(builder::addPathSegment)
        query.forEach { (key, value) -> builder.addQueryParameter(key, value) }
        return builder.build()
    }

    /** 账号级后台通知通道，与当前打开的对话无关。 */
    fun aiNotificationsSocket(server: String, token: String): HttpUrl =
        normalize(server).toHttpUrlOrNull()!!.newBuilder()
            .addPathSegment("ws").addPathSegment("ai")
            .addQueryParameter("token", token).build()

    /** 服务端任务通知：完成 / 失败与待决策事件，独立于 AI 会话通知。 */
    fun serverNotificationsSocket(server: String, token: String): HttpUrl =
        normalize(server).toHttpUrlOrNull()!!.newBuilder()
            .addPathSegment("ws").addPathSegment("notifications")
            .addQueryParameter("token", token).build()

    /** 原生 AI 实时通道：`/ws/ai/{id}?token=...`。 */
    fun aiSocket(server: String, sessionId: String, token: String): HttpUrl =
        normalize(server).toHttpUrlOrNull()!!.newBuilder()
            .addPathSegment("ws").addPathSegment("ai").addPathSegment(sessionId)
            .addQueryParameter("token", token).build()

    /** 与网页端共用终端回放、尺寸接管和输入协议，保留反向代理子路径。 */
    fun terminalSocket(server: String, terminalId: String, token: String): HttpUrl =
        normalize(server).toHttpUrlOrNull()!!.newBuilder()
            .addPathSegment("ws").addPathSegment("terminal").addPathSegment(terminalId)
            .addQueryParameter("token", token).addQueryParameter("replay", "1")
            .addQueryParameter("takeover", "1").addQueryParameter("viewport", "1").build()

}
