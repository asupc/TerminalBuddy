package com.terminalbuddy.android.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * 终端 Agent 会话接力的 REST / WS 模型，与服务端 `terminal_agent_relay` 的 camelCase 协议一致。
 * 消息直接复用历史回放的 `AiHistoryMessage` / `AiHistoryTool`（字段同构，不另造一套）。
 */

/** 镜像可用性：不可用时 reason 为服务端给出的原因代码（如 transcript_too_large）。 */
@Serializable
data class TerminalAgentMirror(val available: Boolean = true, val reason: String? = null)

/** 列表 / 首帧 / 状态更新共用的会话元数据。 */
@Serializable
data class TerminalAgentSession(
    val terminalId: String,
    val profileName: String = "",
    val terminalType: String = "",
    val directory: String? = null,
    val provider: String = "claude",
    val sessionId: String = "",
    val title: String? = null,
    val model: String? = null,
    val phase: String = "unknown",
    val phaseAt: Long? = null,
    val lastActivityAt: Long? = null,
    val pendingDecisionId: String? = null,
    val pendingDecisionCount: Int = 0,
    val canReply: Boolean = false,
    val replyBlockedReason: String? = null,
    val revision: Long = 0,
    val mirror: TerminalAgentMirror = TerminalAgentMirror(),
) {
    val displayTitle: String
        get() = title?.takeIf(String::isNotBlank)
            ?: profileName.takeIf(String::isNotBlank)
            ?: "终端会话"

    /** 阶段的界面文案；无 Hook 时后端给 unknown，不编造执行中。 */
    val phaseLabel: String
        get() = when (phase) {
            "attention" -> "等待确认"
            "running" -> "正在执行"
            "idle" -> "等待输入"
            "completed" -> "已完成"
            "failed" -> "执行失败"
            "ended" -> "已结束"
            else -> "状态未知"
        }
}

/**
 * 历史会话与实时 Agent 列表的匹配：provider + sessionId 相同且尚未结束（phase != ended）
 * 视为「正在电脑/服务端终端里运行」，点击应走接力接管而不是恢复历史（避免另起进程分叉与旧索引数据）。
 * ended 表示 agent 已退出、终端回到 shell，继续会话应走现有「恢复历史」路径。
 */
fun findLiveAgentSession(
    agent: String, sessionId: String, sessions: List<TerminalAgentSession>,
): TerminalAgentSession? = sessions.firstOrNull {
    it.provider == agent && it.sessionId == sessionId && it.phase != "ended"
}

/** 消息页：首屏快照与限界增量共用同一响应，客户端先看 resetRequired / revision 再处理消息。 */
@Serializable
data class TerminalAgentPage(
    val session: TerminalAgentSession,
    val messages: List<AiHistoryMessage> = emptyList(),
    val cursor: Long = -1,
    val total: Long = 0,
    val truncated: Boolean = false,
    val hasMore: Boolean = false,
    val nextCursor: Long = -1,
    val oldestRetainedSeq: Long? = null,
    val resetRequired: Boolean = false,
)

/** 回复写入结果；送达与否由镜像判定，不在此返回。 */
@Serializable
data class TerminalAgentReplyOutcome(
    val accepted: Boolean = false,
    val duplicated: Boolean = false,
    val phase: String = "",
    val at: Long = 0,
)

/**
 * `/ws/terminal-agents/{id}` 的推送帧，按 `type` 手动解析成 sealed class。
 * 协议约束：首帧只能是 Mirror 或 Unavailable；append 仅同 revision；
 * mirror / rotated / unavailable 都要求清空重建；error 帧之后连接即结束。
 */
sealed class TerminalAgentFrame {
    abstract val terminalId: String

    /** 首帧、需要重建、从不可用恢复：完整尾页快照（rotated 的 payload 与之相同）。 */
    data class Mirror(
        override val terminalId: String,
        val session: TerminalAgentSession,
        val messages: List<AiHistoryMessage>,
        val cursor: Long,
        val total: Long,
        val truncated: Boolean,
        val oldestRetainedSeq: Long?,
    ) : TerminalAgentFrame()

    /** 同 revision 的纯尾部追加；revision 不同时忽略，等服务端补 mirror。 */
    data class Append(
        override val terminalId: String,
        val messages: List<AiHistoryMessage>,
        val revision: Long,
        val cursor: Long,
        val total: Long,
        val truncated: Boolean,
        val hasMore: Boolean,
        val nextCursor: Long,
        val oldestRetainedSeq: Long?,
    ) : TerminalAgentFrame()

