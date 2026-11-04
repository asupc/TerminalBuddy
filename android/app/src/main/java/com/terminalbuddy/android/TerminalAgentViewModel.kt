package com.terminalbuddy.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.terminalbuddy.android.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** 回复写入后的本地确认状态：已写入 PTY → 镜像出现匹配 user 消息即已送达。
 *  REST 被接受就意味着 PTY 写入成功；超时只说明 Agent 还没处理（排队 / 长任务），
 *  不存在「未生效」——写失败以请求错误返回，根本不会产生本地气泡。 */
enum class TerminalReplyStatus { Typed, Delivered, Unconfirmed }

/** 等待镜像确认的本地回复；sessionId/revision/sentAfterSeq 共同排除历史与换代后的同文旧消息。 */
internal data class PendingTerminalReply(
    val text: String,
    val requestId: String,
    val sentAt: Long,
    val sessionId: String,
    val revision: Long,
    val status: TerminalReplyStatus = TerminalReplyStatus.Typed,
    val sentAfterSeq: Long = -1,
) {
    val statusLabel: String
        get() = when (status) {
            TerminalReplyStatus.Typed -> "已发送到终端"
            TerminalReplyStatus.Delivered -> "已送达"
            TerminalReplyStatus.Unconfirmed -> "已发送，等待 Agent 处理"
        }
}

/**
 * 终端 Agent 会话接力的状态：列表是独立数据源（不从普通终端列表推导），
 * 镜像以 WS 首帧原子快照为基准，账号切换 / 离开页面会立刻取消一切在途任务。
 */
internal data class TerminalAgentUiState(
    val connection: AiConnection? = null,
    // 列表：GET /api/terminal-agents 的完整结果
    val sessions: List<TerminalAgentSession> = emptyList(),
    val listLoading: Boolean = false,
    val listLoaded: Boolean = false,
    val listError: String? = null,
    // 选中的会话与镜像
    val selected: TerminalAgentSession? = null,
    val messages: List<AiHistoryMessage> = emptyList(),
    val revision: Long = 0,
    val cursor: Long = -1,
    val total: Long = 0,
    val loadingMessages: Boolean = false,
    val messagesError: String? = null,
    val connected: Boolean = false,
    val reconnecting: Boolean = false,
    /** 终端关闭 / 失权等终态：不再自动重连，只能手动刷新或返回。 */
    val closed: Boolean = false,
    val closedReason: String? = null,
    // 回复
    val draft: String = "",
    val sending: Boolean = false,
    val pendingReply: PendingTerminalReply? = null,
    val sendError: String? = null,
    // 列表长按关闭服务端 Agent（终端）
    val closingTerminalId: String? = null,
    val closeError: String? = null,
)

internal class TerminalAgentViewModel(application: Application) : AndroidViewModel(application) {
    private val aiRepository = (application as TerminalBuddyApplication).aiRepository
    private val store = aiRepository.store
    private val repository = TerminalAgentRepository()
    private val mutable = MutableStateFlow(TerminalAgentUiState())
    val state = mutable.asStateFlow()

    private var generation = 0
    private var streamGeneration = 0
    private var listJob: Job? = null
    private var listRetryJob: Job? = null
    private var listRetries = 0
    private var pageJob: Job? = null
    private var replyJob: Job? = null
    private var confirmJob: Job? = null
    private var retryJob: Job? = null
    private var closeJob: Job? = null
    private var socket: WebSocket? = null
    private var visible = false
    private var attempts = 0
    fun isCurrentAccount(): Boolean = store.loggedIn && mutable.value.connection ==
        AiConnection(store.server, store.username, store.token)

    // ─────────────── 列表实时同步：/ws/notifications 的 terminals_changed ───────────────

    /** 终端创建 / 关闭的联动信号：Agent 列表在 VM 内自刷，普通终端列表由首页订阅此流刷新。 */
    private val terminalListChangedFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    val terminalListChanged: SharedFlow<Unit> = terminalListChangedFlow.asSharedFlow()
    private var notifyJob: Job? = null
    /** 在途 refresh 期间又收到变化时补刷一次，避免防重入吞掉最后一次列表变化。 */
    private var refreshAgain = false

