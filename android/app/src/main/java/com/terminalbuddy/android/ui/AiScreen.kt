package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiSession

private enum class AiPage { Home, Profile, Accounts, Connection, ServiceInfo, AppUpdate }

/** 一级入口共用底部导航，账号、服务信息和对话保留独立的二级页面。 */
@Composable
fun AiScreen(
    ui: AiUiState, vm: AiViewModel, simplified: Boolean = false,
    onSimplifiedChange: (Boolean) -> Unit = {},
    openDecision: (String) -> Unit = {},
) {
    val terminalVm: ServerTerminalViewModel = viewModel()
    val terminalUi by terminalVm.state.collectAsStateWithLifecycle()
    val agentVm: TerminalAgentViewModel = viewModel()
    val agentUi by agentVm.state.collectAsStateWithLifecycle()
    LaunchedEffect(ui.authenticated, ui.activeAccountId, ui.connectionRevision) {
        terminalVm.bindAccount()
        agentVm.bindAccount()
    }
    var page by rememberSaveable { mutableStateOf(AiPage.Home) }
    var tab by rememberSaveable { mutableStateOf(AiHomeTab.QuickStart) }
    var recentSessionsRequest by rememberSaveable { mutableIntStateOf(0) }
    var unreadSessionRequest by remember(ui.activeAccountId) { mutableIntStateOf(0) }
    val tabState = rememberSaveableStateHolder()
    var loginAccountId by rememberSaveable { mutableStateOf<String?>(null) }
    var addingAccount by rememberSaveable { mutableStateOf(false) }
    var connectionReturnPage by rememberSaveable { mutableStateOf(AiPage.Home) }
    var handledConnectionRevision by rememberSaveable { mutableLongStateOf(ui.connectionRevision) }
    var deleting by remember(ui.activeAccountId) { mutableStateOf<AiSession?>(null) }
    var confirmDeleteAll by remember(ui.activeAccountId) { mutableStateOf(false) }
    var notificationSettings by rememberSaveable { mutableStateOf(false) }
    var sendModeSheet by rememberSaveable { mutableStateOf(false) }
    /** 终端 Agent 会话宿主的选中态：优先于普通终端分支；返回时由宿主按页签清理。 */
    var selectedAgentTerminalId by rememberSaveable { mutableStateOf<String?>(null) }
    /** 新会话刚创建的终端：Agent 绑定尚未被服务端发现，期间持续刷新列表而不是直接退出宿主。 */
    var pendingAgentTerminalId by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingAgentStartedAt by rememberSaveable { mutableLongStateOf(0L) }
    val deletableCount = ui.sessions.count { !it.running }
    val openConnection: (String?, Boolean, Boolean) -> Unit = { id, adding, fromAccounts ->
        loginAccountId = id
        addingAccount = adding
        connectionReturnPage = if (fromAccounts) AiPage.Accounts else if (page == AiPage.ServiceInfo) AiPage.ServiceInfo else AiPage.Home
        page = AiPage.Connection
        vm.clearError()
    }
    val openAccounts: () -> Unit = { page = AiPage.Accounts; vm.clearError() }
    val back: () -> Unit = {
        vm.cancelAuthentication()
        page = if (page == AiPage.Connection) connectionReturnPage else AiPage.Home
    }
    /** 退出 Agent 会话宿主：清 Agent 选中态并刷新列表；终端页签曾打开时一并退出终端查看。 */
    val leaveAgentSession: () -> Unit = {
        if (terminalUi.selected != null) terminalVm.leaveTerminal()
        agentVm.leaveSession()
        agentVm.refresh()
        selectedAgentTerminalId = null
        pendingAgentTerminalId = null
    }
    /**
     * 简版「开始对话」：在服务端开真实终端并按 terminalId 等待 Agent 会话出现。
     * 先进入 Agent 宿主显示启动态，发现后自动切换到接力页；超时则退回该终端画面。
     */
    val startAgent: (String, String, String, String, String) -> Unit = { agent, providerId, modelId, projectPath, projectName ->
        terminalVm.launchAgent(agent, providerId, modelId, projectPath, projectName) { terminal ->
            pendingAgentTerminalId = terminal.id
            pendingAgentStartedAt = System.currentTimeMillis()
            selectedAgentTerminalId = terminal.id
        }
    }
    // 进程或页面重建后按选中的 terminalId 重新打开会话；列表刷新后目标消失则退出宿主。
    // 新创建的终端要等 Agent 启动、转录生成与发现链完成，期间按 1 秒节奏刷新，超时退回终端画面。
    LaunchedEffect(selectedAgentTerminalId, pendingAgentTerminalId, agentUi.listLoaded, agentUi.listLoading, agentUi.sessions, agentUi.connection) {
        val id = selectedAgentTerminalId ?: return@LaunchedEffect
        if (agentUi.selected?.terminalId == id) {
            pendingAgentTerminalId = null
            return@LaunchedEffect
        }
        val session = agentUi.sessions.find { it.terminalId == id }
        when {
            session != null -> {
                pendingAgentTerminalId = null
                agentVm.openSession(session)
            }
            agentUi.listLoading -> Unit
            pendingAgentTerminalId == id -> {
                if (System.currentTimeMillis() - pendingAgentStartedAt >= 45_000L) {
                    pendingAgentTerminalId = null
                    selectedAgentTerminalId = null
                    terminalVm.reportAgentLaunchTimeout()
                    // 终端已经建好，只是 Agent 尚未被发现；直接打开终端让用户看到启动过程与报错。
                    terminalVm.state.value.terminals.find { it.id == id }?.let(terminalVm::openView)
                } else {
                    delay(1_000)
                    agentVm.refresh()
                }
            }
            // 拉取失败不自动重试（避免 listLoading 变化反复重启本 effect 形成忙循环），交给错误卡手动重试。
            agentUi.listLoaded -> selectedAgentTerminalId = null
            agentUi.listError == null -> agentVm.refresh()
        }
    }
    // Agent 宿主选中态是 UI 级状态，bindAccount 清不到：真正切换账号时同步清空。
    // 首次组合与进程恢复（账号相同）不触发；lastAccountId 跨进程保留避免误清。
    var lastAgentAccountId by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(ui.activeAccountId) {
        val previous = lastAgentAccountId
        lastAgentAccountId = ui.activeAccountId
        if (previous != null && ui.activeAccountId != null && previous != ui.activeAccountId &&
            selectedAgentTerminalId != null
        ) {
            if (terminalUi.selected != null) terminalVm.leaveTerminal()
            agentVm.leaveSession()
            selectedAgentTerminalId = null
            pendingAgentTerminalId = null
        }
    }
    // 切换界面模式时回到首页，避免旧页面状态落在一个已经不存在的 Tab 上。
    val changeMode: (Boolean) -> Unit = { simple ->
        page = AiPage.Home
        tab = AiHomeTab.QuickStart
        if (selectedAgentTerminalId != null) {
            if (terminalUi.selected != null) terminalVm.leaveTerminal()
            agentVm.leaveSession()
            selectedAgentTerminalId = null
            pendingAgentTerminalId = null
        }
        onSimplifiedChange(simple)
    }
    BackHandler(page != AiPage.Home || ui.authenticating || (!simplified && tab != AiHomeTab.QuickStart)) {
        if (page != AiPage.Home || ui.authenticating) back() else tab = AiHomeTab.QuickStart
    }
    LaunchedEffect(ui.connectionRevision) {
        if (handledConnectionRevision != ui.connectionRevision) {
            handledConnectionRevision = ui.connectionRevision
            if (ui.authenticated) page = AiPage.Home
        }
    }
    LaunchedEffect(ui.notificationLoginAccountId) {
        ui.notificationLoginAccountId?.let { openConnection(it, false, true) }
    }
    if (page == AiPage.Connection || (!ui.authenticated && ui.accounts.isEmpty() && page != AiPage.Accounts)) {
        val account = ui.accounts.find { it.id == loginAccountId }
        AiConnection(ui, vm::login, if (page == AiPage.Connection) back else null,
            initialServer = account?.server ?: ui.server,
            initialUsername = account?.username ?: if (addingAccount) "" else ui.username,
            title = if (addingAccount) "添加账号" else if (account?.loggedIn == false) "重新登录" else "连接服务",
            adding = addingAccount)
        return
    }
    if (page == AiPage.Accounts || !ui.authenticated) {
        AiAccountsScreen(ui, if (ui.authenticated) back else null,
            add = { openConnection(null, true, true) },
            select = { account ->
                if (account.loggedIn) vm.switchAccount(account.id) else openConnection(account.id, false, true)
            }, remove = vm::removeAccount, clearError = vm::clearError)
        return
    }
    if (ui.history.selected != null) {
        AiCodexHistoryScreen(ui, vm)
        return
    }
    if (page == AiPage.AppUpdate) {
        AppUpdateScreen(back)
        return
    }
    if (page == AiPage.ServiceInfo) {
        AiServiceInfoScreen(ui, back) { openConnection(ui.activeAccountId, false, false) }
        return
    }
    if (simplified && page == AiPage.Profile) {
        Column(Modifier.fillMaxSize()) {
            AiSubpageHeader("我的", back)
            ui.error?.let { AiError(it, vm::clearError) }
            Box(Modifier.fillMaxWidth().weight(1f)) {
                AiProfileScreen(ui,
                    notifications = { notificationSettings = true },
                    sendMode = { sendModeSheet = true }, accounts = openAccounts,
                    serviceInfo = { page = AiPage.ServiceInfo },
                    onlineUpdate = { page = AiPage.AppUpdate }, logout = vm::logout,
                    simplified = true, onSimplifiedChange = changeMode)
            }
        }
    } else if (ui.authenticated && agentVm.isCurrentAccount() && selectedAgentTerminalId != null) {
        // Agent 会话宿主优先于普通终端分支；对话页返回只清 Agent 选中态，终端页签返回先离开终端查看。
        TerminalAgentSessionScreen(
            agentUi = agentUi, agentVm = agentVm,
            terminalUi = terminalUi, terminalVm = terminalVm,
            starting = pendingAgentTerminalId == selectedAgentTerminalId,
            onBack = leaveAgentSession,
            onBackFromTerminal = leaveAgentSession,
            openDecision = openDecision,
        )
    } else if (ui.authenticated && terminalVm.isCurrentAccount() && terminalUi.selected != null) {
        ServerTerminalScreen(terminalUi, terminalVm)
    } else if (simplified) {
        Column(Modifier.fillMaxSize().imePadding()) {
            AiSimpleHome(ui, vm, terminalUi, terminalVm,
                agentUi = agentUi, agentVm = agentVm,
                openAgent = { session ->
                    selectedAgentTerminalId = session.terminalId
                    pendingAgentTerminalId = null
                    agentVm.openSession(session)
                },
                startAgent = startAgent,
                profile = { page = AiPage.Profile }, delete = { deleting = it })
        }
    } else {
        val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
        Column(Modifier.fillMaxSize().imePadding()) {
            if (tab != AiHomeTab.Sessions) {
                PageHeader(tab.title, reconnecting = ui.reconnecting, subtitle = tab.subtitle, connecting = ui.loading)
                ui.error?.let { AiError(it, vm::clearError) }
            }
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
                Box(Modifier.widthIn(max = 680.dp).fillMaxSize()) {
                    tabState.SaveableStateProvider("home:${ui.activeAccountId}:${tab.name}") {
                        when (tab) {
                            AiHomeTab.QuickStart -> AiHomeWorkspace(ui, vm, sessions = {
                                recentSessionsRequest++
                                tab = AiHomeTab.Sessions
                            }, more = terminalVm::showConfigurations)
                            AiHomeTab.Sessions -> AiSessionsScreen(ui, vm,
                                start = { tab = AiHomeTab.QuickStart }, delete = { deleting = it },
                                deleteAll = { confirmDeleteAll = true }, recentRequest = recentSessionsRequest,
                                unreadRequest = unreadSessionRequest,
                                unreadRequestHandled = { request ->
                                    if (unreadSessionRequest == request) unreadSessionRequest = 0
                                },
                                terminalUi = terminalUi, terminalVm = terminalVm,
                                agentUi = agentUi, agentVm = agentVm,
                                openAgent = { session ->
                                    selectedAgentTerminalId = session.terminalId
                                    agentVm.openSession(session)
                                })
                            AiHomeTab.Profile -> AiProfileScreen(ui,
                                notifications = { notificationSettings = true },
                                sendMode = { sendModeSheet = true }, accounts = openAccounts,
                                serviceInfo = { page = AiPage.ServiceInfo },
                                onlineUpdate = { page = AiPage.AppUpdate }, logout = vm::logout,
                                simplified = simplified, onSimplifiedChange = changeMode)
                        }
                    }
                }
            }
            if (!keyboardVisible) AiBottomNavigation(tab, ui.unviewedIds.size,
                select = { tab = it },
                locateUnread = {
                    if (ui.sessions.any { it.id in ui.unviewedIds }) {
                        unreadSessionRequest++
                        tab = AiHomeTab.Sessions
                    }
                })
        }
    }
    if (terminalUi.dialogOpen && terminalVm.isCurrentAccount()) ServerProjectProfilesDialog(terminalUi, terminalVm)
    if (notificationSettings) AiNotificationSettings { notificationSettings = false }
    if (sendModeSheet) AiSendModeSheet(ui.sendSteer, vm::setSendSteer) { sendModeSheet = false }
    deleting?.let { session -> AiDeleteDialog(session, { deleting = null }) { deleting = null; vm.delete(session) } }
    if (confirmDeleteAll) {
        AlertDialog(
            onDismissRequest = { confirmDeleteAll = false }, title = { Text("清理空闲会话") },
            text = { Text("将删除当前账号全部 $deletableCount 段空闲会话及其消息。正在回复或等待确认的会话会保留，项目文件不会被删除。") },
            confirmButton = {
                TextButton(
                    onClick = { confirmDeleteAll = false; vm.deleteAll() },
                    enabled = deletableCount > 0 && !ui.loading && !ui.working,
                ) { Text("确认清理", color = TbColors.Danger) }
            },
            dismissButton = { TextButton({ confirmDeleteAll = false }) { Text("取消") } },
        )
    }
}

