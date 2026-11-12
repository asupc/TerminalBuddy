package com.terminalbuddy.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.R
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.TerminalAgentUiState
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.data.AiHistorySession
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.ServerProfile
import com.terminalbuddy.android.data.ServerTerminal
import com.terminalbuddy.android.data.TerminalAgentSession
import com.terminalbuddy.android.data.findLiveAgentSession
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class SimpleHomeTab(val title: String) {
    Opened("已打开"), History("历史会话"),
}

/**
 * 简版核心页：只保留快速开始。
 * 顶部品牌与「我的」入口，中间是压缩后的新会话配置，下方用 Tab 切换已打开会话和历史会话。
 * 「开始对话」按服务端「新会话形态」设置分流：原生会话直接进入与桌面端一致的聊天页；
 * 终端接力则在服务端创建真实终端，手机打开的 Agent 与电脑终端完全同一会话。
 * 「已打开」平铺仍在服务端运行的对象：终端 Agent 会话与已打开的普通终端，
 * 再加上电脑端正打开着的原生会话（服务端 `desktopOpen` 标记）与手机本次运行打开过的会话；
 * 不再展示其余原生最近会话；已绑定 Agent 的终端由 Agent 行代表，不重复列出。
 * 历史会话按当前工作项目汇总全部已启用助手，不跟随快速开始里的助手选择。
 * 支持下拉刷新：手动补齐终端与 Agent 列表（实时推送之外的自救入口）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AiSimpleHome(
    ui: AiUiState, vm: AiViewModel,
    terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
    agentUi: TerminalAgentUiState, agentVm: TerminalAgentViewModel,
    openAgent: (TerminalAgentSession) -> Unit,
    profile: () -> Unit, accounts: () -> Unit, delete: (AiSession) -> Unit,
) {
    var tab by rememberSaveable(ui.activeAccountId) { mutableStateOf(SimpleHomeTab.Opened) }
    // 顶部「切换服务端」弹层；切换成功后由 state 驱动各页面重新绑定账号。
    var switchingServer by remember { mutableStateOf(false) }
    // 长按服务端会话 → 确认后关闭承载该会话的服务端终端（Agent 随之结束）。
    var closeTarget by remember { mutableStateOf<TerminalAgentSession?>(null) }
    // 项目配置与实时 Agent 会话来自服务端，进入简版首页时同步一次，后续账号切换自动重新绑定。
    LaunchedEffect(ui.activeAccountId, ui.connectionRevision) {
        terminalVm.bindAccount()
        agentVm.bindAccount()
        if (ui.authenticated) {
            terminalVm.refresh()
            agentVm.refresh()
        }
    }
    // 回前台时刷新实时会话：电脑端可能在 App 退后台期间持续输出，历史会话的「电脑运行中」匹配也依赖这份列表。
    LifecycleStartEffect(ui.activeAccountId) {
        if (ui.authenticated) agentVm.refresh()
        onStopOrDispose { }
    }
    // 账号守护：非当前账号的残留状态按空数据处理，与完整版会话页同一模式。
    val currentAgentUi = if (agentVm.isCurrentAccount() && agentUi.connection == agentVm.state.value.connection) {
        agentUi
    } else TerminalAgentUiState()
    // 已打开 = 正在运行的终端 Agent 会话 + 电脑端/本机打开的原生会话 + 已打开的普通终端。
    val agentSessions = remember(currentAgentUi.sessions) {
        currentAgentUi.sessions.sortedByDescending { it.lastActivityAt ?: it.phaseAt ?: 0L }
    }
    // 已绑定 Agent 的终端不再重复列出：进入 Agent 会话页后可切到「终端」页签。
    val openTerminals = remember(terminalUi.terminals, agentSessions) {
        val agentTerminalIds = agentSessions.mapTo(HashSet()) { it.terminalId }
        terminalUi.terminals.filterNot { it.id in agentTerminalIds }
    }
    // 原生会话以服务端为准：电脑端打开着的 + 手机本次运行打开过的，不再读本机持久记录。
    val openedNative = ui.openedSessions
    val openedEmpty = agentSessions.isEmpty() && openTerminals.isEmpty() && openedNative.isEmpty()
    // 两侧都成功加载后才展示计数；任一侧失败时按已拿到的数据展示，不阻塞另一侧。
    val agentPending = currentAgentUi.listError == null && !currentAgentUi.listLoaded
    val terminalPending = terminalUi.error == null && !terminalUi.loaded
    val openedCount = (agentSessions.size + openTerminals.size + openedNative.size)
        .takeIf { !agentPending && !terminalPending }
    // 历史范围只取决于项目与该项目可用的助手，切换助手不会重新拉取或过滤历史。
    val historyAgents = ui.availableAgents
    LaunchedEffect(tab, ui.projectPath, ui.connectionRevision, historyAgents) {
        if (tab == SimpleHomeTab.History) vm.loadHistoryForSelection()
        // 已打开 Tab 依赖实时 Agent 列表，历史会话也用它做「电脑运行中」匹配。
        agentVm.refresh()
    }
    Column(Modifier.fillMaxSize()) {
        AiSimpleHeader(ui, profile) { switchingServer = true }
        ui.error?.let { AiError(it, vm::clearError) }
        // 下拉刷新：三路列表一起补拉；转圈只跟随 Agent 列表的 loading（主数据源）。
        var pullRefreshing by remember { mutableStateOf(false) }
        LaunchedEffect(currentAgentUi.listLoading) {
            if (!currentAgentUi.listLoading) pullRefreshing = false
        }
        PullToRefreshBox(
            modifier = Modifier.fillMaxSize(),
            isRefreshing = pullRefreshing,
            onRefresh = {
                pullRefreshing = true
                vm.refresh()
                terminalVm.refresh()
                agentVm.refresh()
            },
        ) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 2.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item(key = "composer") {
                SimpleComposer(ui, vm, terminalUi, terminalVm, onStart = {
                    val project = ui.launchProject
                    val provider = ui.launchProvider
                    val model = ui.launchModel
                    if (project != null && provider != null && model != null && ui.canCreate) {
                        // 安卓端创建会话固定走原生会话，不跟随电脑端「新会话形态」设置。
                        vm.create()
                    }
                })
            }
            item(key = "tabs") {
                SimpleTabs(
                    selected = tab,
                    openedCount = openedCount,
                    historyCount = ui.historySessions.size.takeIf {
                        ui.historyProjectPath == ui.projectPath && ui.historyAgents == historyAgents
                    },
                    select = { tab = it },
                )
            }
            when (tab) {
                SimpleHomeTab.Opened -> {
                    // 实时会话同步失败不提示：VM 内已按退避自动重试，这里最多保留已拿到的 Agent / 终端。
                    currentAgentUi.closeError?.let { error -> item(key = "agent-close-error") {
                        Surface(color = TbColors.Danger.copy(alpha = .08f), shape = RoundedCornerShape(12.dp)) {
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    error, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                                    color = TbColors.Danger, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                )
                                TextButton(agentVm::clearCloseError) { Text("知道了") }
                            }
                        }
                    } }
                    if (!openedEmpty) {
                        items(agentSessions, key = { "agent-${it.terminalId}" }) { session ->
                            SimpleAgentSessionRow(
                                session,
                                closing = currentAgentUi.closingTerminalId == session.terminalId,
                                open = { openAgent(session) },
                                requestClose = { closeTarget = session },
                            )
                        }
                        items(openedNative, key = { "native-${it.id}" }) { session ->
                            AiRecentSessionRow(
                                ui, session, { vm.open(session.id) }, { delete(session) },
                            )
                        }
                        items(openTerminals, key = { "terminal-${it.id}" }) { terminal ->
                            SimpleTerminalRow(
                                terminal,
                                profile = terminalUi.profiles.find { it.id == terminal.profileId },
                                open = { terminalVm.open(terminal) },
                            )
                        }
                        item(key = "opened-foot") {
                            Text("只显示当前已打开的会话，点击继续；长按终端 Agent 可关闭。",
                                Modifier.fillMaxWidth().padding(top = 4.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = TbColors.TextMuted)
                        }
                    }
                    when {
                        // 列表为空时按加载进度显示提示；任一侧有数据就直接平铺。
                        openedEmpty && (agentPending || terminalPending || ui.initialLoading) ->
                            item(key = "opened-loading") { SimpleLoading("正在同步已打开的会话…") }
                        openedEmpty -> item(key = "opened-empty") {
                            AiEmptyState(Icons.Outlined.ChatBubbleOutline, "还没有打开的会话",
                                "选择项目与模型开始对话，或从历史会话中恢复。")
                        }
                    }
                }
                SimpleHomeTab.History -> {
                    val project = ui.launchProject
                    val historyReady = ui.historyProjectPath == project?.path &&
                        ui.historyAgents == historyAgents && !ui.historyLoading
                    when {
                        project == null -> item(key = "history-no-project") {
                            AiEmptyState(Icons.Outlined.FolderOpen, "还没有选择工作项目",
                                "先在上方选择一个项目，历史会话会按项目自动筛选。")
                        }
                        historyAgents.isEmpty() -> item(key = "history-no-agent") {
                            AiEmptyState(Icons.Outlined.SmartToy, "当前项目还没有可用助手",
                                "请先在服务端为该项目启用助手并配置模型。")
                        }
                        !historyReady && ui.historySessions.isEmpty() -> item(key = "history-loading") {
                            SimpleLoading("正在读取历史会话…")
                        }
                        ui.historySessions.isEmpty() -> item(key = "history-empty") {
                            AiEmptyState(Icons.Outlined.History, "该项目暂无历史会话",
                                "在电脑或服务端用该项目启用的助手对话后，会出现在这里。")
                        }
                        else -> {
                            items(ui.historySessions, key = { "history-${it.session.sessionId}" }) { entry ->
                                // 正在电脑/服务端终端里运行的会话直接接管（实时镜像，不另起进程），其余保持恢复历史。
                                val live = findLiveAgentSession(entry.agent, entry.session.sessionId, currentAgentUi.sessions)
                                SimpleHistoryRow(entry.agent, entry.session, live, live == null && !ui.working) {
                                    if (live != null) openAgent(live) else vm.resumeHistory(entry)
                                }
                            }
                            item(key = "history-foot") {
                                Text("共 ${ui.historySessions.size} 段历史会话 · 仅显示当前项目",
                                    Modifier.fillMaxWidth().padding(top = 4.dp),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TbColors.TextMuted, textAlign = TextAlign.Center)
                            }
                        }
                    }
                }
            }
        }
        }
    }
    val target = closeTarget
    if (switchingServer) {
        AiSheet("切换服务端", { switchingServer = false }) {
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f, fill = false),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item(key = "server-hint") {
                    Text(
                        "每个已登录的服务端都会同时接收任务通知；切换只改变当前操作的服务端。",
                        Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    )
                }
                items(ui.accounts, key = { it.id }) { account ->
                    val current = account.id == ui.activeAccountId
                    val switching = account.id == ui.switchingAccountId
                    Surface(
                        onClick = {
                            if (current) switchingServer = false
                            else if (!account.loggedIn) { switchingServer = false; accounts() }
                            else { vm.switchAccount(account.id); switchingServer = false }
                        },
                        enabled = !ui.authenticating,
                        color = if (current) TbColors.Accent.copy(alpha = .12f) else TbColors.SurfaceHover,
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Icon(
                                Icons.Outlined.Cloud, null, Modifier.size(22.dp),
                                tint = if (current) TbColors.Accent else TbColors.TextMuted,
                            )
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(account.label, style = MaterialTheme.typography.titleSmall,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    if (account.name.isBlank()) account.server else "${account.username} · ${account.server}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                Text(when {
                                    current -> "当前服务端"
                                    switching -> "正在切换…"
                                    !account.loggedIn -> "需要重新登录"
                                    else -> "已登录 · 点击切换"
                                }, style = MaterialTheme.typography.labelSmall,
                                    color = if (!account.loggedIn) TbColors.Danger else TbColors.Accent)
                            }
                            when {
                                switching -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                current -> Icon(Icons.Outlined.CheckCircle, "当前服务端",
                                    Modifier.size(20.dp), tint = TbColors.Accent)
                                !account.loggedIn -> TextButton(
                                    { switchingServer = false; accounts() },
                                    contentPadding = PaddingValues(horizontal = 8.dp),
                                ) { Text("登录") }
                                else -> Icon(Icons.Outlined.SwapHoriz, "切换到此服务端",
                                    Modifier.size(20.dp), tint = TbColors.TextMuted)
                            }
                        }
                    }
                }
                item(key = "manage-accounts") {
                    TextButton(
                        onClick = { switchingServer = false; accounts() },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("管理账号 / 添加服务端") }
                }
            }
        }
    }
    if (target != null) AlertDialog(
        onDismissRequest = { closeTarget = null },
        title = { Text("关闭服务端 Agent") },
        text = {
            Text("关闭「${target.displayTitle}」所在的服务端终端？终端里的 Agent 会话会随之结束，未保存的工作将丢失。")
        },
        confirmButton = {
            TextButton({
                closeTarget = null
                agentVm.closeSession(target)
            }) { Text("关闭", color = TbColors.Danger) }
        },
        dismissButton = { TextButton({ closeTarget = null }) { Text("取消") } },
    )
}

/** 品牌 + 页面名，右侧依次为切换服务端与「我的」入口。 */
@Composable
private fun AiSimpleHeader(ui: AiUiState, profile: () -> Unit, switchServer: () -> Unit) {
    Box(Modifier.fillMaxWidth().statusBarsPadding(), contentAlignment = Alignment.TopCenter) {
        Row(
            Modifier.widthIn(max = 680.dp).fillMaxWidth()
                .padding(start = 18.dp, end = 8.dp, top = 10.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Image(
                painterResource(R.drawable.terminal_buddy_logo), null,
                Modifier.size(30.dp).clip(RoundedCornerShape(9.dp)),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("Terminal Buddy", style = MaterialTheme.typography.titleMedium)
                Text("快速开始", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
            }
            AiReconnectingIndicator(ui.reconnecting)
            // 多服务端切换入口：放在「我的」左侧，不跳转页面即可切换当前服务端。
            IconButton(switchServer, enabled = !ui.authenticating) {
                if (ui.switchingAccountId != null) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Outlined.SwapHoriz, "切换服务端", Modifier.size(23.dp), tint = TbColors.TextSoft)
                }
            }
            IconButton(profile) {
                Icon(Icons.Outlined.PersonOutline, "我的", Modifier.size(23.dp), tint = TbColors.TextSoft)
            }
        }
    }
}