    /** 订阅服务端终端列表变化事件；断线按 1s→2s→4s→8s 退避重连，旧服务端（404）静默降级。 */
    private fun startListSync() {
        notifyJob?.cancel(); notifyJob = null
        val connection = mutable.value.connection ?: return
        val epoch = generation
        notifyJob = viewModelScope.launch {
            var retries = 0
            while (isActive && epoch == generation) {
                val observed = runCatching {
                    aiRepository.observeServerNotifications(connection).collect { frame ->
                        // 账号已切换：忽略旧连接的后续帧（bindAccount 会取消本协程）。
                        if (epoch != generation) return@collect
                        if (frame is ServerNotificationFrame.Event &&
                            frame.event.kind == "terminals_changed"
                        ) {
                            retries = 0
                            refresh()
                            terminalListChangedFlow.tryEmit(Unit)
                        }
                    }
                }
                if (!isActive || epoch != generation) break
                // 正常关闭（cancel / 账号切换）不重连；异常才退避重试。
                if (observed.isFailure) {
                    delay(1_000L shl retries.coerceAtMost(3))
                    retries = (retries + 1).coerceAtMost(3)
                }
            }
        }
    }

    /** 账号切换：作废全部在途回调，关闭镜像连接并清空选中会话、消息、代次与草稿。 */
    fun bindAccount() {
        val connection = if (store.loggedIn) AiConnection(store.server, store.username, store.token) else null
        if (mutable.value.connection == connection) return
        generation++
        listJob?.cancel(); listJob = null
        listRetryJob?.cancel(); listRetryJob = null
        listRetries = 0
        pageJob?.cancel(); pageJob = null
        replyJob?.cancel(); replyJob = null
        confirmJob?.cancel(); confirmJob = null
        closeJob?.cancel(); closeJob = null
        notifyJob?.cancel(); notifyJob = null
        disconnect()
        visible = false
        refreshAgain = false
        mutable.value = TerminalAgentUiState(connection = connection)
        startListSync()
    }

    /** 拉取 Agent 会话列表；与普通终端列表各自 loading / error，互不影响。
     *  在途时再次调用只标记补刷（finally 里兑现），通知事件连发不会漏掉最后一次变化。
     *  网络类失败不提示，按 1s→2s→4s→8s 退避自动重试；确定性失败（404 等）才落到 listError。 */
    fun refresh() {
        val connection = mutable.value.connection ?: return
        if (listJob?.isActive == true) {
            refreshAgain = true
            return
        }
        val epoch = generation
        listJob = viewModelScope.launch {
            mutable.update { it.copy(listLoading = true, listError = null) }
            try {
                val sessions = repository.sessions(connection)
                if (epoch != generation) return@launch
                listRetryJob?.cancel(); listRetryJob = null
                listRetries = 0
                mutable.update { state ->
                    state.copy(sessions = sessions, listLoaded = true)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    if (e.isRetryableListFailure()) {
                        scheduleListRetry(epoch)
                    } else {
                        mutable.update {
                            it.copy(listError = if (e is TerminalAgentException && e.code == 404)
                                "服务端暂不支持终端 Agent 会话，请更新 TerminalBuddy 服务端" else e.userMessage())
                        }
                    }
                }
            } finally {
                if (listJob === coroutineContext.job && epoch == generation) {
                    mutable.update { it.copy(listLoading = false) }
                    // 在途期间又来过刷新请求（列表变化事件）：补刷一次拿到最终状态。
                    if (refreshAgain) {
                        refreshAgain = false
                        refresh()
                    }
                }
            }
        }
    }

    /** 会话列表同步失败后的静默退避重试：代次变化（账号切换 / 页面销毁）即停。 */
    private fun scheduleListRetry(epoch: Int) {
        if (epoch != generation) return
        listRetryJob?.cancel()
        listRetryJob = viewModelScope.launch {
            delay(1_000L shl listRetries.coerceIn(0, 3))
            listRetryJob = null
            listRetries = (listRetries + 1).coerceAtMost(3)
            if (epoch == generation) refresh()
        }
    }

    private fun Throwable.isRetryableListFailure(): Boolean = isConnectionFailure() ||
        this is TerminalAgentException && (code == 408 || code == 429 || code in 500..599)