internal data class AiChoice(val id: String, val title: String, val subtitle: String = "", val agent: String? = null)

/** 连续发送方式：排队等当前回合任务全部完成后写入同一个 CLI 进程，原生插话则直接交给运行中的进程。 */
@Composable
private fun AiSendModeSheet(sendSteer: Boolean, select: (Boolean) -> Unit, dismiss: () -> Unit) {
    AiSheet("发送方式", dismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AiSendModeOption(
                Icons.Outlined.Schedule, "排队发送", "AI 回复期间发送的消息在服务端排队（App 关闭或被杀也不丢失），等当前回合任务（含后台任务）全部完成后，由服务端写入同一个 CLI 进程继续，不中断任务，也不需要恢复历史。排队消息可删除，不想等待可点最右侧的发送箭头直接插话。",
                selected = !sendSteer,
            ) { select(false); dismiss() }
            AiSendModeOption(
                Icons.Outlined.Bolt, "原生插话", "AI 回复期间发送的新消息会直接交给运行中的 CLI 进程，由它决定在合适的节点接收并继续任务，不中断当前任务。",
                selected = sendSteer,
            ) { select(true); dismiss() }
            Text(
                "默认排队发送，仅影响本机 App 的连续发送行为，电脑端与 Web 端不受影响。",
                Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
            )
        }
    }
}

