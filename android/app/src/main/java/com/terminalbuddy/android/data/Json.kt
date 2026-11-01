package com.terminalbuddy.android.data

import kotlinx.serialization.json.*

/** 宽松解析：服务端新增字段不应让旧客户端崩溃；显式 null 视为缺省。 */
val ApiJson = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }

fun JsonElement?.asObject(): JsonObject = this as? JsonObject ?: JsonObject(emptyMap())
fun JsonElement?.asArray(): List<JsonElement> = (this as? JsonArray)?.toList().orEmpty()

fun JsonObject.text(vararg keys: String, fallback: String = ""): String = keys.firstNotNullOfOrNull {
    (this[it] as? JsonPrimitive)?.contentOrNull?.takeIf { value -> value != "null" }
} ?: fallback

fun JsonObject.number(vararg keys: String): Double? = keys.firstNotNullOfOrNull {
    (this[it] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.takeIf(Double::isFinite)
}

fun JsonObject.rows(vararg keys: String): List<JsonElement> =
    keys.firstNotNullOfOrNull { this[it] as? JsonArray }?.toList().orEmpty()

fun jsonBody(block: JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject(block)

/** 网络层异常：HTTP 状态码 + 已转成中文的服务端提示。 */
class ApiException(val code: Int, override val message: String) : java.io.IOException(message)

/** 登录等需要用户手动处理的连接失败文案。 */
const val ServerUnreachableMessage = "无法连接服务器，请检查服务地址和网络"

/** 仅传输异常自动重连；HTTP 业务错误（包括登录过期）保留原有处理。 */
fun Throwable.isConnectionFailure(): Boolean = this is java.io.IOException && this !is ApiException

fun Throwable.userMessage(): String = when (this) {
    is ApiException -> message
    // 终端 Agent 的结构化异常已带服务端中文提示（含 decisionId / Retry-After 语义），不能落入通用 IOException 文案。
    is TerminalAgentException -> message
    is java.net.SocketTimeoutException -> "请求超时，请稍后重试"
    is java.io.IOException -> ServerUnreachableMessage
    is IllegalArgumentException -> message ?: "输入内容不正确"
    else -> message?.take(240) ?: "操作失败，请重试"
}
