package com.terminalbuddy.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.terminalbuddy.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.ArrayDeque

/** 普通终端的连接与导航独立于 AI 会话；账号切换会使旧请求、回调和查看连接失效。 */
internal data class ServerTerminalUiState(
    val connection: AiConnection? = null,
    val dialogOpen: Boolean = false, val loading: Boolean = false, val loaded: Boolean = false,
    val projects: List<AiProject> = emptyList(), val profiles: List<ServerProfile> = emptyList(),
    val terminals: List<ServerTerminal> = emptyList(), val error: String? = null,
    val launchingId: String? = null, val selected: ServerTerminal? = null,
    val connected: Boolean = false, val status: String = "等待连接",
    val terminalError: String? = null, val ended: Boolean = false, val closing: Boolean = false,
)

internal class ServerTerminalViewModel(application: Application) : AndroidViewModel(application) {
    private val store = (application as TerminalBuddyApplication).aiRepository.store
    private val repository = ServerTerminalRepository()
    private val mutable = MutableStateFlow(ServerTerminalUiState())
    val state = mutable.asStateFlow()
    private var generation = 0
    private var streamGeneration = 0
    private var refreshJob: Job? = null
    private var actionJob: Job? = null
    private var retryJob: Job? = null
    private var socket: WebSocket? = null
    private var visible = false
    private var attempts = 0
    private var cols = 80
    private var rows = 24
    private var outputCols = 80
    private var outputRows = 24
    private val frames = ArrayDeque<ServerTerminalFrame>()
    private var bufferedCharacters = 0
    private var renderer: ((JsonObject) -> Unit)? = null

    fun isCurrentAccount(): Boolean = store.loggedIn && mutable.value.connection ==
        AiConnection(store.server, store.username, store.token)

    fun bindAccount() {
        val connection = if (store.loggedIn) AiConnection(store.server, store.username, store.token) else null
        if (mutable.value.connection == connection) return
        generation++
        refreshJob?.cancel()
        actionJob?.cancel()
        disconnect()
        visible = false
        renderer = null
        clearFrames()
        mutable.value = ServerTerminalUiState(connection = connection)
    }

    fun showConfigurations() {
        bindAccount()
        if (mutable.value.connection == null) return
        mutable.update { it.copy(dialogOpen = true, error = null) }
        refresh()
    }

    fun dismissConfigurations() {
        mutable.update { it.copy(dialogOpen = false) }
    }

    fun refresh() { refreshCatalog(clearError = true) }

