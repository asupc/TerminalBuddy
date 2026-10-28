package com.terminalbuddy.android

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.terminalbuddy.android.data.*
import com.terminalbuddy.android.notifications.AiNotificationTarget
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID

/** 同名模型保留供应商身份，避免选择模型后切换到另一套启动配置。 */
data class AiLaunchModel(val provider: AiProvider, val model: AiModel) {
    val key get() = "${provider.id.length}:${provider.id}${model.id}"
}

/**
 * AI 页面状态。登录、项目 / Agent / 模型选择和当前会话各自独立，
 * 首页同步不会覆盖正在进行的对话；关闭 App 后重新打开回到选择首页。
 */
data class AiUiState(
    val server: String = "", val username: String = "admin", val authenticated: Boolean = false,
    val authenticating: Boolean = false, val loading: Boolean = false, val loadingSession: Boolean = false,
    val sessions: List<AiSession> = emptyList(), val projects: List<AiProject> = emptyList(),
    val providers: List<AiProvider> = emptyList(), val agentEnvironment: AiAgentEnvironment? = null,
    val projectPath: String = "", val providerId: String = "", val modelId: String = "",
    val selected: AiSession? = null, val draft: String = "", val sending: Boolean = false,
    val connected: Boolean = false, val working: Boolean = false, val error: String? = null,
    val answeringApprovalIds: Set<String> = emptySet(),
    val reconnecting: Boolean = false,
    val deletingAll: Boolean = false,
    val connectionRevision: Long = 0,
    val homeLoaded: Boolean = false,
    val unviewedIds: Set<String> = emptySet(),
    val accounts: List<AiAccount> = emptyList(), val activeAccountId: String? = null,
    val switchingAccountId: String? = null,
    val notificationLoginAccountId: String? = null,
    /** 历史会话区默认收起，展开后按当前项目 + Agent 拉取 CLI 转录历史。 */
    val historyExpanded: Boolean = false,
    val historySessions: List<AiHistorySession> = emptyList(),
    val historyLoading: Boolean = false,
    val historyAgent: String? = null,
    val historyProjectPath: String = "",
    /** 连续发送方式：false 回复期间在服务端排队等待，true 中断当前回复立即发送。 */
    val sendImmediate: Boolean = false,
    val history: AiHistoryState = AiHistoryState(),
    val serverHistory: Map<AiServerHistoryKey, AiServerProjectHistory> = emptyMap(),
) {
    /** 仅首次取数限制操作，后续刷新保留已有内容并保持页面可操作。 */
    val initialLoading get() = loading && !homeLoaded
    val launchProject get() = projects.find { it.path == projectPath }
    /** 只列出当前项目启用的 Agent 对应供应商。 */
    fun projectProviders(project: AiProject) = providers.filter { project.enabledAgents.enabled(it.agent) }
    fun projectModels(project: AiProject, agent: String? = null) = projectProviders(project)
        .filter { agent == null || it.agent == agent }
        .flatMap { provider -> provider.models.map { AiLaunchModel(provider, it) } }
    val availableProviders get() = launchProject?.let(::projectProviders).orEmpty()
    val availableAgents get() = listOf("claude", "codex", "pi").filter { agent -> availableProviders.any { it.agent == agent } }
    /** 服务端 Agent 管理中已安装（含安装中 / 更新中）的 Agent；null 表示未知，按全部已安装处理。 */
    val installedAgents get() = agentEnvironment?.let { environment ->
        listOf("claude", "codex", "pi").filter(environment::installed)
    }
    fun agentInstalled(agent: String) = installedAgents?.contains(agent) != false
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
            return providers.find { it.agent == session.provider && it.id == session.providerId }
                ?.models?.find { it.id == session.model.orEmpty() }
        }
    val selectedModelLabel get() = selectedModelOption?.title ?: selected?.modelLabel.orEmpty()
    val selectedEffortLabel get() = selectedModelOption?.effortLabel?.takeIf(String::isNotBlank) ?: "跟随服务端"
    val canCreate get() = launchProject != null && launchProvider != null && launchModel != null && !initialLoading && !working && !authenticating
}

class AiViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as TerminalBuddyApplication).aiRepository
    private val store = repository.store
    private val taskNotifications = (application as TerminalBuddyApplication).taskNotifications
    private val mutable = MutableStateFlow(
        AiUiState(
            store.server, store.username, store.loggedIn,
            projectPath = repository.selectedProject,
            providerId = repository.selectedProvider,
            modelId = repository.selectedModel,
            accounts = repository.accounts.accounts, activeAccountId = repository.accounts.activeId,
            sendImmediate = repository.sendImmediate,
        )
    )
    val state = mutable.asStateFlow()

    private var notificationTarget: AiNotificationTarget? = null
    private var notificationSwitchAttempted: String? = null
    private var visible = false
    private var generation = 0
    private var authJob: Job? = null
    private var refreshJob: Job? = null
    private var cliHistoryJob: Job? = null
    private val serverHistoryJobs = mutableMapOf<AiServerHistoryKey, Job>()
    private var streamJob: Job? = null
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
    private data class OutgoingMessage(
        val sessionId: String, val message: AiMessage, val draft: String, val previousUserMessageIds: Set<String>,
    )
    /** 本地先展示的用户消息，收到服务端确认前不被实时快照覆盖。 */
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
            }
        }
    }

    fun openNotification(target: AiNotificationTarget) {
        notificationTarget = target
        notificationSwitchAttempted = null
        resumeNotificationNavigation()
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
        } else if (pending == null) startRealtime(reconnecting = true)
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
        visible = active
        if (active && mutable.value.authenticated && !store.loggedIn) {
            resetConnection()
            mutable.value = connectionState().copy(error = "AI 服务登录已过期，请重新登录")
        }
        if (active && store.loggedIn && !mutable.value.authenticating) {
            if (mutable.value.selected == null) refresh()
            else if (pending == null) startRealtime(reconnecting = true)
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

    fun login(server: String, username: String, password: String) = authenticate {
        require(username.isNotBlank()) { "请输入 AI 服务账号" }
        require(password.isNotEmpty()) { "请输入 AI 服务密码" }
        repository.login(server, username.trim(), password)
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
        } else if (pending == null) startRealtime(reconnecting = true)
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

    private fun connectionState() = AiUiState(
        store.server, store.username, store.loggedIn,
        projectPath = repository.selectedProject,
        providerId = repository.selectedProvider,
        modelId = repository.selectedModel,
        accounts = repository.accounts.accounts, activeAccountId = repository.accounts.activeId,
        connectionRevision = mutable.value.connectionRevision + 1,
        sendImmediate = repository.sendImmediate,
    )

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
                        var environment: AiAgentEnvironment? = null
                        val (sessions, projects, catalog) = coroutineScope {
                            val sessions = async { repository.sessions() }
                            val projects = async { repository.projects() }
                            val catalog = async { repository.catalog() }
                            // Agent 安装检测较慢且旧服务端可能没有该接口，失败只回退为全部可用，不阻断首页同步。
                            val detected = async { runCatching { repository.agentEnvironment() } }
                            environment = detected.await().getOrNull()
                            Triple(sessions.await(), projects.await(), catalog.await())
                        }
                        if (epoch != generation) return@launch
                        val unviewed = recordSessions(sessions)
                        mutable.update {
                            reconcile(
                                it.copy(
                                    sessions = sessions, projects = projects, providers = catalog.providers,
                                    agentEnvironment = environment,
                                    loading = false, homeLoaded = true, reconnecting = false, error = null,
                                    unviewedIds = unviewed,
                                )
                            )
                        }
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

    /** 保持服务端仍存在的选择；失效时回落到默认供应商和首个模型，但不静默切到其他项目。 */
    private fun reconcile(ui: AiUiState): AiUiState {
        val project = ui.launchProject ?: ui.projects.firstOrNull()
        val projectUi = ui.copy(projectPath = project?.path.orEmpty())
        // 未安装的 Agent 不参与默认选择，避免自动选中快速开始里已隐藏的助手。
        val choices = projectUi.availableProviders.filter { projectUi.agentInstalled(it.agent) }
        val provider = choices.find { it.id == ui.providerId }
            ?: choices.firstOrNull { it.isDefault && it.models.isNotEmpty() }
            ?: choices.firstOrNull { it.models.isNotEmpty() }
            ?: choices.firstOrNull()
        val model = provider?.models?.find { it.id == ui.modelId } ?: provider?.models?.firstOrNull()
        return projectUi.copy(providerId = provider?.id.orEmpty(), modelId = model?.id.orEmpty())
    }

    private fun saveSelection() {
        val ui = mutable.value
        repository.saveSelection(ui.projectPath, ui.providerId, ui.modelId)
    }

    fun selectProject(path: String) {
        mutable.update { reconcile(it.copy(projectPath = path)) }
        saveSelection()
        reloadHistoryIfExpanded()
    }

    fun selectAgent(agent: String) {
        mutable.update { ui ->
            if (ui.launchProvider?.agent == agent) return@update ui
            val choices = ui.availableProviders.filter { it.agent == agent }
            val provider = choices.firstOrNull { it.isDefault && it.models.isNotEmpty() }
                ?: choices.firstOrNull { it.models.isNotEmpty() }
                ?: choices.firstOrNull()
                ?: return@update ui
            reconcile(ui.copy(providerId = provider.id, modelId = ""))
        }
        saveSelection()
        reloadHistoryIfExpanded()
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
        if (!store.loggedIn || ui.authenticating || agent !in listOf("claude", "codex", "pi") ||
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

    /** 从浏览中的项目恢复 Claude / Pi，会话使用该项目的模型，保持首页启动配置不变。 */
    fun resumeServerHistory(agent: String, project: AiProject, item: AiHistorySession) {
        val ui = mutable.value
        if (ui.working || ui.authenticating || !ui.authenticated || agent !in listOf("claude", "pi")) return
        val models = ui.projectModels(project, agent)
        val target = models.find { it.key == ui.launchModelKey }
            ?: models.find { it.model.id == item.model }
            ?: models.firstOrNull { it.provider.isDefault } ?: models.firstOrNull() ?: return
        val epoch = generation
        refreshJob?.cancel(); selectJob?.cancel(); cancelSend(); stopRealtime()
        mutable.update { it.copy(working = true, error = null) }
        actionJob = viewModelScope.launch {
            try {
                val session = repository.create(project, target.provider, target.model.id, item.sessionId)
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

    /** 展开 / 收起历史会话区；展开时按当前项目 + Agent 拉取，切换选择后自动重载。 */
    fun toggleHistory() {
        val ui = mutable.value
        if (ui.historyExpanded) {
            cliHistoryJob?.cancel()
            mutable.update { it.copy(historyExpanded = false, historySessions = emptyList(), historyLoading = false) }
        } else {
            mutable.update { it.copy(historyExpanded = true) }
            loadHistory()
        }
    }

    private fun reloadHistoryIfExpanded() {
        if (mutable.value.historyExpanded) loadHistory()
    }

    /** 增量索引失败不阻断列表（可能只是后台补齐未完成），列表失败才提示。 */
    private fun loadHistory() {
        val ui = mutable.value
        val agent = ui.launchProvider?.agent ?: return
        val project = ui.launchProject ?: return
        cliHistoryJob?.cancel()
        cliHistoryJob = viewModelScope.launch {
            mutable.update { it.copy(historyLoading = true, historyAgent = agent, historyProjectPath = project.path) }
            try {
                runCatching { repository.rescanHistory(agent) }
                val sessions = repository.history(agent, project.path)
                mutable.update { state ->
                    // 请求期间用户可能已切换项目或 Agent，过期结果直接丢弃。
                    if (!state.historyExpanded || state.historyAgent != agent || state.historyProjectPath != project.path) state
                    else state.copy(historySessions = sessions, historyLoading = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutable.update { state ->
                    if (!state.historyExpanded || state.historyAgent != agent || state.historyProjectPath != project.path) state
                    else state.copy(historyLoading = false, error = e.userMessage())
                }
            }
        }
    }

    /** 恢复 CLI 历史会话为可继续对话的原生会话：服务端绑定历史线程并预填最近消息。 */
    fun resumeHistory(item: AiHistorySession) {
        val ui = mutable.value
        val project = ui.launchProject ?: return
        val provider = ui.launchProvider ?: return
        if (ui.working || ui.authenticating) return
        val model = ui.launchModel?.id.orEmpty()
        cliHistoryJob?.cancel()
        refreshJob?.cancel(); selectJob?.cancel(); cancelSend(); stopRealtime()
        mutable.update { it.copy(working = true, error = null) }
        viewModelScope.launch {
            try {
                val session = repository.create(project, provider, model, item.sessionId)
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
        refreshJob?.cancel(); selectJob?.cancel(); cancelSend(); stopRealtime()
        pending = null
        val epoch = ++generation
        val cacheScope = repository.sessionCache.scope()
        val cached = cacheScope?.let { repository.sessionCache.peek(it, id) }
        val initial = cached ?: mutable.value.sessions.find { it.id == id }
            ?: AiSession(id, "正在加载对话", "", "")
        repository.lastSession = id
        mutable.update {
            it.copy(
                selected = initial, loading = false, loadingSession = cached == null,
                draft = drafts[id].orEmpty(), sending = false, working = false, error = null,
            )
        }
        selectJob = viewModelScope.launch {
            if (cached == null && cacheScope != null) launch restoreCache@{
                val stored = repository.sessionCache.read(cacheScope, id) ?: return@restoreCache
                if (epoch == generation) mutable.update { current ->
                    // 网络若先返回，则不再用磁盘快照覆盖；读缓存不推进已读版本。
                    if (current.selected === initial) current.copy(selected = stored, loadingSession = false) else current
                }
            }
            try {
                val session = repository.session(id)
                if (epoch != generation) return@launch
                receive(session)
                startRealtime()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    if (e is ApiException && e.code == 404) {
                        closeSession()
                        mutable.update { it.copy(error = "该任务已删除或当前账号无法访问") }
                    } else {
                        mutable.update { it.copy(loadingSession = false) }
                        failure(e)
                    }
                }
            }
        }
    }

    fun closeSession() {
        generation++
        selectJob?.cancel(); cancelSend(); stopRealtime(); repository.lastSession = ""
        pending = null
        mutable.update {
            it.copy(selected = null, draft = "", loadingSession = false, sending = false, working = false, error = null)
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
                draft = "", sending = false, working = false, connected = false,
                reconnecting = false, error = null,
            )
        }
    }

    fun draft(text: String) {
        mutable.value.selected?.id?.let { drafts[it] = text }
        mutable.update { it.copy(draft = text) }
    }

    /** 退出或切换会话时，尚未确认的消息回到草稿，仍可复用原请求标识重试。 */
    private fun cancelSend() {
        sendJob?.cancel()
        sendJob = null
        clearOutgoing(restoreDraft = true)
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
                selected = selected.copy(messages = selected.messages.filterNot { it.id == message.message.id }),
                draft = restored,
            )
        }
    }

    fun send() {
        val ui = mutable.value
        val session = ui.selected ?: return
        val text = ui.draft.trim()
        if (text.isEmpty() || !session.canSend || ui.sending || ui.loadingSession || sendJob?.isActive == true) return
        val launch = if (pending?.id == session.id) {
            val project = ui.launchProject ?: return
            val provider = ui.launchProvider ?: return
            val model = ui.launchModel ?: return
            Triple(project, provider, model)
        } else null
        val request = requests[session.id]?.takeIf { it.first == text }
            ?: (text to UUID.randomUUID().toString()).also { requests[session.id] = it }
        val message = OutgoingMessage(
            session.id, AiMessage("local-${request.second}", "user", text, System.currentTimeMillis()), ui.draft,
            session.messages.filter { it.role == "user" }.mapTo(mutableSetOf()) { it.id },
        )
        outgoing = message
        drafts[session.id] = ""
        // 点击即显示并清空输入，不等待创建会话或发送接口返回。
        mutable.update {
            it.copy(selected = session.copy(messages = session.messages + message.message), draft = "", sending = true, error = null)
        }
        val notificationAccountId = repository.accounts.activeId
        notificationAccountId?.let { taskNotifications.expectTask(it, session) }
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
                        outgoing = outgoing?.copy(sessionId = created.id)
                        mutable.update { current -> current.copy(selected = current.selected?.copy(id = created.id)) }
                        drafts[created.id] = drafts.remove(session.id).orEmpty()
                        requests.remove(session.id)
                        requests[created.id] = request
                    }
                }
                if (epoch != generation || mutable.value.selected?.id != target.id) return@launch
                // 真实会话 ID 就绪后启动实时订阅和轮询，首次发送也能持续接收回复。
                repository.accounts.activeId?.let { taskNotifications.expectTask(it, target) }
                startRealtime()
                // 回复进行中：排队模式由服务端按序自动续发；立即发送则中断当前回复优先处理。
                val result = repository.send(target.id, text, request.second, ui.sendImmediate)
                if (epoch != generation || mutable.value.selected?.id != target.id) return@launch
                requests.remove(target.id)
                // 幂等重试可能返回历史消息；成功响应本身即可确认，不能只按新增消息判断。
                clearOutgoing(restoreDraft = false)
                receive(result)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    clearOutgoing(restoreDraft = true)
                    failure(e)
                }
            } finally {
                if (epoch == generation) mutable.update { it.copy(sending = false) }
            }
        }
    }

    /** 立即发送排队消息：服务端把该消息移到队首并中断当前回复，停止后立即送出。 */
    fun sendQueuedNow(requestId: String) {
        action { repository.flush(it.id, requestId) }
    }

    /** 发送方式是全局设置，立即生效并持久化，不影响服务端已排队的消息。 */
    fun setSendImmediate(value: Boolean) {
        repository.sendImmediate = value
        mutable.update { it.copy(sendImmediate = value) }
    }

    fun stop() = action { repository.stop(it.id) }

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
                if (epoch == generation) receive(repository.session(session.id))
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
                    mutable.update { it.copy(sessions = it.sessions.filterNot { item -> item.id == session.id }, working = false) }
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
                    mutable.update { it.copy(sessions = it.sessions.filterNot { item -> item.id == session.id }) }
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
                if (epoch == generation) receive(repository.session(session.id))
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
        repository.accounts.activeId?.let { taskNotifications.observe(it, listOf(session)) }
        // 只缓存服务端原始快照，本地尚未确认的消息仍由 outgoing 单独管理。
        repository.sessionCache.scope()?.let { repository.sessionCache.save(it, session) }
        if (pending?.id == session.id) pending = null
        val message = outgoing?.takeIf { it.sessionId == session.id }
        // 只匹配本次发送后新增的用户消息，历史中相同的正文不能提前确认本次发送。
        val accepted = message != null && session.messages.any {
            it.role == "user" && it.id !in message.previousUserMessageIds && it.text == message.message.text
        }
        if (accepted) {
            outgoing = null
            requests.remove(session.id)
        }
        val displayed = if (message != null && !accepted) session.copy(messages = session.messages + message.message) else session
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
        mutable.update { it.copy(unviewedIds = it.unviewedIds - id) }
    }

    private fun startRealtime(reconnecting: Boolean = false) {
        val id = mutable.value.selected?.id ?: return
        if (!visible || !store.loggedIn || mutable.value.authenticating || streamJob?.isActive == true) return
        val epoch = generation
        if (reconnecting) mutable.update { it.copy(reconnecting = true) }
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
                    if (e is ApiException && e.code == 401) {
                        failure(e)
                        return@launch
                    }
                }
                if (epoch != generation) break
                mutable.update {
                    // REST 补偿成功后保持在线提示，避免代理拦截 WS 时每次重试都闪现。
                    it.copy(connected = false, reconnecting = it.reconnecting || it.connected)
                }
                delay(reconnectDelay(retries))
                retries = (retries + 1).coerceAtMost(4)
            }
        }
        // WS 被代理拦截时仍能同步：连上时 15 秒补一次，断开时 3 秒一次。
        pollingJob = viewModelScope.launch {
            var refreshImmediately = reconnecting
            while (isActive && epoch == generation) {
                if (!refreshImmediately) delay(if (mutable.value.connected) 15_000 else 3_000)
                refreshImmediately = false
                try {
                    val snapshot = repository.session(id)
                    if (epoch == generation) {
                        receive(snapshot)
                        mutable.update { it.copy(reconnecting = false, loadingSession = false, error = null) }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    if (epoch == generation) failure(e)
                }
            }
        }
    }

    private fun stopRealtime() {
        streamJob?.cancel(); streamJob = null
        pollingJob?.cancel(); pollingJob = null
        mutable.update { it.copy(connected = false, reconnecting = false) }
    }

    /** 首次半秒后重试，逐步退避至八秒；网络恢复事件会直接跳过等待。 */
    private fun reconnectDelay(attempt: Int): Long = 500L shl attempt.coerceIn(0, 4)
}
