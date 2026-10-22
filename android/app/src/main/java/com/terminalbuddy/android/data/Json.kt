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

/** 服务器连不上时的统一文案，界面据此把提示收敛为「重连中」。 */
const val ServerUnreachableMessage = "无法连接服务器，请检查服务地址和网络"

fun Throwable.userMessage(): String = when (this) {
    is ApiException -> message
    is java.net.SocketTimeoutException -> "请求超时，请稍后重试"
    is java.io.IOException -> ServerUnreachableMessage
    is IllegalArgumentException -> message ?: "输入内容不正确"
    else -> message?.take(240) ?: "操作失败，请重试"
}
