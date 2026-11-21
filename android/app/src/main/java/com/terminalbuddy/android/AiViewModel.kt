package com.terminalbuddy.android

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.terminalbuddy.android.data.*
import com.terminalbuddy.android.notifications.AiNotificationTarget
import com.terminalbuddy.android.notifications.ServerNotificationTarget
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID

/** 同名模型保留供应商身份，避免选择模型后切换到另一套启动配置。 */
data class AiLaunchModel(val provider: AiProvider, val model: AiModel) {
    val key get() = "${provider.id.length}:${provider.id}${model.id}"
}

/** 简版历史 Tab 的条目：历史记录来自哪个助手，与快速开始当前选中的助手无关。 */
data class AiHistoryEntry(val agent: String, val session: AiHistorySession)

/**
 * AI 页面状态。登录、项目 / Agent / 模型选择和当前会话各自独立，
 * 首页同步不会覆盖正在进行的对话；关闭 App 后重新打开回到选择首页。
 */
data class AiUiState(
    val server: String = "", val username: String = "admin", val authenticated: Boolean = false,
    val authenticating: Boolean = false, val loading: Boolean = false, val loadingSession: Boolean = false,
    val sessions: List<AiSession> = emptyList(), val projects: List<AiProject> = emptyList(),
    /** 本机本次运行打开过的原生会话 id（仅内存，不持久化）；简版「已打开」据此展示手机端打开的会话。 */
    val openedSessionIds: Set<String> = emptySet(),
    /** 首页最近任务独立恢复，避免将两条展示缓存当成完整会话列表。 */
    val recentSessions: List<AiSession> = emptyList(),
    val providers: List<AiProvider> = emptyList(),
    val projectPath: String = "", val providerId: String = "", val modelId: String = "",
    val selected: AiSession? = null, val draft: String = "", val sending: Boolean = false,
    /** 输入框上方待发送的图片：与草稿一起在发送成功后清空。 */
    val attachments: List<AiDraftImage> = emptyList(),
    val connected: Boolean = false, val working: Boolean = false, val error: String? = null,
    val answeringApprovalIds: Set<String> = emptySet(),
    val reconnecting: Boolean = false,
    val deletingAll: Boolean = false,
    val connectionRevision: Long = 0,
    val homeLoaded: Boolean = false,
    val unviewedIds: Set<String> = emptySet(),
    val accounts: List<AiAccount> = emptyList(), val activeAccountId: String? = null,
    /** 当前服务端的备注名；未填写时为空，界面回退显示登录账号。 */
    val serverName: String = "",
    val switchingAccountId: String? = null,
    val notificationLoginAccountId: String? = null,
    /** 简版首页历史 Tab 的查询范围：当前项目汇总全部已启用助手，与快速开始的助手选择无关。 */
    val historySessions: List<AiHistoryEntry> = emptyList(),
    val historyLoading: Boolean = false,
    /** 已查询的助手列表；与当前项目可用的助手一致时列表才算就绪。 */
    val historyAgents: List<String> = emptyList(),
    val historyProjectPath: String = "",
    /** 连续发送方式：false 等当前回合任务完成后排队续发，true 直接交给运行中的 CLI 进程插话。 */
    val sendSteer: Boolean = false,
    val history: AiHistoryState = AiHistoryState(),
    val serverHistory: Map<AiServerHistoryKey, AiServerProjectHistory> = emptyMap(),
) {
    /** 仅首次取数限制操作，后续刷新保留已有内容并保持页面可操作。 */
    val initialLoading get() = loading && !homeLoaded
    /**
     * 「已打开」中的原生会话：电脑端正打开着的（服务端 `desktopOpen` 标记）
     * 与本机本次运行打开过的会话，按最近更新排序。
     */
    val openedSessions get() = (sessions + listOfNotNull(selected))
        .distinctBy { it.id }
        .filter { it.desktopOpen || it.id in openedSessionIds }
        .sortedByDescending { it.updatedAt }
    val launchProject get() = projects.find { it.path == projectPath }
    /**
     * 服务端 catalog 没有某助手供应商时补一个「服务端默认配置」：项目启用了该助手就仍然可选。
     * 兼容两种环境：服务端版本较旧（catalog 不返回 `default:<agent>`），
     * 或服务端尚未给该助手配置任何供应商。创建会话时会省略 providerId，走服务端默认 CLI 配置。
     */
    private val fallbackProviders get() = listOf("claude", "codex")
        .filter { agent -> providers.none { it.agent == agent } }
        .map { agent -> AiProvider("default:$agent", agent, "服务端默认配置",
            models = listOf(AiModel("")), localDefault = true) }
    val allProviders get() = providers + fallbackProviders
    /** 只列出当前项目启用的 Agent 对应供应商。 */
    fun projectProviders(project: AiProject) = allProviders.filter { project.enabledAgents.enabled(it.agent) }
    fun projectModels(project: AiProject, agent: String? = null) = projectProviders(project)
        .filter { agent == null || it.agent == agent }
        .flatMap { provider -> provider.models.map { AiLaunchModel(provider, it) } }
    val availableProviders get() = launchProject?.let(::projectProviders).orEmpty()
    val availableAgents get() = listOf("claude", "codex").filter { agent -> availableProviders.any { it.agent == agent } }
    val launchProvider get() = availableProviders.find { it.id == providerId }
    /** 汇总当前 Agent 的全部模型，启动时仍使用模型所属的供应商。 */
    val availableModels get() = availableProviders.filter { it.agent == launchProvider?.agent }.flatMap { provider ->
        provider.models.map { AiLaunchModel(provider, it) }
    }
    val launchModel get() = launchProvider?.models?.find { it.id == modelId }
    val launchModelKey get() = availableModels.find { it.provider.id == providerId && it.model.id == modelId }?.key.orEmpty()
    /** 二级会话页按会话自身的供应商与模型读取配置。 */
    val selectedModelOption: AiModel?
        get() {
            val session = selected ?: return null
            return allProviders.find { it.agent == session.provider && it.id == session.providerId }
                ?.models?.find { it.id == session.model.orEmpty() }
        }
    val selectedModelLabel get() = selectedModelOption?.title ?: selected?.modelLabel.orEmpty()
    val selectedEffortLabel get() = selectedModelOption?.effortLabel?.takeIf(String::isNotBlank) ?: "跟随服务端"
    val canCreate get() = launchProject != null && launchProvider != null && launchModel != null && !initialLoading && !working && !authenticating
}

class AiViewModel(application: Application) : AndroidViewModel(application) {
    private companion object {
        /** 与服务端保持一致的单条消息图片数量与体积上限。 */
        const val MAX_ATTACHMENTS = 8
        const val MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
        /** 强制结束的请求上限：服务端是毫秒级操作，超时说明连接已失效而不是任务太慢。 */
        const val FORCE_STOP_TIMEOUT_MS = 15_000L
    }
    private val repository = (application as TerminalBuddyApplication).aiRepository
    private val store = repository.store
    private val taskNotifications = (application as TerminalBuddyApplication).taskNotifications
    private val mutable = MutableStateFlow(restoredConnectionState())
    val state = mutable.asStateFlow()

    private var notificationTarget: AiNotificationTarget? = null
    private var notificationSwitchAttempted: String? = null
    /** 服务端任务通知点击后的待处理导航：切换账号成功后再交给 ServerDecisionHost 打开。 */
    private var serverNotificationTarget: ServerNotificationTarget? = null
    private var serverNotificationSwitchAttempted: String? = null
    private val mutableServerNotificationReady = MutableStateFlow<ServerNotificationTarget?>(null)
    /** 账号已就绪、可以打开决策 / 结果对话框的通知请求；消费后清空。 */
    val serverNotificationReady = mutableServerNotificationReady.asStateFlow()
    private var visible = false
    private var generation = 0
    private var authJob: Job? = null
    private var refreshJob: Job? = null
    private var cliHistoryJob: Job? = null
    private val serverHistoryJobs = mutableMapOf<AiServerHistoryKey, Job>()
    private var streamJob: Job? = null
    private var cacheJob: Job? = null
    private var pollingJob: Job? = null
    private var selectJob: Job? = null
    private var sendJob: Job? = null
    private var actionJob: Job? = null
    private var historyJob: Job? = null
    private var historyReplayJob: Job? = null
    /** 尚未落盘的本地新对话；为空表示当前会话已经存在于服务端。 */
    private var pending: AiSession? = null
    /** 最后实际查看到的版本；首页发现新结果时保留这条已读基线。 */
    private var viewedRevisions = mutableMapOf<String, Long>()
    private var viewedBaselineReady = false
    private val drafts = mutableMapOf<String, String>()
    /** 会话 ID → 待发送文本 + requestId；结果未知时重试复用同一个 requestId。 */
    private val requests = mutableMapOf<String, Pair<String, String>>()
    /** 斜杠命令清单的兜底缓存：会话尚未启动 CLI 时借用同一 Agent 上一次的清单。 */
    private var slashFallback: Pair<String, AiSlashCatalog?>? = null
    private data class OutgoingMessage(
        val sessionId: String, val message: AiMessage, val draft: String, val queued: Boolean,
        /** 发送失败/取消时放回输入框上方的图片。 */
        val attachments: List<AiDraftImage> = emptyList(),
    ) {
        val requestId get() = message.id.removePrefix("local-")
        fun display(session: AiSession): AiSession = if (queued) {
            session.copy(pendingInputs = session.pendingInputs + AiPendingInput(message.text, message.id, message.images))
        } else session.copy(messages = session.messages + message)
    }
    /** 未确认消息按发送时的任务状态展示在队列或正文，实时快照不会覆盖占位。 */
    private var outgoing: OutgoingMessage? = null