    private fun refreshCatalog(clearError: Boolean) {
        val connection = mutable.value.connection ?: return
        if (refreshJob?.isActive == true) return
        val epoch = generation
        refreshJob = viewModelScope.launch {
            mutable.update { it.copy(loading = true, error = if (clearError) null else it.error) }
            try {
                val catalog = repository.catalog(connection)
                if (epoch != generation) return@launch
                val projects = catalog.projects.toMutableList()
                catalog.profiles.forEach { profile ->
                    if (projects.none { it.name == profile.projectName }) projects.add(AiProject(profile.projectName, ""))
                }
                mutable.update { it.copy(
                    projects = projects.sortedBy { project -> project.name.lowercase() },
                    profiles = catalog.profiles, terminals = catalog.terminals, loaded = true,
                ) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (epoch == generation) mutable.update { it.copy(error = e.userMessage()) }
            } finally {
                if (epoch == generation) mutable.update { it.copy(loading = false) }
            }
        }
    }

    fun launch(profile: ServerProfile) {
        if (!profile.canLaunch || actionJob?.isActive == true) return
        val connection = mutable.value.connection ?: return
        val epoch = generation
        mutable.update { it.copy(launchingId = profile.id, error = null) }
        actionJob = viewModelScope.launch {
            try {
                val terminal = repository.start(connection, profile.id)
                if (epoch != generation) return@launch
                mutable.update { it.copy(terminals = it.terminals.filterNot { item -> item.id == terminal.id } + terminal) }
                open(terminal)
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (epoch == generation) {
                    val message = if (e.isConnectionFailure())
                        "未收到启动结果，命令可能已经执行。请刷新列表，查看已打开的终端后再决定是否重新执行。"
                    else e.userMessage()
                    mutable.update { it.copy(error = message) }
                    refreshCatalog(clearError = false)
                }
            } finally {
                if (epoch == generation) mutable.update { it.copy(launchingId = null) }
            }
        }
    }

    fun open(terminal: ServerTerminal) {
        if (terminal.owner != "web") return
        disconnect()
        clearFrames()
        renderer = null
        visible = false
        attempts = 0
        mutable.update { it.copy(
            selected = terminal, dialogOpen = false, connected = false, status = "等待连接",
            terminalError = null, ended = false, closing = false,
        ) }
    }

    /** 页面返回只取消查看连接；PTY 与命令继续留在服务端。 */
    fun leaveTerminal() {
        visible = false
        disconnect()
        renderer = null
        mutable.update { it.copy(selected = null, connected = false) }
    }

    fun setVisible(value: Boolean) {
        visible = value
        if (value) {
            if (renderer != null && socket == null && !mutable.value.ended) connect()
        } else {
            disconnect()
            mutable.update { it.copy(connected = false, status = if (it.ended) it.status else "已暂停查看") }
        }
    }

    fun attachRenderer(render: (JsonObject) -> Unit) {
        renderer = render
        render(replayMessage())
        if (visible && socket == null && !mutable.value.ended) connect()
    }

    fun detachRenderer() { renderer = null }

    fun renderingFailed() {
        mutable.update { it.copy(terminalError = "终端画面渲染失败，请返回后重新打开终端") }
    }

    fun resize(newCols: Int, newRows: Int) {
        cols = newCols.coerceIn(1, 500)
        rows = newRows.coerceIn(1, 500)
        socket?.send(jsonBody { put("type", "resize"); put("cols", cols); put("rows", rows) }.toString())
    }

    fun input(text: String) {
        if (text.isEmpty() || !mutable.value.connected || mutable.value.ended) return
        val sent = socket?.send(jsonBody { put("type", "input"); put("data", text) }.toString()) == true
        if (!sent) mutable.update { it.copy(terminalError = "输入未发送，终端连接已断开，请重新连接后再操作") }
    }

    fun reconnect() {
        if (mutable.value.ended) return
        attempts = 0
        connect()
    }

    /** 服务恢复后只查找原终端，不创建新终端，不重发启动命令。 */
    fun refreshService() {
        val connection = mutable.value.connection ?: return
        val selected = mutable.value.selected ?: return
        if (actionJob?.isActive == true) return
        val epoch = generation
        actionJob = viewModelScope.launch {
            try {
                val terminals = repository.terminals(connection)
                if (epoch != generation || mutable.value.selected?.id != selected.id) return@launch
                val exists = terminals.any { it.id == selected.id }
                mutable.update { it.copy(
                    terminals = terminals, ended = !exists,
                    status = if (exists) "等待连接" else "原终端已不存在",
                    terminalError = if (exists) null else "服务已恢复，原终端已结束或因服务重启被移除。升级结果请查看服务或脚本日志。",
                ) }
                if (exists) reconnect()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (epoch == generation) mutable.update { it.copy(terminalError = e.userMessage()) }
            }
        }
    }

    fun closeTerminal() {
        val connection = mutable.value.connection ?: return
        val selected = mutable.value.selected ?: return
        if (actionJob?.isActive == true) return
        val epoch = generation
        mutable.update { it.copy(closing = true) }
        actionJob = viewModelScope.launch {
            try {
                try { repository.close(connection, selected.id) }
                catch (e: ApiException) { if (e.code != 404) throw e }
                if (epoch != generation || mutable.value.selected?.id != selected.id) return@launch
                disconnect()
                mutable.update { it.copy(
                    connected = false, ended = true, status = "终端已关闭", terminalError = null,
                    terminals = it.terminals.filterNot { terminal -> terminal.id == selected.id },
                ) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (epoch == generation) mutable.update { it.copy(terminalError = e.userMessage()) }
            } finally {
                if (epoch == generation) mutable.update { it.copy(closing = false) }
            }
        }
    }

    private fun disconnect() {
        streamGeneration++
        retryJob?.cancel()
        retryJob = null
        socket?.cancel()
        socket = null
    }

    private fun connect() {
        val connection = mutable.value.connection ?: return
        val terminal = mutable.value.selected ?: return
        if (!visible || renderer == null || mutable.value.ended) return
        disconnect()
        val epoch = streamGeneration
        mutable.update { it.copy(connected = false, status = "正在连接", terminalError = null) }
        socket = repository.connect(connection, terminal.id, object : WebSocketListener() {
            private fun dispatch(action: () -> Unit) {
                viewModelScope.launch {
                    if (epoch == streamGeneration && mutable.value.selected?.id == terminal.id) action()
                }
            }
            override fun onOpen(webSocket: WebSocket, response: Response) = dispatch {
                mutable.update { it.copy(connected = true, status = "终端已连接", terminalError = null) }
                webSocket.send(jsonBody { put("type", "resize"); put("cols", cols); put("rows", rows) }.toString())
            }
            override fun onMessage(webSocket: WebSocket, text: String) = dispatch {
                try {
                    receive(ApiJson.parseToJsonElement(text).asObject())
                } catch (_: Exception) {
                    mutable.update { it.copy(terminalError = "终端消息格式不正确，请更新服务端") }
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                response?.close()
                dispatch { connectionLost(code) }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dispatch { connectionLost(null) }
        })
    }

    private fun connectionLost(code: Int?) {
        // 使该连接随后到达的 onClosed 等回调失效，避免同时排入多个重连任务。
        disconnect()
        if (mutable.value.ended) return
        val terminalMissing = code == 404
        val forbidden = code == 401 || code == 403
        val message = when (code) {
            401 -> "登录已过期，请返回账号页面重新登录"
            403 -> "没有查看此终端的权限"
            404 -> "原终端已结束或因服务重启被移除。可刷新服务状态，查看更新后的服务。"
            else -> "连接已中断。自升级或服务重启可能导致终端断开，已收到的输出保留；启动命令不会自动重跑。"
        }
        mutable.update { it.copy(
            connected = false, ended = terminalMissing, status = if (terminalMissing) "原终端已不存在" else "连接已中断",
            terminalError = message,
        ) }
        if (forbidden || terminalMissing || !visible || attempts >= 5) return
        val delayMillis = (1000L shl attempts).coerceAtMost(16000L)
        attempts++
        retryJob = viewModelScope.launch {
            delay(delayMillis)
            retryJob = null
            connect()
        }
    }

    private fun receive(message: JsonObject) {
        when (message.text("type")) {
            "viewport" -> {
                outputCols = message.number("cols")?.toInt()?.coerceIn(1, 500) ?: cols
                outputRows = message.number("rows")?.toInt()?.coerceIn(1, 500) ?: rows
                renderer?.invoke(message)
            }
            "replay" -> {
                attempts = 0
                val replay = ApiJson.decodeFromJsonElement<List<ServerTerminalFrame>>(message["frames"] ?: JsonArray(emptyList()))
                clearFrames()
                replay.forEach(::appendFrame)
                renderer?.invoke(replayMessage())
            }
            "output" -> {
                attempts = 0
                val data = message.text("data")
                appendFrame(ServerTerminalFrame(data, outputCols, outputRows))
                renderer?.invoke(message)
            }
            "error" -> mutable.update { it.copy(terminalError = message.text("message", fallback = "终端操作失败")) }
            "exited" -> {
                disconnect()
                mutable.update { it.copy(connected = false, ended = true, status = "终端已结束") }
            }
        }
    }

    private fun clearFrames() { frames.clear(); bufferedCharacters = 0 }
    private fun appendFrame(frame: ServerTerminalFrame) {
        if (frame.data.isEmpty()) return
        val bounded = frame.copy(data = frame.data.takeLast(MAX_BUFFER_CHARACTERS))
        frames.addLast(bounded)
        bufferedCharacters += bounded.data.length
        while (frames.size > 1000 || bufferedCharacters > MAX_BUFFER_CHARACTERS) {
            bufferedCharacters -= frames.removeFirst().data.length
        }
    }
    private fun replayMessage() = jsonBody {
        put("type", "replay")
        put("frames", ApiJson.encodeToJsonElement(frames.toList()))
    }

    override fun onCleared() { disconnect(); renderer = null }
    private companion object { const val MAX_BUFFER_CHARACTERS = 2 * 1024 * 1024 }
}