/** 新会话配置卡：压缩纵向留白，Agent 只显示图标，不重复文字名称；仅一个助手时不再提供选择。 */
@Composable
private fun SimpleComposer(
    ui: AiUiState, vm: AiViewModel,
    terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
    onStart: () -> Unit,
) {
    val agents = if (ui.initialLoading) listOf("claude", "codex")
        else ui.availableAgents
    // 同步完成后只剩一个助手时无需选择：隐藏助手行，标志直接并入开始按钮。
    val singleAgent = !ui.initialLoading && agents.size == 1
    val launching = terminalUi.launchingAgent
    val enabled = !ui.initialLoading && !ui.working && !ui.authenticating && !launching
    val project = ui.launchProject
    val projectProfiles = remember(terminalUi.profiles, project?.name, project?.path) {
        if (project == null) emptyList()
        else terminalUi.profiles.filter {
            it.canLaunch && (it.projectName == project.name || it.projectName == project.path)
        }
    }
    AiCard(shape = RoundedCornerShape(20.dp)) {
        Column(Modifier.fillMaxWidth().padding(13.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("开启新会话", Modifier.weight(1f),
                    style = MaterialTheme.typography.titleSmall.copy(lineHeight = 18.sp))
                if (terminalUi.loading && projectProfiles.isEmpty()) {
                    CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = TbColors.TextMuted)
                }
            }
            AiChoiceField("工作项目", Icons.Outlined.FolderOpen, ui.projectPath, "选择一个项目",
                ui.projects.distinctBy { it.path }.map { AiChoice(it.path, it.name, it.path) }, enabled, vm::selectProject,
                compact = true, inlineLabel = true)
            if (project != null && projectProfiles.isNotEmpty()) {
                SimpleProjectCommands(projectProfiles, terminalUi, terminalVm)
            }
            if (agents.isNotEmpty() && !singleAgent) {
                SimpleAgentPicker(agents, ui.launchProvider?.agent.orEmpty(), enabled && !ui.initialLoading,
                    ui.availableAgents, vm::selectAgent)
            }
            AiChoiceField("使用模型", Icons.Outlined.Tune, ui.launchModelKey, "选择模型",
                modelChoices(ui.availableModels), enabled, vm::selectModel, compact = true, inlineLabel = true)
            val hint = when {
                ui.initialLoading -> "正在同步项目和模型…"
                ui.projects.isEmpty() -> "请先在服务端登记项目。"
                ui.availableAgents.isEmpty() -> "该项目尚未配置可用助手，请在服务端配置模型。"
                agents.isEmpty() -> "项目启用的助手尚未在服务端安装，请先在服务端 Agent 管理中安装。"
                ui.availableModels.isEmpty() -> "当前助手暂无可用模型，请在服务端配置。"
                else -> null
            }
            hint?.let {
                Text(it, style = MaterialTheme.typography.bodySmall.copy(lineHeight = 15.sp),
                    color = TbColors.TextMuted)
            }
            terminalUi.agentLaunchError?.let { error ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(error, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.copy(lineHeight = 15.sp),
                        color = TbColors.Danger)
                    TextButton(terminalVm::clearAgentLaunchError, contentPadding = PaddingValues(0.dp)) {
                        Text("知道了", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            Button(onStart, enabled = ui.canCreate && !launching, shape = RoundedCornerShape(12.dp),
                colors = primaryButtonColors(), border = primaryControlBorder(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)) {
                if (ui.working || launching) CircularProgressIndicator(Modifier.size(14.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
                else if (singleAgent) AiAgentLogo(agents.first(), Modifier.size(16.dp), agentTitle(agents.first()),
                    tint = LocalContentColor.current)
                else Icon(Icons.Outlined.Add, null, Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (ui.working || launching) "正在启动…" else "开始对话", Modifier.weight(1f),
                    style = MaterialTheme.typography.labelLarge.copy(lineHeight = 15.sp))
                Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(15.dp))
            }
        }
    }
}

/** Agent 选择只保留标志，选中态用底色区分；名称只作为无障碍描述。 */
@Composable
private fun SimpleAgentPicker(
    agents: List<String>, selected: String, enabled: Boolean,
    enabledAgents: List<String>, select: (String) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().selectableGroup()
            .background(TbColors.ButtonTrack, RoundedCornerShape(12.dp)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        agents.forEach { agent ->
            val active = selected == agent
            val available = enabled && agent in enabledAgents
            val ink = if (active) TbColors.ButtonForeground else TbColors.TextSoft
            Surface(
                modifier = Modifier.weight(1f).alpha(if (available) 1f else .35f).selectable(
                    selected = active, enabled = available, role = Role.Tab,
                    onClick = { select(agent) },
                ),
                color = if (active) TbColors.ButtonBackground else Color.Transparent,
                shape = RoundedCornerShape(9.dp),
                border = if (active) primaryControlBorder() else null,
            ) {
                Box(Modifier.fillMaxWidth().heightIn(min = 38.dp), contentAlignment = Alignment.Center) {
                    AiAgentLogo(agent, Modifier.size(19.dp), agentTitle(agent), tint = ink)
                }
            }
        }
    }
}

/** 当前项目在服务端登记了配置命令时，直接在首页提供启动入口。 */
@Composable
private fun SimpleProjectCommands(
    profiles: List<ServerProfile>, terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(13.dp), tint = TbColors.TextMuted)
            Text("项目配置", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
            Spacer(Modifier.weight(1f))
            Text("${profiles.size} 项", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            profiles.forEach { profile ->
                val terminal = terminalUi.terminals.find { it.profileId == profile.id }
                val launching = terminalUi.launchingId == profile.id
                val active = terminal != null
                val available = profile.canLaunch && terminalUi.launchingId == null && !terminalUi.loading
                Surface(
                    onClick = { if (active) terminalVm.open(terminal!!) else terminalVm.launch(profile) },
                    enabled = available,
                    color = if (active) TbColors.Accent.copy(alpha = .12f) else TbColors.SurfaceHover,
                    shape = RoundedCornerShape(9.dp),
                ) {
                    Row(
                        Modifier.padding(horizontal = 9.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        when {
                            launching -> CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp,
                                color = TbColors.TextMuted)
                            active -> Icon(Icons.Outlined.OpenInNew, null, Modifier.size(14.dp), tint = TbColors.Accent)
                            else -> Icon(Icons.Outlined.PlayArrow, null, Modifier.size(14.dp), tint = TbColors.TextSoft)
                        }
                        Text(
                            if (active) "继续 · ${profile.name}" else profile.name,
                            style = MaterialTheme.typography.labelMedium, maxLines = 1,
                            color = if (active) TbColors.Accent else TbColors.TextSoft,
                        )
                    }
                }
            }
        }
        terminalUi.error?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = TbColors.Danger, maxLines = 2,
                overflow = TextOverflow.Ellipsis)
        }
    }
}