    private val connectivity = requireNotNull(application.getSystemService(ConnectivityManager::class.java))
    private var defaultNetwork = connectivity.activeNetwork
    private var defaultNetworkValidated = connectivity.getNetworkCapabilities(defaultNetwork)
        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    private var receivedNetworkCapabilities = false
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            val validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val recovered = network != defaultNetwork ||
                (receivedNetworkCapabilities && validated && !defaultNetworkValidated)
            receivedNetworkCapabilities = true
            defaultNetwork = network
            defaultNetworkValidated = validated
            // 局域网服务不要求互联网验证通过，默认网络切换后就立即尝试。
            if (recovered) reconnectNow()
        }

        override fun onLost(network: Network) {
            if (network != defaultNetwork) return
            defaultNetwork = null
            defaultNetworkValidated = false
            if (!visible || !store.loggedIn || mutable.value.authenticating) return
            cancelConnectionJobs()
            mutable.update { it.copy(reconnecting = true, error = null) }
        }
    }
    private val networkCallbackRegistered = runCatching {
        // 与页面状态统一在主线程处理，避免网络切换和选择会话并发更新。
        connectivity.registerDefaultNetworkCallback(networkCallback, Handler(Looper.getMainLooper()))
    }.isSuccess

    init {
        viewModelScope.launch {
            state.map { Triple(it.authenticating, it.working, it.activeAccountId) }.distinctUntilChanged().collect {
                resumeNotificationNavigation()
                resumeServerNotificationNavigation()
            }
        }
    }

    fun openNotification(target: AiNotificationTarget) {
        notificationTarget = target
        notificationSwitchAttempted = null
        resumeNotificationNavigation()
    }

    /** 点击服务端任务通知：先把当前账号切到通知所属服务端，再打开对应对话框。 */
    fun openServerNotification(target: ServerNotificationTarget) {
        serverNotificationTarget = target
        serverNotificationSwitchAttempted = null
        resumeServerNotificationNavigation()
    }

    /** ServerDecisionHost 已消费打开请求（或已过期），清空待处理通知。 */
    fun consumeServerNotification() {
        mutableServerNotificationReady.value = null
    }

    /**
     * 服务端通知导航：账号可用时切换过去，未登录时引导重新登录；
     * 切换完成由 state 变化再次触发，成功后把目标交给界面打开对话框。
     */
    private fun resumeServerNotificationNavigation() {
        val target = serverNotificationTarget ?: return
        val accountId = target.accountId
        if (accountId == null) {
            serverNotificationTarget = null
            mutableServerNotificationReady.value = target
            return
        }
        val ui = mutable.value
        if (ui.authenticating || ui.working) return
        val account = repository.accounts.accounts.find { it.id == accountId }
        when {
            account == null -> {
                serverNotificationTarget = null
                mutable.update { it.copy(error = "该通知所属账号已移除，请重新添加账号") }
            }
            !account.loggedIn -> {
                if (ui.selected != null) closeSession()
                serverNotificationTarget = null
                mutable.update {
                    it.copy(notificationLoginAccountId = accountId, error = "请重新登录该通知所属账号后继续")
                }
            }
            repository.accounts.activeId == accountId -> {
                serverNotificationTarget = null
                mutableServerNotificationReady.value = target
            }
            serverNotificationSwitchAttempted != accountId -> {
                serverNotificationSwitchAttempted = accountId
                switchAccount(accountId)
            }
            // 已尝试切换但仍未激活（切换失败）：不保留陈旧通知，错误由切换流程提示。
            else -> serverNotificationTarget = null
        }
    }

    /** 通知导航等待已有操作完成，并在需要时恢复原账号；不会使用当前账号请求别人的任务。 */
    private fun resumeNotificationNavigation() {
        val target = notificationTarget ?: return
        val ui = mutable.value
        if (ui.authenticating || ui.working) return
        val account = repository.accounts.accounts.find { it.id == target.accountId }
        if (account == null) {
            notificationTarget = null
            mutable.update { it.copy(error = "该任务所属账号已移除，请重新添加账号") }
        } else if (!account.loggedIn) {
            if (ui.selected != null) closeSession()
            mutable.update { it.copy(notificationLoginAccountId = account.id, error = "请重新登录该任务所属账号后继续") }
        } else if (repository.accounts.activeId == account.id) {
            notificationTarget = null
            open(target.sessionId)
            if (!mutable.value.homeLoaded) refresh()
        } else if (notificationSwitchAttempted != account.id) {
            notificationSwitchAttempted = account.id
            switchAccount(account.id)
        }
    }

    private fun cancelConnectionJobs() {
        cancelHistoryJobs()
        stopRealtime()
        refreshJob?.cancel(); refreshJob = null
        selectJob?.cancel(); selectJob = null
        mutable.update { it.copy(loading = false, loadingSession = false) }
    }

    private fun cancelHistoryJobs() {
        cliHistoryJob?.cancel(); cliHistoryJob = null
        historyJob?.cancel(); historyJob = null
        historyReplayJob?.cancel(); historyReplayJob = null
        serverHistoryJobs.values.toList().forEach { it.cancel() }
        serverHistoryJobs.clear()
        mutable.update { state -> state.copy(
            historyLoading = false,
            historyAgents = emptyList(), historyProjectPath = "", historySessions = emptyList(),
            history = state.history.copy(loading = false, loadingReplay = false),
            serverHistory = state.serverHistory.mapValues { (_, history) -> history.copy(loading = false) },
        ) }
    }

    /** 网络恢复后取消旧连接和退避等待，立即建立实时连接并补拉完整会话。 */
    private fun reconnectNow() {
        if (!visible || !store.loggedIn || mutable.value.authenticating) return
        cancelConnectionJobs()
        mutable.update { it.copy(reconnecting = true, error = null) }
        if (mutable.value.selected == null) {
            if (mutable.value.deletingAll) startHomePolling() else refresh()
        } else if (pending == null) startRealtime(refreshImmediately = true)
        if (mutable.value.history.selected != null && mutable.value.history.replay == null) loadCodexReplay()
        if (mutable.value.history.expanded && !mutable.value.history.loaded) loadCodexHistory()
        reloadExpandedServerHistory()
    }

    override fun onCleared() {
        if (networkCallbackRegistered) runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        super.onCleared()
    }

    /** 页面实时流只在前台维持，后台任务监听由独立前台服务负责。 */
    fun setVisible(active: Boolean) {
        if (visible == active) return
        visible = active
        if (active && mutable.value.authenticated && !store.loggedIn) {
            resetConnection()
            mutable.value = connectionState().copy(error = "AI 服务登录已过期，请重新登录")
        }
        if (active && store.loggedIn && !mutable.value.authenticating) {
            if (mutable.value.selected == null) refresh()
            else if (pending == null) startRealtime(refreshImmediately = true)
            val history = mutable.value.history
            if (history.selected != null && history.replay == null && history.replayError == null) loadCodexReplay()
            if (history.expanded && !history.loaded && history.error == null) loadCodexHistory()
            reloadExpandedServerHistory()
        } else {
            cancelHistoryJobs()
            stopRealtime()
            refreshJob?.cancel(); refreshJob = null
            mutable.update { it.copy(loading = false) }
        }
    }

    fun login(server: String, username: String, password: String, name: String = "") = authenticate {
        require(username.isNotBlank()) { "请输入 AI 服务账号" }
        require(password.isNotEmpty()) { "请输入 AI 服务密码" }
        repository.login(server, username.trim(), password, name.trim())
    }

    fun switchAccount(id: String) {
        if (id == repository.accounts.activeId) return
        authenticate(id) { repository.savedConnection(id) }
    }

    private fun authenticate(accountId: String? = null, connect: suspend () -> AiConnection) {
        if (authJob?.isActive == true || mutable.value.working) return
        authJob = viewModelScope.launch {
            mutable.update { it.copy(authenticating = true, switchingAccountId = accountId, error = null) }
            // 验证目标账号期间暂停原账号同步，避免旧连接的 401 中断新登录。
            cancelConnectionJobs()
            try {
                val connection = withContext(Dispatchers.IO) { connect() }
                // 激活与旧请求取消在同一个主线程片段完成，旧响应不能写入新账号状态。
                repository.activate(connection)
                taskNotifications.syncAccounts()
                resetConnection()
                mutable.value = connectionState()
                refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (accountId != null && e is ApiException && e.code == 401) repository.accounts.invalidate(accountId)
                mutable.update {
                    it.copy(authenticating = false, switchingAccountId = null, accounts = repository.accounts.accounts,
                        error = if (accountId != null && e is ApiException && e.code == 401) "该账号登录已过期，请重新登录" else e.userMessage())
                }
                resumeConnection()
            }
        }
    }

    fun cancelAuthentication() {
        val inProgress = mutable.value.authenticating
        authJob?.cancel(); authJob = null
        mutable.update { it.copy(authenticating = false, switchingAccountId = null, error = null) }
        if (inProgress) resumeConnection()
    }

    private fun resumeConnection() {
        if (!visible || !store.loggedIn || mutable.value.authenticating) return
        if (mutable.value.selected == null) {
            if (mutable.value.homeLoaded) startHomePolling() else refresh()
        } else if (pending == null) startRealtime(refreshImmediately = true)
    }

    /** 清空当前连接的内存状态和在途任务，各账号的磁盘数据仍按身份隔离。 */
    private fun resetConnection() {
        generation++
        cancelHistoryJobs()
        stopRealtime(); refreshJob?.cancel(); refreshJob = null; selectJob?.cancel(); cancelSend(); actionJob?.cancel()
        repository.sessionCache.invalidate()
        drafts.clear(); requests.clear(); pending = null
        viewedRevisions.clear(); viewedBaselineReady = false
    }

    private fun connectionState() = restoredConnectionState(mutable.value.connectionRevision + 1)

    /** 首帧就使用当前账号的完整配置；有缓存时后台同步不会禁用控件或切换成占位内容。 */
    private fun restoredConnectionState(revision: Long = 0): AiUiState {
        val cached = repository.cachedQuickStart()
        val recent = repository.cachedRecentSessions()
        val viewed = repository.viewedRevisions()
        val unviewed = if (viewed == null) emptySet() else recent.filter { session ->
            session.status !in listOf("running", "background", "stopping") && session.revision > (viewed[session.id] ?: 1L)
        }.mapTo(mutableSetOf()) { it.id }
        val accounts = repository.accounts
        return AiUiState(
            store.server, store.username, store.loggedIn,
            loading = store.loggedIn,
            recentSessions = recent, unviewedIds = unviewed,
            projects = cached?.projects.orEmpty(),
            providers = cached?.providers.orEmpty(),
            projectPath = repository.selectedProject,
            providerId = repository.selectedProvider,
            modelId = repository.selectedModel,
            homeLoaded = cached != null,
            accounts = accounts.accounts, activeAccountId = accounts.activeId,
            serverName = accounts.accounts.find { it.id == accounts.activeId }?.name.orEmpty(),
            // 手机端打开记录只活在本进程内：切换账号/重连接时清空，避免沿用上一个账号的会话。
            openedSessionIds = emptySet(),
            connectionRevision = revision,
            sendSteer = repository.sendSteer,
        )
    }

    fun logout() {
        authJob?.cancel(); authJob = null
        repository.logout()
        taskNotifications.syncAccounts()
        resetConnection()
        mutable.value = connectionState()
    }

    fun removeAccount(id: String) {
        if (mutable.value.authenticating) return
        try {
            val current = repository.accounts.activeId == id
            repository.removeAccount(id)
            taskNotifications.removeAccount(id)
            taskNotifications.syncAccounts()
            if (current) {
                resetConnection()
                mutable.value = connectionState()
            } else mutable.update { it.copy(accounts = repository.accounts.accounts, error = null) }
        } catch (e: Throwable) {
            mutable.update { it.copy(error = e.userMessage()) }
        }
    }

    /** 修改已保存服务端的备注名；改的是当前账号时同步刷新当前服务名称。 */
    fun renameAccount(id: String, name: String) {
        if (mutable.value.authenticating) return
        try {
            repository.renameAccount(id, name)
            val accounts = repository.accounts
            mutable.update {
                it.copy(
                    accounts = accounts.accounts, error = null,
                    serverName = if (it.activeAccountId == id)
                        accounts.accounts.find { account -> account.id == id }?.name.orEmpty() else it.serverName,
                )
            }
        } catch (e: Throwable) {
            mutable.update { it.copy(error = e.userMessage()) }
        }
    }

    private fun failure(error: Throwable) {
        if (error is ApiException && error.code == 401) {
            logout()
            mutable.update { it.copy(error = "AI 服务登录已过期，请重新登录") }
        } else if (error.isConnectionFailure()) {
            // 网络抖动只更新悬浮连接状态，不再插入错误条挤动页面。
            mutable.update { it.copy(reconnecting = true, error = null) }
            if (visible && store.loggedIn) {
                if (mutable.value.selected == null) refresh()
                else if (pending == null) startRealtime()
            }
        } else mutable.update { it.copy(reconnecting = false, error = error.userMessage()) }
    }

    fun clearError() {
        mutable.update { it.copy(error = null) }
    }

    /** 首页连接失败时持续退避重试，已有内容和有效选择保持可用。 */
    fun refresh() {
        if (!store.loggedIn || mutable.value.authenticating || refreshJob?.isActive == true || mutable.value.deletingAll) return
        val epoch = generation
        refreshJob = viewModelScope.launch {
            mutable.update { it.copy(loading = true) }
            var retries = 0
            try {
                while (isActive && epoch == generation) {
                    try {
                        val (sessions, projects, catalog) = coroutineScope {
                            val sessions = async { repository.sessions() }
                            val projects = async { repository.projects() }
                            val catalog = async { repository.catalog() }
                            Triple(sessions.await(), projects.await(), catalog.await())
                        }
                        if (epoch != generation) return@launch
                        val unviewed = recordSessions(sessions)
                        // 服务端列表刷新后清理已不存在的本机打开记录，避免内存无限增长。
                        val aliveOpened = mutable.value.openedSessionIds.intersect(sessions.mapTo(mutableSetOf()) { it.id })
                        mutable.update {
                            reconcile(
                                it.copy(
                                    sessions = sessions, projects = projects, providers = catalog.providers,
                                    loading = false, homeLoaded = true, reconnecting = false, error = null,
                                    unviewedIds = unviewed, openedSessionIds = aliveOpened,
                                )
                            )
                        }
                        updateRecentSessions(sessions)
                        saveSelection()
                        startHomePolling()
                        return@launch
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        if (epoch != generation) return@launch
                        failure(e)
                        if (!e.isConnectionFailure() || !visible || !store.loggedIn) return@launch
                        delay(reconnectDelay(retries))
                        retries = (retries + 1).coerceAtMost(4)
                    }
                }
            } finally {
                // 取消旧请求时，不能清除后续刷新任务的进度。
                if (refreshJob === coroutineContext.job) {
                    mutable.update { it.copy(loading = false) }
                }
            }
        }
    }

    /** 首页静默同步摘要标题与运行状态；进入对话或退到后台时由 stopRealtime 停止。 */
    private fun startHomePolling() {
        if (!visible || !store.loggedIn || mutable.value.authenticating || mutable.value.selected != null || pollingJob?.isActive == true) return
        val epoch = generation
        pollingJob = viewModelScope.launch {
            var retries = 0
            while (isActive && epoch == generation) {
                delay(if (retries == 0) 3_000 else reconnectDelay(retries))
                if (!visible || !store.loggedIn || mutable.value.selected != null) return@launch
                if (refreshJob?.isActive == true || mutable.value.working) continue
                val previous = mutable.value.sessions
                try {
                    val sessions = repository.sessions()
                    if (epoch != generation) return@launch
                    // 先丢弃在途的旧列表，再记录版本，避免旧请求改写已读基线。
                    val current = mutable.value
                    if (current.selected != null || current.working || current.sessions !== previous) continue
                    val unviewed = recordSessions(sessions)
                    mutable.update {
                        it.copy(sessions = sessions, reconnecting = false, unviewedIds = unviewed)
                    }
                    updateRecentSessions(sessions)
                    retries = 0
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    if (epoch != generation) return@launch
                    if (e is ApiException && e.code == 401) {
                        failure(e)
                        return@launch
                    }
                    if (e.isConnectionFailure()) mutable.update { it.copy(reconnecting = true) }
                    retries = (retries + 1).coerceAtMost(4)
                }
            }
        }
    }

    /** 完整列表同步时直接替换；单个任务更新时保留尚未同步的缓存卡片。 */
    private fun updateRecentSessions(sessions: List<AiSession> = mutable.value.sessions + mutable.value.recentSessions) {
        val recent = sessions.filterNot { it.id.startsWith("local-") }.distinctBy { it.id }
            .sortedByDescending { it.updatedAt }.take(2)
        mutable.update { it.copy(recentSessions = recent) }
        repository.saveRecentSessions(recent)
    }

    /** 保持服务端仍存在的选择；失效时回落到默认供应商和首个模型，但不静默切到其他项目。 */
    private fun reconcile(ui: AiUiState): AiUiState {
        val project = ui.launchProject ?: ui.projects.firstOrNull()
        val projectUi = ui.copy(projectPath = project?.path.orEmpty())
        val choices = projectUi.availableProviders
        val provider = choices.find { it.id == ui.providerId }
            ?: choices.firstOrNull { it.isDefault && it.models.isNotEmpty() }
            ?: choices.firstOrNull { it.models.isNotEmpty() }
            ?: choices.firstOrNull()
        val model = provider?.models?.find { it.id == ui.modelId } ?: provider?.models?.firstOrNull()
        return projectUi.copy(providerId = provider?.id.orEmpty(), modelId = model?.id.orEmpty())
    }

    private fun saveSelection() {
        val ui = mutable.value
        repository.saveSelection(
            ui.projectPath, ui.providerId, ui.modelId, ui.launchProvider?.agent,
            quickStart = if (ui.homeLoaded) AiQuickStartCache(ui.projects, ui.providers) else null,
        )
    }

    fun selectProject(path: String) {
        mutable.update { reconcile(it.copy(projectPath = path)) }
        saveSelection()
    }

    fun selectAgent(agent: String) {
        mutable.update { ui ->
            if (ui.launchProvider?.agent == agent) return@update ui
            val choices = ui.availableProviders.filter { it.agent == agent }
            val savedProviderId = repository.selectedAgentProvider(agent)
            val savedModelId = repository.selectedAgentModel(agent)
            val savedProvider = choices.find { provider ->
                provider.id == savedProviderId && provider.models.any { it.id == savedModelId }
            }
            val provider = savedProvider
                ?: choices.firstOrNull { it.isDefault && it.models.isNotEmpty() }
                ?: choices.firstOrNull { it.models.isNotEmpty() }
                ?: choices.firstOrNull()
                ?: return@update ui
            reconcile(ui.copy(providerId = provider.id, modelId = if (savedProvider != null) savedModelId else ""))
        }
        saveSelection()
    }

    /** 各项目可以独立展开，缓存不会混入其他助手，也不会改写快速开始的选择。 */
    fun toggleServerHistory(agent: String, projectPath: String) {
        val ui = mutable.value
        if (!ui.authenticated || ui.authenticating || ui.working || ui.projects.none { it.path == projectPath }) return
        val key = AiServerHistoryKey(agent, projectPath)
        val previous = ui.serverHistory[key] ?: AiServerProjectHistory()
        updateServerHistory(key) { it.copy(expanded = !previous.expanded) }
        if (!previous.expanded && (!previous.loaded || previous.error != null)) loadServerHistory(agent, projectPath)
    }

    private fun updateServerHistory(key: AiServerHistoryKey, update: (AiServerProjectHistory) -> AiServerProjectHistory) {
        mutable.update { state -> state.copy(serverHistory = state.serverHistory +
            (key to update(state.serverHistory[key] ?: AiServerProjectHistory()))) }
    }

    /** 前后台切换取消的请求，只在项目仍展开且尚未成功加载时恢复。 */
    fun reloadExpandedServerHistory(agent: String? = null) {
        mutable.value.serverHistory.filter { (key, history) ->
            (agent == null || key.agent == agent) && history.expanded && !history.loaded && !history.loading && history.error == null
        }.keys.forEach { loadServerHistory(it.agent, it.projectPath) }
    }

    fun loadServerHistory(agent: String, projectPath: String) {
        val ui = mutable.value
        if (!store.loggedIn || ui.authenticating || agent !in listOf("claude", "codex") ||
            ui.projects.none { it.path == projectPath }) return
        val key = AiServerHistoryKey(agent, projectPath)
        if (serverHistoryJobs[key]?.isActive == true) return
        val epoch = generation
        updateServerHistory(key) { it.copy(loading = true, error = null) }
        // 先登记再启动，确保快速失败和账号切换时仍能准确取消、清理对应任务。
        val job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            try {
                val scanError = runCatching { repository.rescanHistory(agent) }.exceptionOrNull()
                if (scanError is CancellationException) throw scanError
                if (scanError is ApiException && scanError.code == 401) throw scanError
                val sessions = repository.history(agent, projectPath).sortedByDescending { it.updatedAt }
                if (epoch == generation) updateServerHistory(key) { it.copy(sessions = sessions, loaded = true) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    if (e is ApiException && e.code == 401) failure(e)
                    else updateServerHistory(key) { it.copy(error = if (e is ApiException && e.code == 404)
                        "服务端暂不支持该助手的历史会话，请更新服务端。" else e.userMessage()) }
                }
            } finally {
                if (serverHistoryJobs[key] === coroutineContext.job) {
                    serverHistoryJobs.remove(key)
                    updateServerHistory(key) { it.copy(loading = false) }
                }
            }
        }
        serverHistoryJobs[key] = job
        job.start()
    }

    /** 按历史模型及其供应商直接续接，独立于快速开始的选择。 */
    fun resumeServerHistory(agent: String, project: AiProject, item: AiHistorySession) {
        val ui = mutable.value
        if (ui.working || ui.authenticating || !ui.authenticated || agent !in listOf("claude", "codex")) return
        val models = ui.projectModels(project, agent)
        val historyModels = item.model?.trim()?.takeIf(String::isNotBlank)?.let { model ->
            models.filter { it.model.id.equals(model, ignoreCase = true) }
        }.orEmpty()
        // 先保留历史模型；同名模型优先默认供应商，缺失时才回退项目默认模型。
        val target = historyModels.firstOrNull { it.provider.isDefault } ?: historyModels.firstOrNull()
            ?: models.firstOrNull { it.provider.isDefault } ?: models.firstOrNull() ?: return
        val epoch = generation
        refreshJob?.cancel(); selectJob?.cancel(); cancelSend(); stopRealtime()
        mutable.update { it.copy(working = true, error = null) }
        actionJob = viewModelScope.launch {
            try {
                // 点按恢复前先刷新历史索引，预填才能带上电脑端最近输出的回合（best-effort，失败沿用现有索引）。
                val scanFailure = runCatching { repository.rescanHistory(agent) }.exceptionOrNull()
                if (scanFailure is CancellationException) throw scanFailure
                val session = if (agent == "codex")
                    repository.resumeCodexHistory(item.sessionId, target.provider, target.model)
                else repository.create(project, target.provider, target.model.id, item.sessionId)
                if (epoch != generation) return@launch
                mutable.update { it.copy(working = false) }
                open(session.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) failure(e)
            } finally {
                if (epoch == generation) mutable.update { it.copy(working = false) }
            }
        }
    }

    /** 简版首页的历史 Tab：汇总当前项目全部已启用助手的 CLI 历史，不受快速开始的助手选择影响。 */
    fun loadHistoryForSelection() {
        val ui = mutable.value
        if (!ui.authenticated || ui.authenticating) return
        val project = ui.launchProject
        val agents = historyAgents(ui)
        if (project == null || agents.isEmpty()) {
            cliHistoryJob?.cancel(); cliHistoryJob = null
            if (ui.historySessions.isNotEmpty() || ui.historyLoading) mutable.update {
                it.copy(historySessions = emptyList(), historyLoading = false, historyAgents = emptyList(),
                    historyProjectPath = "")
            }
            return
        }
        // 重新进入历史 Tab 时重新读取，确保刚完成的对话能出现在列表里；同一目标只在读取进行中时跳过。
        if (ui.historyAgents == agents && ui.historyProjectPath == project.path &&
            (ui.historyLoading || cliHistoryJob?.isActive == true)) return
        loadHistory(project, agents)
    }

    /** 历史范围 = 当前项目启用的助手。 */
    private fun historyAgents(ui: AiUiState) = ui.availableAgents

    /** 按项目并行读取各助手历史；单个助手不可用（如旧服务端不支持）不阻断其他助手。 */
    private fun loadHistory(project: AiProject, agents: List<String>) {
        cliHistoryJob?.cancel()
        cliHistoryJob = viewModelScope.launch {
            val switched = mutable.value.historyAgents != agents || mutable.value.historyProjectPath != project.path
            mutable.update {
                it.copy(
                    historyLoading = true, historyAgents = agents, historyProjectPath = project.path,
                    // 切换项目或助手集合时先清空旧列表，避免短暂显示其他项目的“历史会话”。
                    historySessions = if (switched) emptyList() else it.historySessions,
                )
            }
            try {
                val results = coroutineScope {
                    agents.map { agent ->
                        async {
                            agent to runCatching {
                                repository.rescanHistory(agent)
                                repository.history(agent, project.path)
                            }
                        }
                    }.awaitAll()
                }
                val failures = results.mapNotNull { (_, result) -> result.exceptionOrNull() }
                // 全部助手都失败才向用户报错；部分失败按空结果处理，仍展示其他助手的历史。
                if (failures.size == agents.size) throw failures.first()
                failures.firstOrNull { it is ApiException && it.code == 401 }?.let { throw it }
                val entries = results.flatMap { (agent, result) ->
                    result.getOrNull().orEmpty().map { AiHistoryEntry(agent, it) }
                }.distinctBy { it.session.sessionId }
                    .sortedByDescending { it.session.updatedAt }
                mutable.update { state ->
                    // 请求期间用户可能已切换项目或助手集合，过期结果直接丢弃。
                    if (state.historyAgents != agents || state.historyProjectPath != project.path) state
                    else state.copy(historySessions = entries, historyLoading = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (e is ApiException && e.code == 401) failure(e)
                mutable.update { state ->
                    if (state.historyAgents != agents || state.historyProjectPath != project.path) state
                    else state.copy(historyLoading = false, error = e.userMessage())
                }
            }
        }
    }

    /** 恢复 CLI 历史会话为可继续对话的原生会话：服务端绑定历史线程并预填最近消息。 */
    fun resumeHistory(entry: AiHistoryEntry) {
        val ui = mutable.value
        val project = ui.launchProject ?: return
        if (ui.working || ui.authenticating || !ui.authenticated) return
        val target = resumeTarget(ui, project, entry.agent, entry.session.model) ?: return
        cliHistoryJob?.cancel()
        refreshJob?.cancel(); selectJob?.cancel(); cancelSend(); stopRealtime()
        mutable.update { it.copy(working = true, error = null) }
        viewModelScope.launch {
            try {
                // 点按恢复前先刷新历史索引，预填才能带上电脑端最近输出的回合（best-effort，失败沿用现有索引）。
                val scanFailure = runCatching { repository.rescanHistory(entry.agent) }.exceptionOrNull()
                if (scanFailure is CancellationException) throw scanFailure
                val session = repository.create(project, target.provider, target.model.id, entry.session.sessionId)
                mutable.update { it.copy(working = false) }
                // 列表由账号级通知流自行刷新；这里直接进入恢复出的会话。
                open(session.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutable.update { it.copy(working = false) }
                failure(e)
            }
        }
    }

    /** 历史会话恢复的目标配置：优先沿用历史模型（同名模型优先默认供应商），缺失时回退该助手的默认配置。 */
    private fun resumeTarget(ui: AiUiState, project: AiProject, agent: String, historyModel: String?): AiLaunchModel? {
        val models = ui.projectModels(project, agent)
        val matches = historyModel?.trim()?.takeIf(String::isNotBlank)?.let { model ->
            models.filter { it.model.id.equals(model, ignoreCase = true) }
        }.orEmpty()
        return matches.firstOrNull { it.provider.isDefault } ?: matches.firstOrNull()
            ?: models.firstOrNull { it.provider.isDefault } ?: models.firstOrNull()
    }

    fun selectModel(key: String) {
        mutable.update { ui ->
            val target = ui.availableModels.find { it.key == key } ?: return@update ui
            reconcile(ui.copy(providerId = target.provider.id, modelId = target.model.id))
        }
        saveSelection()
    }

    /** 项目页的选择一次性应用，复用快速开始的本地会话壳与首次发送流程。 */
    fun createFromProject(path: String, modelKey: String) {
        val ui = mutable.value
        if (ui.working || ui.authenticating || ui.initialLoading) return
        val project = ui.projects.find { it.path == path } ?: return
        val target = ui.projectModels(project).find { it.key == modelKey } ?: return
        mutable.update { it.copy(projectPath = path, providerId = target.provider.id, modelId = target.model.id) }
        saveSelection()
        create()
    }

    fun toggleCodexHistory() {
        val expanded = !mutable.value.history.expanded
        mutable.update { it.copy(history = it.history.copy(expanded = expanded)) }
        if (expanded && !mutable.value.history.loaded) loadCodexHistory()
    }

    fun loadCodexHistory() {
        if (!store.loggedIn || mutable.value.authenticating || historyJob?.isActive == true) return
        val epoch = generation
        historyJob = viewModelScope.launch {
            mutable.update { it.copy(history = it.history.copy(loading = true, error = null)) }
            try {
                val scan = repository.scanCodexHistory()
                val sessions = repository.codexHistory()
                if (epoch == generation) mutable.update {
                    it.copy(history = it.history.copy(sessions = sessions, loaded = true, indexing = scan.pending > 0))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    if (e is ApiException && e.code == 401) failure(e)
                    else mutable.update { it.copy(history = it.history.copy(error = if (e is ApiException && e.code == 404)
                        "服务端暂不支持 Codex 历史，请更新 TerminalBuddy 服务端" else e.userMessage())) }
                }
            } finally {
                if (historyJob === coroutineContext.job) {
                    historyJob = null
                    mutable.update { it.copy(history = it.history.copy(loading = false)) }
                }
            }
        }
    }

    fun openCodexHistory(session: AiHistorySession) {
        if (mutable.value.authenticating || mutable.value.working) return
        historyReplayJob?.cancel(); historyReplayJob = null
        mutable.update { it.copy(history = it.history.copy(selected = session, replay = null, replayError = null, loadingReplay = false)) }
        loadCodexReplay()
    }

    fun closeCodexHistory() {
        if (mutable.value.working) return
        historyReplayJob?.cancel(); historyReplayJob = null
        mutable.update { it.copy(history = it.history.copy(selected = null, replay = null, replayError = null, loadingReplay = false)) }
    }

    fun loadCodexReplay(more: Boolean = false) {
        if (!store.loggedIn || mutable.value.authenticating) return
        val history = mutable.value.history
        val session = history.selected ?: return
        if (historyReplayJob?.isActive == true) return
        val offset = if (more) history.replay?.messages?.size ?: 0 else 0
        if (more && offset.toLong() >= (history.replay?.total ?: 0)) return
        val epoch = generation
        historyReplayJob = viewModelScope.launch {
            mutable.update { it.copy(history = it.history.copy(loadingReplay = true, replayError = null)) }
            try {
                val page = repository.codexHistoryReplay(session.sessionId, offset)
                if (epoch == generation && mutable.value.history.selected?.sessionId == session.sessionId) mutable.update {
                    val messages = if (offset == 0) page.messages
                        else (it.history.replay?.messages.orEmpty() + page.messages).distinctBy(AiHistoryMessage::seq)
                    it.copy(history = it.history.copy(replay = page.copy(messages = messages)))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    if (e is ApiException && e.code == 401) failure(e)
                    else mutable.update { it.copy(history = it.history.copy(replayError = e.userMessage())) }
                }
            } finally {
                if (historyReplayJob === coroutineContext.job) {
                    historyReplayJob = null
                    mutable.update { it.copy(history = it.history.copy(loadingReplay = false)) }
                }
            }
        }
    }

    fun resumeCodexHistory(modelKey: String) {
        val ui = mutable.value
        val source = ui.history.selected ?: return
        if (ui.working || ui.authenticating) return
        val project = historyProject(ui.projects, ui.history.replay?.projectDir ?: source.projectDir) ?: return
        val target = ui.projectModels(project, "codex").find { it.key == modelKey } ?: return
        val epoch = generation
        actionJob = viewModelScope.launch {
            mutable.update { it.copy(working = true, error = null) }
            try {
                val session = repository.resumeCodexHistory(source.sessionId, target.provider, target.model)
                if (epoch != generation) return@launch
                mutable.update { it.copy(history = it.history.copy(selected = null, replay = null)) }
                open(session.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) failure(e)
            } finally {
                if (epoch == generation) mutable.update { it.copy(working = false) }
            }
        }
    }

    /** 先显示内存 / SQLite 中的完整会话，网络请求与磁盘恢复并行，随后静默同步。 */
    fun open(id: String) {
        rememberOpened(id)
        if (mutable.value.selected?.id == id) {
            if (pending == null) startRealtime(refreshImmediately = true)
            return
        }
        refreshJob?.cancel(); selectJob?.cancel(); cancelSend(); stopRealtime()
        pending = null
        val epoch = ++generation
        val cacheScope = repository.sessionCache.scope()
        val cached = cacheScope?.let { repository.sessionCache.peek(it, id) }
        val initial = cached ?: mutable.value.sessions.find { it.id == id }
            ?: mutable.value.recentSessions.find { it.id == id }
            ?: AiSession(id, "正在加载对话", "", "")
        repository.lastSession = id
        mutable.update {
            it.copy(
                selected = initial, loading = false, loadingSession = cached == null,
                draft = drafts[id].orEmpty(), attachments = emptyList(), sending = false, working = false, error = null,
            )
        }
        selectJob = viewModelScope.launch restoreCache@{
            if (cached == null && cacheScope != null) {
                val stored = repository.sessionCache.read(cacheScope, id) ?: return@restoreCache
                if (epoch == generation) mutable.update { current ->
                    // 网络若先返回，则不再用磁盘快照覆盖；读缓存不推进已读版本。
                    if (current.selected === initial) current.copy(selected = stored, loadingSession = false) else current
                }
            }
        }
        // 实时首帧、REST 补偿和磁盘恢复并行，不再等待完整 GET 才建立连接。
        startRealtime(refreshImmediately = true)
    }

    /**
     * 打开原生会话时登记到「已打开」。只记在内存：App 重启后以服务端
     * `desktopOpen` 标记为准，不再沿用手机历史上点开过的会话。
     */
    private fun rememberOpened(id: String) {
        if (id.isBlank() || id.startsWith("local-")) return
        if (id !in mutable.value.openedSessionIds) {
            mutable.update { it.copy(openedSessionIds = it.openedSessionIds + id) }
        }
    }

    fun closeSession() {
        generation++
        selectJob?.cancel(); cancelSend(); stopRealtime(); repository.lastSession = ""
        pending = null
        mutable.update {
            it.copy(selected = null, draft = "", attachments = emptyList(), loadingSession = false, sending = false, working = false, error = null)
        }
        refresh()
    }

    /** 先打开本地会话壳，首次发送成功后才在服务端落盘。 */
    fun create() {
        val ui = mutable.value
        val project = ui.launchProject ?: return
        val provider = ui.launchProvider ?: return
        val model = ui.launchModel ?: return
        if (!ui.canCreate) return
        refreshJob?.cancel(); selectJob?.cancel(); cancelSend(); stopRealtime()
        val session = AiSession(
            id = "local-${UUID.randomUUID()}",
            title = "新对话",
            provider = provider.agent,
            projectPath = project.path,
            providerId = provider.id,
            providerName = provider.name,
            model = model.id.takeIf(String::isNotBlank),
            usage = AiUsage(
                context = AiContextUsage(usedTokens = 0),
                sessionTotal = AiTokenUsage(inputTokens = 0, outputTokens = 0, coverage = "complete"),
            ),
        )
        pending = session
        ++generation
        repository.lastSession = ""
        mutable.update {
            it.copy(
                selected = session, loading = false, loadingSession = false,
                draft = "", attachments = emptyList(), sending = false, working = false, connected = false,
                reconnecting = false, error = null,
            )
        }
    }

    fun draft(text: String) {
        mutable.value.selected?.id?.let { drafts[it] = text }
        mutable.update { it.copy(draft = text) }
    }

    /** 从系统相册 / 文件选择器添加图片：读取为 base64 并生成即时预览。 */
    fun addImages(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val room = (MAX_ATTACHMENTS - mutable.value.attachments.size).coerceAtLeast(0)
        if (room == 0) {
            mutable.update { it.copy(error = "一次最多发送 $MAX_ATTACHMENTS 张图片") }
            return
        }
        if (uris.size > room) mutable.update { it.copy(error = "一次最多发送 $MAX_ATTACHMENTS 张图片") }
        val selected = uris.take(room)
        viewModelScope.launch {
            val images = withContext(Dispatchers.IO) {
                selected.mapNotNull { uri -> runCatching { readDraftImage(uri) }.getOrNull() }
            }
            if (images.isEmpty()) {
                mutable.update { it.copy(error = "图片读取失败，请选择 10MB 以内的 PNG / JPEG / GIF / WebP 图片") }
                return@launch
            }
            mutable.update { current ->
                current.copy(attachments = (current.attachments + images).take(MAX_ATTACHMENTS))
            }
        }
    }

    fun removeAttachment(id: String) {
        mutable.update { it.copy(attachments = it.attachments.filterNot { image -> image.id == id }) }
    }

    private fun readDraftImage(uri: Uri): AiDraftImage {
        val resolver = getApplication<Application>().contentResolver
        val mediaType = resolver.getType(uri)?.lowercase()
            ?.takeIf { it.startsWith("image/") }
            ?: throw IllegalArgumentException("仅支持图片文件")
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IllegalArgumentException("无法读取图片")
        if (bytes.isEmpty() || bytes.size > MAX_ATTACHMENT_BYTES) throw IllegalArgumentException("图片超过 10MB")
        val data = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val name = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull() ?: "图片"
        return AiDraftImage(UUID.randomUUID().toString(), "data:$mediaType;base64,$data", data, mediaType, name)
    }

    /** 服务端图片预览地址：本地 data: URL 直接返回，落盘附件走带 JWT 的只读文件接口。 */
    fun imageUrl(path: String): String =
        if (path.startsWith("data:")) path
        else ServerAddress.endpoint(store.server, listOf("desktop", "file"), mapOf("path" to path, "token" to store.token)).toString()

    /**
     * `/` 补全候选：优先使用会话自身的 `system/init` 清单；
     * 新建会话尚未启动 CLI 时回退到同一 Agent 最近一次拿到的缓存。
     */
    fun slashItems(draft: String): List<AiSlashItem> {
        val session = mutable.value.selected ?: return emptyList()
        return slashCompletions(session.slashCatalog ?: cachedSlashCatalog(session.provider), draft)
    }

    /** 按 Agent 记住解析结果，避免每敲一个字符都重新读偏好并反序列化清单。 */
    private fun cachedSlashCatalog(agent: String): AiSlashCatalog? {
        slashFallback?.let { (cachedAgent, catalog) -> if (cachedAgent == agent) return catalog }
        val catalog = repository.cachedSlashCatalog(agent)
        slashFallback = agent to catalog
        return catalog
    }

    /** 退出或切换会话时，尚未确认的消息回到草稿，仍可复用原请求标识重试。 */
    private fun cancelSend() {
        sendJob?.cancel()
        sendJob = null
        clearOutgoing(restoreDraft = true)
    }

    /** 发送确认后按 requestId 替换本地占位，避免等待完整历史回包。 */
    private fun confirmedUserMessage(sessionId: String, requestId: String) {
        val message = outgoing?.takeIf { it.sessionId == sessionId && it.requestId == requestId } ?: return
        outgoing = null
        mutable.update { current ->
            val selected = current.selected
            if (selected == null || selected.id != sessionId) current
            else current.copy(selected = selected.copy(
                messages = selected.messages.map { item ->
                    if (item.id == message.message.id) item.copy(id = requestId) else item
                },
                pendingInputs = selected.pendingInputs.map { item ->
                    if (item.requestId == message.message.id) item.copy(requestId = requestId) else item
                },
            ))
        }
    }

    private fun clearOutgoing(restoreDraft: Boolean) {
        val message = outgoing ?: return
        outgoing = null
        val restored = drafts[message.sessionId].orEmpty().let { draft ->
            if (restoreDraft && draft.isEmpty()) message.draft else draft
        }
        drafts[message.sessionId] = restored
        mutable.update { current ->
            val selected = current.selected
            if (selected == null || selected.id != message.sessionId) current
            else current.copy(
                selected = selected.copy(
                    messages = selected.messages.filterNot { it.id == message.message.id },
                    pendingInputs = selected.pendingInputs.filterNot { it.requestId == message.message.id },
                ),
                draft = restored,
                // 失败/取消时把待发送图片放回输入框上方；成功确认时当前列表已为空。
                attachments = if (restoreDraft && current.attachments.isEmpty()) message.attachments else current.attachments,
            )
        }
    }

    fun send() {
        val ui = mutable.value
        val session = ui.selected ?: return
        val text = ui.draft.trim()
        val attachments = ui.attachments
        if ((text.isEmpty() && attachments.isEmpty()) || !session.canSend || ui.sending || ui.loadingSession || sendJob?.isActive == true) return
        val launch = if (pending?.id == session.id) {
            val project = ui.launchProject ?: return
            val provider = ui.launchProvider ?: return
            val model = ui.launchModel ?: return
            Triple(project, provider, model)
        } else null
        // 文本 + 图片共同构成幂等键：只改图片时不能复用旧的 requestId。
        val signature = text + "\u0000" + attachments.joinToString("\u0000") { it.id }
        val request = requests[session.id]?.takeIf { it.first == signature }
            ?: (signature to UUID.randomUUID().toString()).also { requests[session.id] = it }
        val message = OutgoingMessage(
            session.id,
            AiMessage(
                "local-${request.second}", "user", text, System.currentTimeMillis(),
                // 本地占位用 dataUrl 直接预览；服务端确认后会被落盘路径替换。
                images = attachments.map { AiChatImage(it.dataUrl, it.mediaType, it.name) },
            ),
            ui.draft,
            queued = session.running || session.pendingInputs.isNotEmpty(),
            attachments = attachments,
        )
        outgoing = message
        drafts[session.id] = ""
        // 任务未结束时只在下方队列显示，发送确认后即可继续添加下一条。
        mutable.update {
            it.copy(selected = message.display(session), draft = "", attachments = emptyList(), sending = true, error = null)
        }
        val notificationAccountId = repository.accounts.activeId
        notificationAccountId?.let { taskNotifications.expectTask(it, session) }
        // 首发送可能先以 local-* 临时 ID 登记通知基线，创建成功后再替换为真实 ID；
        // 失败路径必须清理对应条目，否则「运行中」通知会滞留到 2 分钟兜底。
        var notificationSessionId = session.id
        val epoch = generation
        sendJob = viewModelScope.launch {
            try {
                val target = if (launch == null) session else repository.create(
                    launch.first, launch.second, launch.third.id,
                ).also { created ->
                    if (pending?.id == session.id) pending = null
                    if (epoch == generation && mutable.value.selected?.id == session.id) {
                        if (visible) markViewed(created.id, created.revision)
                        notificationAccountId?.let { taskNotifications.replaceExpectedTask(it, session.id, created) }
                        notificationSessionId = created.id
                        outgoing = outgoing?.copy(sessionId = created.id)
                        mutable.update { current -> current.copy(selected = current.selected?.copy(id = created.id)) }
                        drafts[created.id] = drafts.remove(session.id).orEmpty()
                        requests.remove(session.id)
                        requests[created.id] = request
                        // 新建会话在服务端落盘后立即登记到「已打开」。
                        rememberOpened(created.id)
                    }
                }
                if (epoch != generation || mutable.value.selected?.id != target.id) return@launch
                // 真实会话 ID 就绪后启动实时订阅和轮询，首次发送也能持续接收回复。
                repository.accounts.activeId?.let { taskNotifications.expectTask(it, target) }
                startRealtime()
                // 回复进行中：排队模式等当前回合任务完成后由服务端续发；插话模式直接交给当前 CLI 进程。
                // 发送只负责“服务端已接纳”：服务端确认最多等 60 秒。长文本/图片仍可完整上传，
                // 但不会再因一次半开连接把发送按钮永远锁在转圈状态。
                val result = withTimeout(60_000) {
                    repository.send(
                        target.id, text, request.second, ui.sendSteer,
                        attachments.map { AiSendImage(it.data, it.mediaType, it.name) },
                    )
                }
                if (epoch != generation || mutable.value.selected?.id != target.id) return@launch
                requests.remove(target.id)
                // 服务端已确认该 requestId；本地占位无需再等完整快照回来。
                // 旧服务端返回完整会话时，后续实时帧会按版本合并。
                confirmedUserMessage(target.id, request.second)
                mutable.update { current ->
                    val selected = current.selected
                    if (selected == null || selected.id != target.id) current
                    else current.copy(selected = selected.copy(revision = maxOf(selected.revision, result.revision)))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    clearOutgoing(restoreDraft = true)
                    // 发送失败时撤掉刚登记的「运行中」通知基线。
                    notificationAccountId?.let { taskNotifications.forgetSession(it, notificationSessionId) }
                    failure(e)
                }
            } finally {
                if (epoch == generation) mutable.update { it.copy(sending = false) }
            }
        }
    }

    /** 插话排队消息：服务端把该消息直接交给运行中的 CLI 进程，不中断当前任务。 */
    fun sendQueuedNow(requestId: String) {
        action { repository.flush(it.id, requestId) }
    }

    fun deleteQueuedMessage(requestId: String) {
        // 当前发送就绪后可删除；占位 ID 只存在于本地，提交时会被服务端拒绝，因此直接忽略。
        if (requestId.startsWith("local-")) return
        action { repository.deletePendingInput(it.id, requestId) }
    }

    /** 发送方式是全局设置，立即生效并持久化，不影响服务端已排队的消息。 */
    fun setSendSteer(value: Boolean) {
        repository.sendSteer = value
        mutable.update { it.copy(sendSteer = value) }
    }

    /** 强制结束：入口在「对话操作」中，二次确认后调用。成功后立即采用服务端已落盘的终止快照。 */
    fun forceStop() {
        val session = mutable.value.selected ?: return
        if (actionJob?.isActive == true) return
        val epoch = generation
        mutable.update { it.copy(working = true, error = null) }
        actionJob = viewModelScope.launch {
            try {
                // 强制结束本身是服务端毫秒级操作；AI 客户端默认不设超时，
                // 代理切换或半开连接会让按钮永久卡在「处理中」，这里显式限时。
                val snapshot = withTimeoutOrNull(FORCE_STOP_TIMEOUT_MS) { repository.forceStop(session.id) }
                if (snapshot == null) {
                    if (epoch == generation) {
                        mutable.update { it.copy(error = "强制结束请求超时，请检查网络后重试") }
                        // 超时后用普通超时的客户端补拉一次，确认是否其实已成功。
                        withTimeoutOrNull(3_000) { repository.session(session.id) }?.let(::receive)
                    }
                } else if (epoch == generation) {
                    receive(snapshot)
                    // 终止结果不是执行故障：清掉任何旧错误，只保留状态文案。
                    mutable.update {
                        if (it.selected?.id == snapshot.id) it.copy(error = null) else it
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) failure(e)
            } finally {
                if (epoch == generation) mutable.update { it.copy(working = false) }
            }
        }
    }

    fun stop() {
        val session = mutable.value.selected ?: return
        if (actionJob?.isActive == true || session.status == "stopping") return
        val epoch = generation
        // 点击即反馈，不等网络返回；失败时恢复原状态并展示原因。
        mutable.update { it.copy(working = true, error = null, selected = it.selected?.copy(status = "stopping")) }
        actionJob = viewModelScope.launch {
            try {
                repository.stop(session.id)
                if (epoch == generation) {
                    withTimeoutOrNull(3_000) { repository.session(session.id) }?.let(::receive)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    mutable.update { it.copy(selected = it.selected?.takeIf { item -> item.id == session.id }?.copy(status = session.status) ?: it.selected) }
                    failure(e)
                }
            } finally {
                if (epoch == generation) mutable.update { it.copy(working = false) }
            }
        }
    }

    /** 点击后立即收起卡片；旧快照不能让已提交的请求重新出现，提交失败时恢复。 */
    fun answer(approval: AiApproval, decision: String, answers: JsonObject = JsonObject(emptyMap())) {
        val session = mutable.value.selected ?: return
        if (actionJob?.isActive == true || approval.id in mutable.value.answeringApprovalIds) return
        if (session.approvals.none { it.id == approval.id }) return
        val epoch = generation
        mutable.update { it.copy(working = true, error = null, answeringApprovalIds = it.answeringApprovalIds + approval.id) }
        actionJob = viewModelScope.launch {
            var submitted = false
            try {
                repository.answer(session.id, approval, decision, answers)
                submitted = true
                if (epoch == generation) withTimeoutOrNull(3_000) { repository.session(session.id) }?.let(::receive)
            } catch (e: CancellationException) {
                if (epoch == generation && !submitted) mutable.update {
                    it.copy(answeringApprovalIds = it.answeringApprovalIds - approval.id)
                }
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    if (!submitted) mutable.update { it.copy(answeringApprovalIds = it.answeringApprovalIds - approval.id) }
                    failure(e)
                }
            } finally {
                if (epoch == generation) mutable.update { it.copy(working = false) }
            }
        }
    }

    fun delete(session: AiSession) {
        if (pending?.id == session.id) {
            drafts.remove(session.id); requests.remove(session.id)
            closeSession()
            return
        }
        if (actionJob?.isActive == true) return
        val epoch = generation
        actionJob = viewModelScope.launch {
            mutable.update { it.copy(working = true, error = null) }
            try {
                repository.delete(session.id)
                if (epoch == generation) {
                    if (mutable.value.selected?.id == session.id) closeSession()
                    mutable.update {
                        it.copy(
                            sessions = it.sessions.filterNot { item -> item.id == session.id },
                            openedSessionIds = it.openedSessionIds - session.id, working = false,
                        )
                    }
                    drafts.remove(session.id); requests.remove(session.id)
                    forgetSession(session.id)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    mutable.update { it.copy(working = false) }
                    failure(e)
                }
            }
        }
    }

    /** 批量清理未运行对话，逐条同步成功结果，失败项保留供重试。 */
    fun deleteAll() {
        if (actionJob?.isActive == true || mutable.value.working) return
        val sessions = mutable.value.sessions.filterNot { it.running }
        if (sessions.isEmpty()) return
        refreshJob?.cancel(); refreshJob = null
        val epoch = generation
        actionJob = viewModelScope.launch {
            mutable.update { it.copy(working = true, deletingAll = true, loading = false, error = null) }
            var deleted = 0
            var firstError: Throwable? = null
            try {
                for (session in sessions) {
                    if (epoch != generation) return@launch
                    try {
                        repository.delete(session.id)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        if (epoch != generation) return@launch
                        if (firstError == null) firstError = e
                        if (e.isConnectionFailure() || (e is ApiException && e.code == 401)) {
                            firstError = e
                            break
                        }
                        continue
                    }
                    if (epoch != generation) return@launch
                    mutable.update {
                        it.copy(
                            sessions = it.sessions.filterNot { item -> item.id == session.id },
                            openedSessionIds = it.openedSessionIds - session.id,
                        )
                    }
                    drafts.remove(session.id); requests.remove(session.id)
                    forgetSession(session.id)
                    deleted++
                }
            } finally {
                if (epoch == generation) mutable.update { it.copy(working = false, deletingAll = false) }
            }
            if (epoch != generation) return@launch
            firstError?.let { error ->
                failure(error)
                if (epoch == generation) mutable.update {
                    it.copy(error = "已删除 $deleted 段对话，仍有 ${sessions.size - deleted} 段未删除：${error.userMessage()}")
                }
            }
        }
    }

    /** 中断 / 确认这类动作完成后主动拉一次完整会话，走与 WebSocket 相同的合并逻辑。 */
    private fun action(block: suspend (AiSession) -> Unit) {
        val session = mutable.value.selected ?: return
        if (actionJob?.isActive == true) return
        val epoch = generation
        actionJob = viewModelScope.launch {
            mutable.update { it.copy(working = true, error = null) }
            try {
                block(session)
                if (epoch == generation) {
                    // 停止、插话等动作已由服务端实时推送最终状态；这里只在 3 秒内补拉一次，
                    // 避免长会话在动作完成后又被完整 GET 拖住，让按钮长时间显示“处理中”。
                    withTimeoutOrNull(3_000) { repository.session(session.id) }?.let(::receive)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) failure(e)
            } finally {
                if (epoch == generation) mutable.update { it.copy(working = false) }
            }
        }
    }

    /** Revision 单调递增：旧快照不会覆盖新状态；列表项按更新时间重排且不携带完整历史。 */
    private fun receive(session: AiSession) {
        val selected = mutable.value.selected ?: return
        if (selected.id != session.id || session.revision < selected.revision) return
        // `/` 清单随 CLI 启动刷新：按 Agent 缓存一份，新会话在 init 到达前也能补全。
        session.slashCatalog?.let { catalog ->
            repository.saveSlashCatalog(session.provider, catalog)
            slashFallback = session.provider to catalog
        }
        // 只缓存服务端原始快照，本地尚未确认的消息仍由 outgoing 单独管理。
        repository.sessionCache.scope()?.let { repository.sessionCache.save(it, session) }
        repository.accounts.activeId?.let { taskNotifications.observe(it, listOf(session)) }
        if (pending?.id == session.id) pending = null
        val message = outgoing?.takeIf { it.sessionId == session.id }
        // 入队也算发送确认；按请求标识匹配，连续发送相同正文仍是独立消息。
        // 服务端现在会先回传轻量确认，这里仍保留快照兜底，兼容尚未升级的服务端。
        val accepted = message != null && (
            session.messages.any { it.role == "user" && it.id == message.requestId } ||
                session.pendingInputs.any { it.requestId == message.requestId }
        )
        if (accepted) {
            outgoing = null
            requests.remove(session.id)
        }
        val displayed = if (message != null && !accepted) message.display(session) else session
        // 只有当前可见会话的有效正文快照才算查看；后台或迟到的响应不能清除提示。
        if (visible) markViewed(session.id, session.revision)
        mutable.update { current ->
            val currentSelected = current.selected
            if (currentSelected == null || currentSelected.id != session.id || session.revision < currentSelected.revision) current
            else current.copy(
                selected = displayed, loadingSession = false,
                answeringApprovalIds = current.answeringApprovalIds.intersect(session.approvals.map { it.id }.toSet()),
                sessions = (listOf(session.copy(messages = emptyList())) + current.sessions.filterNot { it.id == session.id })
                    .sortedByDescending { it.updatedAt },
            )
        }
        updateRecentSessions()
    }

    /** 首次使用时接纳现有历史；已保存的空表也必须保留，不能重新建立基线。 */
    private fun ensureViewedBaseline(sessions: List<AiSession> = mutable.value.sessions) {
        if (viewedBaselineReady) return
        viewedRevisions = (repository.viewedRevisions()
            ?: sessions.associate { it.id to it.revision }).toMutableMap()
        viewedBaselineReady = true
    }

    /**
     * 列表不含消息正文，直接比较当前版本与最后实际查看版本。
     * 运行中的快照不推进已读基线，结束或等待确认后仍能识别未查看结果。
     */
    private fun recordSessions(sessions: List<AiSession>): Set<String> {
        repository.accounts.activeId?.let { taskNotifications.observe(it, sessions, accountSnapshot = true) }
        ensureViewedBaseline(sessions)
        val visibleIds = sessions.mapTo(mutableSetOf()) { it.id }
        viewedRevisions.keys.retainAll(visibleIds)
        val unviewed = sessions.filter { session ->
            // 服务端新建的空会话版本为 1，没有执行结果，不应提示已完成。
            val viewed = viewedRevisions[session.id] ?: 1L
            session.status != "running" && session.status != "background" && session.status != "stopping" && session.revision > viewed
        }.mapTo(mutableSetOf()) { it.id }
        repository.saveViewedRevisions(viewedRevisions)
        return unviewed
    }

    private fun markViewed(id: String, revision: Long) {
        ensureViewedBaseline()
        viewedRevisions[id] = maxOf(viewedRevisions[id] ?: 0, revision)
        repository.saveViewedRevisions(viewedRevisions)
        mutable.update { it.copy(unviewedIds = it.unviewedIds - id) }
    }

    private fun forgetSession(id: String) {
        repository.accounts.activeId?.let { taskNotifications.forgetSession(it, id) }
        repository.sessionCache.scope()?.let { repository.sessionCache.remove(it, id) }
        ensureViewedBaseline()
        viewedRevisions.remove(id)
        repository.saveViewedRevisions(viewedRevisions)
        mutable.update {
            it.copy(unviewedIds = it.unviewedIds - id, recentSessions = it.recentSessions.filterNot { session -> session.id == id })
        }
        updateRecentSessions()
    }

    /** 正常订阅和前台恢复静默补拉；重连状态仅由实际断线更新。 */
    private fun startRealtime(refreshImmediately: Boolean = false) {
        val id = mutable.value.selected?.id ?: return
        if (!visible || !store.loggedIn || mutable.value.authenticating || streamJob?.isActive == true) return
        val epoch = generation
        val cache = repository.sessionCache
        cache.scope()?.let { cacheScope ->
            // 从后台恢复时先用已经持续同步的正文，网络连接随后静默追上。
            cache.peek(cacheScope, id)?.let(::receive)
            cacheJob?.cancel()
            cacheJob = viewModelScope.launch {
                cache.observe(cacheScope, id).collect { snapshot ->
                    if (epoch == generation) receive(snapshot)
                }
            }
        }
        streamJob = viewModelScope.launch {
            var retries = 0
            while (isActive && epoch == generation) {
                try {
                    repository.observe(id).collect { snapshot ->
                        if (epoch == generation) {
                            retries = 0
                            mutable.update { it.copy(connected = true, reconnecting = false, loadingSession = false) }
                            receive(snapshot)
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    if (epoch != generation) return@launch
                    if (e is ApiException && e.code == 404) {
                        closeSession()
                        mutable.update { it.copy(error = "该任务已删除或当前账号无法访问") }
                        return@launch
                    }
                    if (e is ApiException && e.code == 401) {
                        failure(e)
                        return@launch
                    }
                }
                if (epoch != generation) break
                mutable.update {
                    // REST 补偿成功后保持在线提示，避免代理拦截 WS 时每次重试都闪现。
                    it.copy(connected = false, reconnecting = it.reconnecting || it.connected || it.loadingSession)
                }
                delay(reconnectDelay(retries))
                retries = (retries + 1).coerceAtMost(4)
            }
        }
        // WS 被代理拦截时仍能同步：连上时 15 秒补一次，断开时 3 秒一次。
        pollingJob = viewModelScope.launch {
            var refreshNow = refreshImmediately
            while (isActive && epoch == generation) {
                if (!refreshNow) delay(if (mutable.value.connected) 15_000 else 3_000)
                refreshNow = false
                try {
                    val snapshot = repository.session(id)
                    if (epoch == generation) {
                        receive(snapshot)
                        mutable.update { it.copy(reconnecting = false, loadingSession = false, error = null) }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    if (epoch != generation) return@launch
                    if (e is ApiException && e.code == 404) {
                        closeSession()
                        mutable.update { it.copy(error = "该任务已删除或当前账号无法访问") }
                        return@launch
                    }
                    failure(e)
                }
            }
        }
    }

    private fun stopRealtime() {
        cacheJob?.cancel(); cacheJob = null
        streamJob?.cancel(); streamJob = null
        pollingJob?.cancel(); pollingJob = null
        mutable.update { it.copy(connected = false, reconnecting = false) }
    }

    /** 首次半秒后重试，逐步退避至八秒；网络恢复事件会直接跳过等待。 */
    private fun reconnectDelay(attempt: Int): Long = 500L shl attempt.coerceIn(0, 4)
}