    fun openSession(session: TerminalAgentSession) {
        if (mutable.value.selected?.terminalId == session.terminalId) return
        pageJob?.cancel(); pageJob = null
        replyJob?.cancel(); replyJob = null
        confirmJob?.cancel(); confirmJob = null
        disconnect()
        attempts = 0
        mutable.update {
            it.copy(
                selected = session, messages = emptyList(), revision = 0, cursor = -1, total = 0,
                loadingMessages = true, messagesError = null, closed = false, closedReason = null,
                draft = "", pendingReply = null, sendError = null, sending = false,
                connected = false, reconnecting = false,
            )
        }
        if (visible) connect()
        loadSnapshot()
    }

    /** 离开会话页：断开镜像、清空选中与消息；列表保留给下一次进入。 */
    fun leaveSession() {
        pageJob?.cancel(); pageJob = null
        replyJob?.cancel(); replyJob = null
        confirmJob?.cancel(); confirmJob = null
        disconnect()
        mutable.update {
            it.copy(
                selected = null, messages = emptyList(), revision = 0, cursor = -1, total = 0,
                loadingMessages = false, messagesError = null, closed = false, closedReason = null,
                draft = "", pendingReply = null, sendError = null, sending = false,
                connected = false, reconnecting = false,
            )
        }
    }

    /** 手动刷新：重置终态后重拉快照并重建连接。 */
    fun refreshSession() {
        if (mutable.value.selected == null) return
        attempts = 0
        mutable.update { it.copy(closed = false, closedReason = null, messagesError = null) }
        loadSnapshot()
        if (visible) connect()
    }

    /** 仅在 Agent 宿主 + 对话页签 + Activity START 时保持镜像 WS；其余场合立即断开。 */
    fun setVisible(value: Boolean) {
        visible = value
        if (value) {
            if (socket == null && mutable.value.selected != null && !mutable.value.closed) connect()
        } else {
            disconnect()
            mutable.update { it.copy(connected = false, reconnecting = false) }
        }
    }

    fun draft(text: String) {
        mutable.update { it.copy(draft = text) }
    }

    fun clearSendError() {
        mutable.update { it.copy(sendError = null) }
    }