/** 已打开 / 历史会话的两段式切换，数量只作辅助信息。 */
@Composable
private fun SimpleTabs(
    selected: SimpleHomeTab, openedCount: Int?, historyCount: Int?,
    select: (SimpleHomeTab) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().selectableGroup()
            .background(TbColors.SurfaceHover, RoundedCornerShape(12.dp)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        SimpleHomeTab.entries.forEach { tab ->
            val active = selected == tab
            val count = when (tab) {
                SimpleHomeTab.Opened -> openedCount
                SimpleHomeTab.History -> historyCount
            }
            Surface(
                modifier = Modifier.weight(1f).selectable(active, role = Role.Tab, onClick = { select(tab) }),
                color = if (active) TbColors.Surface else Color.Transparent,
                shape = RoundedCornerShape(9.dp),
                border = if (active) androidx.compose.foundation.BorderStroke(1.dp, TbColors.Border) else null,
            ) {
                Row(
                    Modifier.padding(horizontal = 8.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                ) {
                    Text(tab.title, style = MaterialTheme.typography.labelLarge,
                        color = if (active) TbColors.Text else TbColors.TextSoft, maxLines = 1)
                    count?.let {
                        Text(if (it > 99) "99+" else it.toString(),
                            style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                    }
                }
            }
        }
    }
}

/**
 * 历史会话行：与最近任务保持同样的两层信息；live 非空表示该会话正在电脑/服务端终端里运行，
 * 标记「电脑运行中」且点击直接接管（不另起进程），其余点击恢复为可发送的原生会话。
 */
@Composable
private fun SimpleHistoryRow(
    agent: String, session: AiHistorySession, live: TerminalAgentSession?, enabled: Boolean, open: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Surface(
            onClick = open, enabled = live != null || enabled, color = Color.Transparent,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                AiAgentBadge(agent, size = 25.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(session.displayTitle, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (live != null) SimpleLiveTag()
                    }
                    Text(
                        buildList {
                            if (session.messageCount > 0) add("${session.messageCount} 条消息")
                            session.model?.takeIf(String::isNotBlank)?.let(::add)
                            historyTime(session.updatedAt)?.let(::add)
                        }.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                if (live != null) Icon(Icons.Outlined.Monitor, "电脑运行中，点击接管", Modifier.size(17.dp), tint = TbColors.Accent)
                else Icon(Icons.Outlined.Replay, "恢复历史会话", Modifier.size(17.dp), tint = TbColors.TextMuted)
            }
        }
        AiDivider(Modifier.padding(start = 43.dp))
    }
}

/** 服务端会话行：点击接管为接力会话（实时镜像 + 受限回复），长按关闭服务端 Agent。 */
@Composable
private fun SimpleAgentSessionRow(
    session: TerminalAgentSession,
    closing: Boolean,
    open: () -> Unit,
    requestClose: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .combinedClickable(onClick = open, onLongClickLabel = "关闭服务端 Agent", onLongClick = requestClose)
                .padding(horizontal = 8.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AiAgentBadge(session.provider, size = 25.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(session.displayTitle, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    SimplePhaseTag(session.phase, session.phaseLabel)
                }
                Text(
                    buildList {
                        session.model?.takeIf(String::isNotBlank)?.let(::add)
                        session.directory?.takeIf(String::isNotBlank)?.let { dir ->
                            dir.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
                                .takeIf(String::isNotBlank)?.let(::add)
                        }
                        session.lastActivityAt?.takeIf { it > 0 }?.let { activityTime(it) }?.let(::add)
                    }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (closing) {
                CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp, color = TbColors.TextMuted)
            } else if (session.pendingDecisionCount > 0) {
                BadgedBox(badge = {
                    Badge(containerColor = TbColors.Accent, contentColor = TbColors.AccentInk) {
                        Text(if (session.pendingDecisionCount > 99) "99+" else session.pendingDecisionCount.toString())
                    }
                }) { Icon(Icons.Outlined.PendingActions, "有待决策", Modifier.size(17.dp), tint = TbColors.Accent) }
            } else {
                Icon(Icons.Outlined.ChevronRight, "接管会话", Modifier.size(17.dp), tint = TbColors.TextMuted)
            }
        }
        AiDivider(Modifier.padding(start = 43.dp))
    }
}

/** 已打开的普通终端行：点击进入终端画面；承载 Agent 的终端由 Agent 行代表，不会走到这里。 */
@Composable
private fun SimpleTerminalRow(
    terminal: ServerTerminal,
    profile: ServerProfile?,
    open: () -> Unit,
) {
    val type = terminal.terminalType.ifBlank { profile?.terminalType.orEmpty() }
    val typeName = terminalTypeLabel(type)
    val directory = terminal.directory?.takeIf(String::isNotBlank)
        ?: profile?.startupPath?.takeIf(String::isNotBlank)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .combinedClickable(onClick = open)
                .padding(horizontal = 8.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier.size(25.dp).background(TbColors.SurfaceHover, RoundedCornerShape(7.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (type.equals("ssh", ignoreCase = true)) Icons.Outlined.Dns else Icons.Outlined.Terminal,
                    null, Modifier.size(15.dp), tint = TbColors.Accent,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(terminal.profileName, style = MaterialTheme.typography.titleSmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(typeName, directory).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(Icons.Outlined.ChevronRight, "进入终端", Modifier.size(17.dp), tint = TbColors.TextMuted)
        }
        AiDivider(Modifier.padding(start = 43.dp))
    }
}

/** 「电脑运行中」标记：历史会话行与服务端会话行共用。 */
@Composable
private fun SimpleLiveTag() {
    Surface(color = TbColors.Accent.copy(alpha = .14f), shape = RoundedCornerShape(4.dp)) {
        Text("电脑运行中", Modifier.padding(horizontal = 5.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, lineHeight = 12.sp),
            color = TbColors.Accent, maxLines = 1)
    }
}

/** 阶段小标签：等待确认用强调色提醒，其余弱化展示。 */
@Composable
private fun SimplePhaseTag(phase: String, label: String) {
    val attention = phase == "attention"
    Surface(
        color = if (attention) TbColors.Accent.copy(alpha = .14f) else TbColors.SurfaceHover,
        shape = RoundedCornerShape(4.dp),
    ) {
        Text(label, Modifier.padding(horizontal = 5.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, lineHeight = 12.sp),
            color = if (attention) TbColors.Accent else TbColors.TextSoft, maxLines = 1)
    }
}

/** 最近活动的相对时间：与最近任务列表的展示口径一致。 */
private fun activityTime(timestamp: Long): String {
    val minutes = ((System.currentTimeMillis() - timestamp).coerceAtLeast(0)) / 60_000
    return when {
        minutes == 0L -> "刚刚"
        minutes < 60 -> "${minutes} 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        else -> SimpleDateFormat("MM-dd", Locale.CHINA).format(Date(timestamp))
    }
}

@Composable
private fun SimpleLoading(text: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = TbColors.TextMuted)
        Text(text, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
    }
}

private fun historyTime(timestamp: Long): String? {
    if (timestamp <= 0) return null
    return SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(Date(timestamp))
}