    /** 阶段 / 决策 / 回复闸门变化：完整 session 覆盖旧元数据。 */
    data class Status(
        override val terminalId: String,
        val session: TerminalAgentSession,
    ) : TerminalAgentFrame()

    /** 换绑、路径或旧消息变化：清空后采用完整尾页。 */
    data class Rotated(
        override val terminalId: String,
        val session: TerminalAgentSession,
        val messages: List<AiHistoryMessage>,
        val cursor: Long,
        val total: Long,
        val truncated: Boolean,
        val oldestRetainedSeq: Long?,
    ) : TerminalAgentFrame()

    /** 镜像降级：清空旧消息并显示原因。 */
    data class Unavailable(
        override val terminalId: String,
        val session: TerminalAgentSession,
        val reason: String,
    ) : TerminalAgentFrame()

    /** 终端关闭 / 失权 / 不可恢复错误：连接随帧结束，不再重连。 */
    data class Error(
        override val terminalId: String,
        val code: String,
        val message: String,
    ) : TerminalAgentFrame()

    companion object {
        /** 未知 type 或消息数组解码失败返回 null，由调用方按协议错误处理：
         *  保留旧镜像并提示格式不正确，append 也不会前移 cursor。 */
        fun parse(body: JsonObject): TerminalAgentFrame? {
            val terminalId = body.text("terminalId")
            if (terminalId.isBlank()) return null
            val session = (body["session"] as? JsonObject)?.let {
                runCatching { ApiJson.decodeFromJsonElement<TerminalAgentSession>(it) }.getOrNull()
            }
            return when (body.text("type")) {
                "mirror" -> if (session == null) null else Mirror(
                    terminalId = terminalId, session = session,
                    messages = body.decodeMessages() ?: return null,
                    cursor = body.long("cursor") ?: -1,
                    total = body.long("total") ?: 0,
                    truncated = body.bool("truncated"),
                    oldestRetainedSeq = body.long("oldestRetainedSeq"),
                )
                "rotated" -> if (session == null) null else Rotated(
                    terminalId = terminalId, session = session,
                    messages = body.decodeMessages() ?: return null,
                    cursor = body.long("cursor") ?: -1,
                    total = body.long("total") ?: 0,
                    truncated = body.bool("truncated"),
                    oldestRetainedSeq = body.long("oldestRetainedSeq"),
                )
                "append" -> Append(
                    terminalId = terminalId,
                    messages = body.decodeMessages() ?: return null,
                    revision = body.long("revision") ?: 0,
                    cursor = body.long("cursor") ?: -1,
                    total = body.long("total") ?: 0,
                    truncated = body.bool("truncated"),
                    hasMore = body.bool("hasMore"),
                    nextCursor = body.long("nextCursor") ?: -1,
                    oldestRetainedSeq = body.long("oldestRetainedSeq"),
                )
                "status" -> session?.let { Status(terminalId, it) }
                "unavailable" -> session?.let {
                    Unavailable(terminalId, it, body.text("reason", fallback = "transcript_unreadable"))
                }
                "error" -> Error(
                    terminalId = terminalId,
                    code = body.text("code", fallback = "internal"),
                    message = body.text("message", fallback = "终端会话连接已结束"),
                )
                else -> null
            }
        }

        /** 携带消息的帧（mirror / rotated / append）里 messages 必有且必须可解码；缺失或失败均视为整帧格式错误。 */
        private fun JsonObject.decodeMessages(): List<AiHistoryMessage>? =
            (this["messages"] as? kotlinx.serialization.json.JsonArray)?.let {
                runCatching { ApiJson.decodeFromJsonElement<List<AiHistoryMessage>>(it) }.getOrNull()
            }
    }
}

private fun JsonObject.long(vararg keys: String): Long? = keys.firstNotNullOfOrNull { key ->
    when (val value = this[key]) {
        is JsonPrimitive -> value.contentOrNull?.toLongOrNull()
        else -> null
    }
}

private fun JsonObject.bool(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.contentOrNull == "true"

/**
 * 终端 Agent 接口的结构化异常：保留 409 的 decisionId / replyBlockedReason
 * 与 429 的 Retry-After（秒），仅有 message 的通用封装不够用。
 */
class TerminalAgentException(
    val code: Int,
    override val message: String,
    val decisionId: String? = null,
    val replyBlockedReason: String? = null,
    val retryAfterSecs: Int? = null,
) : java.io.IOException(message)