    fun send() {
        val state = mutable.value
        val session = state.selected ?: return
        if (state.sending || replyJob?.isActive == true || !session.canReply) return
        val text = state.draft.trim()
        if (text.isEmpty()) return
        // 本地预检与服务端文本规则一致（≤2000 个 Unicode 字符、不以 / ! @ # 开头、无控制字符），省一次往返。
        val invalid = when {
            text.codePointCount(0, text.length) > 2000 -> "回复最多 2000 个字符，请精简后再发送"
            text.first() in "/!@#" -> "回复不能以 / ! @ # 开头，斜杠命令请在电脑端执行"
            text.any(Char::isISOControl) -> "回复不能包含控制字符"
            else -> null
        }
        if (invalid != null) {
            mutable.update { it.copy(sendError = invalid) }
            return
        }
        val connection = state.connection ?: return
        // 每次发送都生成新的 requestId（幂等键），失败重试也由用户重新发起。
        val requestId = java.util.UUID.randomUUID().toString().replace("-", "")
        val epoch = generation
        // 匹配锚点必须在发起请求前采样：REST 往返期间 append 帧可能先到（移动网络下
        // 常见），届时 revision/cursor 已推进到包含本条消息；用响应后的值会把刚发出的
        // 消息排除在「seq > sentAfterSeq」匹配窗口外，导致本地气泡永远无法确认，
        // 表现为同一句话显示两条且误报「可能未生效」。
        val anchorSessionId = session.sessionId
        val anchorRevision = state.revision
        val anchorSeq = state.cursor
        mutable.update { it.copy(draft = "", sending = true, sendError = null) }
        replyJob = viewModelScope.launch {
            try {
                repository.reply(connection, session.terminalId, text, requestId)
                if (epoch != generation || mutable.value.selected?.terminalId != session.terminalId) return@launch
                mutable.update {
                    it.copy(
                        sending = false,
                        pendingReply = PendingTerminalReply(
                            text = text, requestId = requestId,
                            sentAt = System.currentTimeMillis(),
                            sessionId = anchorSessionId,
                            revision = anchorRevision,
                            sentAfterSeq = anchorSeq,
                        ),
                    )
                }
                // append 帧可能已先于响应到达（消息已在镜像里）：立即尝试确认一次。
                matchPendingReply()
                scheduleConfirmTimeout()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation && mutable.value.selected?.terminalId == session.terminalId) {
                    mutable.update { it.copy(sending = false, draft = text, sendError = replyErrorText(e)) }
                }
            }
        }
    }

    private fun replyErrorText(error: Throwable): String = when (error) {
        is TerminalAgentException -> buildString {
            append(error.message)
            error.retryAfterSecs?.let { append("，约 $it 秒后可再次发送") }
            if (error.decisionId != null) append("。请先处理当前待决策")
        }
        else -> error.userMessage()
    }

    /** 10 秒内镜像未出现匹配的 user 消息：只提示可能未生效，不自动重发。 */
    private fun scheduleConfirmTimeout() {
        confirmJob?.cancel()
        val epoch = generation
        confirmJob = viewModelScope.launch {
            delay(10_000)
            if (epoch != generation) return@launch
            val pending = mutable.value.pendingReply ?: return@launch
            if (pending.status == TerminalReplyStatus.Typed) {
                mutable.update { it.copy(pendingReply = pending.copy(status = TerminalReplyStatus.Unconfirmed)) }
            }
        }
    }

    private fun loadSnapshot() {
        val connection = mutable.value.connection ?: return
        val target = mutable.value.selected ?: return
        val epoch = generation
        pageJob = viewModelScope.launch {
            mutable.update { it.copy(loadingMessages = true, messagesError = null) }
            try {
                // 不带 afterSeq：首屏尾页快照，清空本地后整体采用。
                val page = repository.messages(connection, target.terminalId)
                if (epoch != generation || mutable.value.selected?.terminalId != target.terminalId) return@launch
                applySnapshot(page.session, page.messages, page.cursor, page.total)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation && mutable.value.selected?.terminalId == target.terminalId) {
                    mutable.update { it.copy(messagesError = e.userMessage()) }
                }
            } finally {
                if (pageJob === coroutineContext.job && epoch == generation) {
                    mutable.update { it.copy(loadingMessages = false) }
                }
            }
        }
    }

    // ─────────────── 镜像 WS ───────────────

    private fun disconnect() {
        streamGeneration++
        retryJob?.cancel()
        retryJob = null
        socket?.cancel()
        socket = null
    }

    private fun connect() {
        val connection = mutable.value.connection ?: return
        val session = mutable.value.selected ?: return
        if (!visible || mutable.value.closed) return
        disconnect()
        val epoch = streamGeneration
        mutable.update { it.copy(connected = false, reconnecting = true) }
        socket = repository.connect(connection, session.terminalId, object : WebSocketListener() {
            private fun dispatch(action: () -> Unit) {
                viewModelScope.launch {
                    if (epoch == streamGeneration && mutable.value.selected?.terminalId == session.terminalId) action()
                }
            }
            override fun onOpen(webSocket: WebSocket, response: Response) = dispatch {
                attempts = 0
                mutable.update { it.copy(connected = true, reconnecting = false) }
            }
            override fun onMessage(webSocket: WebSocket, text: String) = dispatch {
                val frame = runCatching {
                    TerminalAgentFrame.parse(ApiJson.parseToJsonElement(text).asObject())
                }.getOrNull()
                if (frame == null) {
                    mutable.update { it.copy(messagesError = "镜像消息格式不正确，请更新服务端") }
                } else receive(frame)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                response?.close()
                dispatch { connectionLost(response?.code) }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dispatch { connectionLost(null) }
        })
    }

    /** 断线处理：401/403/404 与 error 帧同样是终态；其余按 1s/2s/5s/10s 退避重连。 */
    private fun connectionLost(code: Int?) {
        disconnect()
        val terminal = when (code) {
            401 -> "登录已过期，请返回账号页面重新登录"
            403 -> "没有查看此终端的权限"
            404 -> "该终端已关闭或不存在"
            else -> null
        }
        if (terminal != null) {
            mutable.update { it.copy(closed = true, closedReason = terminal, connected = false, reconnecting = false) }
            return
        }
        mutable.update { it.copy(connected = false, reconnecting = visible) }
        if (!visible) return
        val delayMillis = when (attempts) { 0 -> 1_000L; 1 -> 2_000L; 2 -> 5_000L; else -> 10_000L }
        attempts = (attempts + 1).coerceAtMost(3)
        retryJob = viewModelScope.launch {
            delay(delayMillis)
            retryJob = null
            connect()
        }
    }

    private fun receive(frame: TerminalAgentFrame) {
        when (frame) {
            is TerminalAgentFrame.Mirror ->
                applySnapshot(frame.session, frame.messages, frame.cursor, frame.total)
            is TerminalAgentFrame.Rotated ->
                applySnapshot(frame.session, frame.messages, frame.cursor, frame.total)
            is TerminalAgentFrame.Append -> {
                // append 仅同 revision 有效；不同 revision 一律等待 mirror 原子重建。
                if (frame.revision != mutable.value.revision) return
                val known = mutable.value.messages.mapTo(mutableSetOf()) { it.seq }
                val appended = frame.messages.filter { it.seq !in known }
                mutable.update {
                    it.copy(
                        messages = it.messages + appended,
                        cursor = maxOf(it.cursor, frame.cursor),
                        total = frame.total,
                    )
                }
                matchPendingReply()
            }
            is TerminalAgentFrame.Status ->
                mutable.update { it.copy(selected = frame.session) }
            is TerminalAgentFrame.Unavailable ->
                // 降级：清空旧气泡，只保留元数据与原因。
                mutable.update {
                    it.copy(selected = frame.session, messages = emptyList(), cursor = -1, total = 0)
                }
            is TerminalAgentFrame.Error -> {
                disconnect()
                mutable.update {
                    it.copy(closed = true, closedReason = frame.message, connected = false, reconnecting = false)
                }
            }
        }
    }

    /** 快照整体替换：revision 只比较相等，不跨进程比大小。 */
    private fun applySnapshot(
        session: TerminalAgentSession, messages: List<AiHistoryMessage>, cursor: Long, total: Long,
    ) {
        mutable.update {
            it.copy(
                selected = session, messages = messages,
                revision = session.revision, cursor = cursor, total = total,
                messagesError = null,
            )
        }
        matchPendingReply()
    }

    /** 仅在同一会话内判定送达：换代（sessionId 变化）后旧消息不作依据；同会话内 revision 只许前进 ——
     *  REST 往返期间镜像可能 rotated（revision + 1），严格相等会让本地气泡永远无法确认，
     *  与镜像里的同一条 user 消息重复显示。历史中已有的同文旧消息（seq 不大于发送时游标）也不算，
     *  文本按 trim 后全文相等比较。确认送达即移除本地气泡 —— replay 里已有这条消息，保留会重复显示。 */
    private fun matchPendingReply() {
        val pending = mutable.value.pendingReply ?: return
        if (pending.status == TerminalReplyStatus.Delivered) return
        val session = mutable.value.selected ?: return
        if (session.sessionId != pending.sessionId || session.revision < pending.revision) return
        val needle = pending.text.trim()
        if (needle.isEmpty()) return
        val delivered = mutable.value.messages.any { message ->
            message.seq > pending.sentAfterSeq && message.role == "user" && message.text.trim() == needle
        }
        if (delivered) {
            confirmJob?.cancel(); confirmJob = null
            mutable.update { it.copy(pendingReply = null) }
        }
    }

    override fun onCleared() {
        listJob?.cancel(); listRetryJob?.cancel(); pageJob?.cancel(); replyJob?.cancel(); confirmJob?.cancel()
        closeJob?.cancel(); notifyJob?.cancel()
        disconnect()
    }

    // ─────────────── 列表长按：关闭服务端 Agent ───────────────

    fun clearCloseError() {
        mutable.update { it.copy(closeError = null) }
    }

    /**
     * 关闭承载该会话的服务端终端（Agent 进程随之结束）。
     * 404 视为已关闭；关闭的是当前打开的会话时先退出该会话页，再刷新列表。
     */
    fun closeSession(session: TerminalAgentSession) {
        val connection = mutable.value.connection ?: return
        if (closeJob?.isActive == true) return
        val epoch = generation
        mutable.update { it.copy(closingTerminalId = session.terminalId, closeError = null) }
        closeJob = viewModelScope.launch {
            try {
                try {
                    repository.closeTerminal(connection, session.terminalId)
                } catch (e: TerminalAgentException) {
                    if (e.code != 404) throw e
                }
                if (epoch != generation) return@launch
                if (mutable.value.selected?.terminalId == session.terminalId) leaveSession()
                mutable.update { state ->
                    state.copy(
                        sessions = state.sessions.filterNot { it.terminalId == session.terminalId },
                        closingTerminalId = null,
                    )
                }
                refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    mutable.update { it.copy(closingTerminalId = null, closeError = e.userMessage()) }
                }
            }
        }
    }
}