@Composable
private fun AiSendModeOption(
    icon: ImageVector, title: String, description: String, selected: Boolean, onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        color = if (selected) TbColors.Accent.copy(alpha = .12f) else TbColors.SurfaceHover,
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(icon, null, Modifier.size(22.dp), tint = if (selected) TbColors.Accent else TbColors.TextMuted)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(description, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
            if (selected) Icon(Icons.Outlined.Check, "已选择", Modifier.size(20.dp), tint = TbColors.Accent)
        }
    }
}

/** 首页只显示当前值，完整名称、路径与选中状态放在二级选择面板。 */
@Composable
internal fun AiChoiceField(
    label: String, icon: ImageVector, selectedId: String, placeholder: String, choices: List<AiChoice>,
    enabled: Boolean, select: (String) -> Unit, modifier: Modifier = Modifier, compact: Boolean = false,
    inlineLabel: Boolean = false,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val selected = choices.find { it.id == selectedId }
    val available = enabled && choices.isNotEmpty()
    LaunchedEffect(available) { if (!available) expanded = false }
    val verticalPadding = if (compact) 6.dp else 10.dp
    // 左右排列少了一行文字，用与原上下两行完全一致的高度兜底，保证卡片总高不随排布变化。
    val stackedLineHeight = if (compact) 29.sp else 38.sp
    val minHeight = if (inlineLabel) maxOf(
        if (compact) 45.dp else 60.dp,
        with(LocalDensity.current) { stackedLineHeight.toDp() } + verticalPadding * 2,
    ) else if (compact) 45.dp else 60.dp
    Surface(
        onClick = { expanded = true }, modifier = modifier.fillMaxWidth().alpha(if (available) 1f else .5f),
        enabled = available, color = TbColors.SurfaceHover, shape = RoundedCornerShape(if (compact) 11.dp else 14.dp),
    ) {
        Row(
            Modifier.heightIn(min = minHeight)
                .padding(horizontal = 14.dp, vertical = verticalPadding),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val selectedAgent = selected?.agent
            if (selectedAgent != null) AiAgentLogo(selectedAgent, Modifier.size(if (compact) 16.dp else 20.dp))
            else Icon(icon, null, Modifier.size(if (compact) 16.dp else 20.dp), tint = TbColors.TextMuted)
            if (inlineLabel) {
                // 标签与当前值紧挨着：内层 Row 占满图标与箭头之间的全部宽度，
                // 标签按内容宽度，值吃掉剩余空间（不能和占位 Spacer 平分权重，否则会被提前截断）。
                Row(
                    Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(label, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 13.sp else 18.sp),
                        color = TbColors.TextMuted, maxLines = 1)
                    Text(
                        selected?.title ?: placeholder,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.labelLarge.copy(lineHeight = if (compact) 16.sp else 20.sp),
                        color = if (selected == null) TbColors.TextMuted else TbColors.Text,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            } else {
                Column(Modifier.weight(1f)) {
                    Text(label, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 13.sp else 18.sp),
                        color = TbColors.TextMuted)
                    Text(
                        selected?.title ?: placeholder,
                        style = MaterialTheme.typography.labelLarge.copy(lineHeight = if (compact) 16.sp else 20.sp),
                        color = if (selected == null) TbColors.TextMuted else TbColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(if (compact) 15.dp else 18.dp), tint = TbColors.TextMuted)
        }
    }
    if (expanded && available) {
        AiSheet("选择$label", { expanded = false }) {
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f, fill = false),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            ) {
                items(choices, key = { it.id }) { choice ->
                    Surface(
                        onClick = { expanded = false; select(choice.id) },
                        color = if (choice.id == selectedId) TbColors.Accent.copy(alpha = .12f) else Color.Transparent,
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            choice.agent?.let { AiAgentLogo(it, Modifier.size(24.dp)) }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(choice.title, style = MaterialTheme.typography.bodyMedium)
                                if (choice.subtitle.isNotBlank()) Text(
                                    choice.subtitle, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                                )
                            }
                            if (choice.id == selectedId) Icon(Icons.Outlined.Check, "已选择", Modifier.size(20.dp), tint = TbColors.Accent)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AiSheet(
    title: String, dismiss: () -> Unit, heightFraction: Float? = null,
    action: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.() -> Unit,
) {
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    ModalBottomSheet(
        onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = TbColors.Surface,
    ) {
        // 高度限制放在内容区，让弹层按完整窗口高度计算底部停靠位置。
        Column(if (heightFraction != null) Modifier.fillMaxWidth().fillMaxHeight(heightFraction)
            else Modifier.fillMaxWidth().heightIn(max = screenHeight * .8f)) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                action()
                IconButton(dismiss) { Icon(Icons.Outlined.Close, "关闭$title", Modifier.size(20.dp), tint = TbColors.TextMuted) }
            }
            AiDivider()
            content()
        }
    }
}

@Composable
internal fun AiDeleteDialog(session: AiSession, dismiss: () -> Unit, confirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss, title = { Text("删除对话") },
        text = { Text("删除「${session.title}」在 AI 中保存的消息？项目文件不会被删除。") },
        confirmButton = { TextButton(confirm) { Text("删除", color = TbColors.Danger) } },
        dismissButton = { TextButton(dismiss) { Text("取消") } },
    )
}
