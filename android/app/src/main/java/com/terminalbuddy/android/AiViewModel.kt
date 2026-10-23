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
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID

/** 同名模型保留供应商身份，避免选择模型后切换到另一套启动配置。 */
data class AiLaunchModel(val provider: AiProvider, val model: AiModel) {
    val key get() = "${provider.id.length}:${provider.id}${model.id}"
}

/**
 * AI 页面状态。登录、项目/Agent/模型选择和当前会话各自独立，
 * 首页刷新不会覆盖正在进行的对话；关闭 App 后重新打开回到选择首页。
 */
data class AiUiState(
    val server: String = "", val username: String = "admin", val authenticated: Boolean = false,
    val authenticating: Boolean = false, val loading: Boolean = false, val loadingSession: Boolean = false,
    val sessions: List<AiSession> = emptyList(), val projects: List<AiProject> = emptyList(),
    val providers: List<AiProvider> = emptyList(), val projectPath: String = "", val providerId: String = "", val modelId: String = "",
    val selected: AiSession? = null, val draft: String = "", val sending: Boolean = false,
    val connected: Boolean = false, val working: Boolean = false, val error: String? = null,
    val reconnecting: Boolean = false,
    val deletingAll: Boolean = false,
    val connectionRevision: Long = 0,
    val homeLoaded: Boolean = false,
    val unviewedIds: Set<String> = emptySet(),
) {
    /** 刷新动画独立于首次加载限制，已有数据时页面保持可操作。 */
    val initialLoading get() = loading && !homeLoaded
    val launchProject get() = projects.find { it.path == projectPath }
    /** 只列出当前项目启用的 Agent 对应供应商。 */
    val availableProviders get() = providers.filter { provider ->
        launchProject?.let { if (provider.agent == "codex") it.enabledAgents.codex else it.enabledAgents.claude } == true
    }
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
            return providers.find { it.agent == session.provider && it.id == session.providerId }
                ?.models?.find { it.id == session.model.orEmpty() }
        }
    val selectedModelLabel get() = selectedModelOption?.title ?: selected?.modelLabel.orEmpty()
    val selectedEffortLabel get() = selectedModelOption?.effortLabel?.takeIf(String::isNotBlank) ?: "跟随服务端"
    val canCreate get() = launchProject != null && launchProvider != null && launchModel != null && !initialLoading && !working
}

class AiViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as TerminalBuddyApplication).aiRepository
    private val store = repository.store
    private val mutable = MutableStateFlow(
        AiUiState(
            store.server, store.username, store.loggedIn,
            projectPath = repository.selectedProject,
            providerId = repository.selectedProvider,
            modelId = repository.selectedModel,
        )
    )
    val state = mutable.asStateFlow()

    private var visible = false
    private var generation = 0
    private var authJob: Job? = null
    private var refreshJob: Job? = null
    private var streamJob: Job? = null
    private var pollingJob: Job? = null
    private var selectJob: Job? = null
    private var sendJob: Job? = null
    private var actionJob: Job? = null
    /** 尚未落盘的本地新对话；为空表示当前会话已经存在于服务端。 */
    private var pending: AiSession? = null
    /** 最后实际查看到的版本；首页发现新结果时保留这条已读基线。 */
    private var viewedRevisions = mutableMapOf<String, Long>()
    private var viewedBaselineReady = false
    private val drafts = mutableMapOf<String, String>()
    /** 会话 ID → 待发送文本 + requestId；结果未知时重试复用同一个 requestId。 */
    private val requests = mutableMapOf<String, Pair<String, String>>()

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
            if (!visible || !store.loggedIn) return
            cancelConnectionJobs()
            mutable.update { it.copy(reconnecting = true, error = null) }
        }
    }
    private val networkCallbackRegistered = runCatching {
        // 与页面状态统一在主线程处理，避免网络切换和选择会话并发更新。
        connectivity.registerDefaultNetworkCallback(networkCallback, Handler(Looper.getMainLooper()))
    }.isSuccess

    private fun cancelConnectionJobs() {
        stopRealtime()
        refreshJob?.cancel(); refreshJob = null
        selectJob?.cancel(); selectJob = null
        mutable.update { it.copy(loading = false, loadingSession = false) }
    }

    /** 网络恢复后取消旧连接和退避等待，立即建立实时连接并补拉完整会话。 */
    private fun reconnectNow() {
        if (!visible || !store.loggedIn) return
        cancelConnectionJobs()
        mutable.update { it.copy(reconnecting = true, error = null) }
        if (mutable.value.selected == null) {
            if (mutable.value.deletingAll) startHomePolling() else refresh()
        } else if (pending == null) startRealtime(reconnecting = true)
    }

    override fun onCleared() {
        if (networkCallbackRegistered) runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        super.onCleared()
    }

    /** 只有 AI 标签页可见时才保持连接，后台不占配额。 */
    fun setVisible(active: Boolean) {
        visible = active
        if (active && store.loggedIn) {
            if (mutable.value.selected == null) refresh()
            else if (pending == null) startRealtime(reconnecting = true)
        } else {
            stopRealtime()
            refreshJob?.cancel(); refreshJob = null
            mutable.update { it.copy(loading = false) }
        }
    }

    fun login(server: String, username: String, password: String) {
        if (authJob?.isActive == true) return
        authJob = viewModelScope.launch {
            mutable.update { it.copy(authenticating = true, error = null) }
            try {
                require(username.isNotBlank()) { "请输入 AI 服务账号" }
                require(password.isNotEmpty()) { "请输入 AI 服务密码" }
                withContext(Dispatchers.IO) { repository.login(server, username.trim(), password) }
                generation++
                stopRealtime(); refreshJob?.cancel(); refreshJob = null; selectJob?.cancel(); sendJob?.cancel(); actionJob?.cancel()
                drafts.clear(); requests.clear(); pending = null
                viewedRevisions.clear(); viewedBaselineReady = false
                mutable.value = AiUiState(
                    store.server, store.username, true,
                    projectPath = repository.selectedProject,
                    providerId = repository.selectedProvider,
                    modelId = repository.selectedModel,
                    connectionRevision = System.currentTimeMillis(),
                )
                refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutable.update { it.copy(authenticating = false, error = e.userMessage()) }
            }
        }
    }

    fun logout() {
        generation++
        stopRealtime(); authJob?.cancel(); refreshJob?.cancel(); selectJob?.cancel(); sendJob?.cancel(); actionJob?.cancel()
        store.clear(); repository.lastSession = ""; drafts.clear(); requests.clear(); pending = null
        viewedRevisions.clear(); viewedBaselineReady = false
        mutable.value = AiUiState(store.server, store.username)
    }

    private fun failure(error: Throwable) {
        if (error is ApiException && error.code == 401) {
            logout()
            mutable.update { it.copy(error = "AI 服务登录已过期，请重新登录") }
        } else if (error.isConnectionFailure()) {
            // 网络抖动只更新标题重连状态，不再插入错误条挤动页面。
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
        if (!store.loggedIn || refreshJob?.isActive == true || mutable.value.deletingAll) return
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
                        mutable.update {
                            reconcile(
                                it.copy(
                                    sessions = sessions, projects = projects, providers = catalog.providers,
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
        if (!visible || !store.loggedIn || mutable.value.selected != null || pollingJob?.isActive == true) return
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
        repository.saveSelection(ui.projectPath, ui.providerId, ui.modelId)
    }

    fun selectProject(path: String) {
        mutable.update { reconcile(it.copy(projectPath = path)) }
        saveSelection()
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
    }

    fun selectModel(key: String) {
        mutable.update { ui ->
            val target = ui.availableModels.find { it.key == key } ?: return@update ui
            reconcile(ui.copy(providerId = target.provider.id, modelId = target.model.id))
        }
        saveSelection()
    }

    /** 打开二级会话页：先用列表里的摘要占位，再拉完整消息并开始实时同步。 */
    fun open(id: String) {
        refreshJob?.cancel(); selectJob?.cancel(); sendJob?.cancel(); sendJob = null; stopRealtime()
        pending = null
        val epoch = ++generation
        val summary = mutable.value.sessions.find { it.id == id }
        repository.lastSession = id
        mutable.update {
            it.copy(
                selected = summary, loading = false, loadingSession = true,
                draft = drafts[id].orEmpty(), sending = false, working = false, error = null,
            )
        }
        selectJob = viewModelScope.launch {
            try {
                val session = repository.session(id)
                if (epoch != generation) return@launch
                receive(session)
                startRealtime()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) {
                    mutable.update { it.copy(loadingSession = false) }
                    failure(e)
                }
            }
        }
    }

    fun closeSession() {
        generation++
        selectJob?.cancel(); sendJob?.cancel(); sendJob = null; stopRealtime(); repository.lastSession = ""
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
        refreshJob?.cancel(); selectJob?.cancel(); sendJob?.cancel(); sendJob = null; stopRealtime()
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

    fun send() {
        val session = mutable.value.selected ?: return
        val text = mutable.value.draft.trim()
        if (text.isEmpty() || session.running || sendJob?.isActive == true) return
        val launch = if (pending?.id == session.id) {
            val project = mutable.value.launchProject ?: return
            val provider = mutable.value.launchProvider ?: return
            val model = mutable.value.launchModel ?: return
            Triple(project, provider, model)
        } else null
        val request = requests[session.id]?.takeIf { it.first == text }
            ?: (text to UUID.randomUUID().toString()).also { requests[session.id] = it }
        val epoch = generation
        sendJob = viewModelScope.launch {
            mutable.update { it.copy(sending = true, error = null) }
            try {
                val target = if (launch == null) session else repository.create(
                    launch.first, launch.second, launch.third.id,
                ).also { created ->
                    if (pending?.id == session.id) pending = null
                    if (epoch == generation && mutable.value.selected?.id == session.id) {
                        if (visible) markViewed(created.id, created.revision)
                        mutable.update { current -> current.copy(selected = session.copy(id = created.id)) }
                        drafts.remove(session.id)
                        drafts[created.id] = text
                        requests.remove(session.id)
                        requests[created.id] = request
                    }
                }
                if (epoch != generation || mutable.value.selected?.id != target.id) return@launch
                // 真实会话 ID 就绪后启动实时订阅和轮询，首次发送也能持续接收回复。
                startRealtime()
                val result = repository.send(target.id, text, request.second)
                requests.remove(target.id)
                // 发送成功才清空；失败保留文本和 requestId，可安全重试。
                if (mutable.value.draft.trim() == text) {
                    drafts[target.id] = ""
                    mutable.update { it.copy(draft = "") }
                }
                receive(result)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (epoch == generation) failure(e)
            } finally {
                if (epoch == generation) mutable.update { it.copy(sending = false) }
            }
        }
    }

    fun stop() = action { repository.stop(it.id) }

    fun answer(approval: AiApproval, decision: String, answers: JsonObject = JsonObject(emptyMap())) = action {
        repository.answer(it.id, approval, decision, answers)
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

    /** 中断/确认这类动作完成后主动拉一次完整会话，走与 WebSocket 相同的合并逻辑。 */
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
        if (pending?.id == session.id) pending = null
        // 只有当前可见会话的有效正文快照才算查看；后台或迟到的响应不能清除提示。
        if (visible) markViewed(session.id, session.revision)
        mutable.update { current ->
            val selected = current.selected
            if (selected == null || selected.id != session.id || session.revision < selected.revision) current
            else current.copy(
                selected = session, loadingSession = false,
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
        ensureViewedBaseline(sessions)
        val visibleIds = sessions.mapTo(mutableSetOf()) { it.id }
        viewedRevisions.keys.retainAll(visibleIds)
        val unviewed = sessions.filter { session ->
            // 服务端新建的空会话版本为 1，没有执行结果，不应提示已完成。
            val viewed = viewedRevisions[session.id] ?: 1L
            session.status != "running" && session.revision > viewed
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
        ensureViewedBaseline()
        viewedRevisions.remove(id)
        repository.saveViewedRevisions(viewedRevisions)
        mutable.update { it.copy(unviewedIds = it.unviewedIds - id) }
    }

    private fun startRealtime(reconnecting: Boolean = false) {
        val id = mutable.value.selected?.id ?: return
        if (!visible || !store.loggedIn || streamJob?.isActive == true) return
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
