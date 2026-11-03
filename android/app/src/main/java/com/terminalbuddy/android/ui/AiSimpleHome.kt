package com.terminalbuddy.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
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
import com.terminalbuddy.android.data.TerminalAgentSession
import com.terminalbuddy.android.data.findLiveAgentSession
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class SimpleHomeTab(val title: String) {
    Recent("最近会话"), History("历史会话"),
}

/**
 * 简版核心页：只保留快速开始。
 * 顶部品牌与「我的」入口，中间是压缩后的新会话配置，下方用 Tab 切换最近会话和历史会话。
 * 最近会话把服务端正在运行的 Agent 会话（实时镜像，点击直接接管）与 App 发起的会话合并展示，
 * 按「服务端正在运行 / App 发起」分组平铺；历史会话按当前工作项目汇总全部已启用助手，
 * 不跟随快速开始里的助手选择。
 */
@Composable
internal fun AiSimpleHome(
    ui: AiUiState, vm: AiViewModel,
    terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
    agentUi: TerminalAgentUiState, agentVm: TerminalAgentViewModel,
    openAgent: (TerminalAgentSession) -> Unit,
    profile: () -> Unit, delete: (AiSession) -> Unit,
) {
    var tab by rememberSaveable(ui.activeAccountId) { mutableStateOf(SimpleHomeTab.Recent) }
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
    // 冷启动先用首页缓存的最近日任务占位，完整列表同步后再平铺全部会话。
    val recent = remember(ui.sessions, ui.recentSessions) {
        (if (ui.sessions.isEmpty()) ui.recentSessions else ui.sessions)
            .sortedByDescending { it.updatedAt }
    }
    // 历史范围只取决于项目与该项目可用的助手，切换助手不会重新拉取或过滤历史。
    val historyAgents = ui.availableAgents
    LaunchedEffect(tab, ui.projectPath, ui.connectionRevision, historyAgents) {
        if (tab == SimpleHomeTab.History) vm.loadHistoryForSelection()
        // 两个 Tab 都依赖实时 Agent 列表：最近会话展示「服务端正在运行」分组，历史会话做「电脑运行中」匹配。
        agentVm.refresh()
    }
    Column(Modifier.fillMaxSize()) {
        AiSimpleHeader(ui.reconnecting, profile)
        ui.error?.let { AiError(it, vm::clearError) }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 2.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item(key = "composer") {
                SimpleComposer(ui, vm, terminalUi, terminalVm)
            }
            item(key = "tabs") {
                SimpleTabs(
                    selected = tab,
                    // 最近会话的计数是「服务端正在运行 + App 发起」的合计，两边都同步完成后才展示。
                    recentCount = if (ui.homeLoaded && currentAgentUi.listLoaded)
                        recent.size + currentAgentUi.sessions.size else null,
                    historyCount = ui.historySessions.size.takeIf {
                        ui.historyProjectPath == ui.projectPath && ui.historyAgents == historyAgents
                    },
                    select = { tab = it },
                )
            }
            when (tab) {
                SimpleHomeTab.Recent -> {
                    // 服务端会话同步失败时给出行内重试入口，不影响下方 App 会话分组的展示。
                    currentAgentUi.listError?.let { error -> item(key = "server-error") {
                        Surface(color = TbColors.Danger.copy(alpha = .08f), shape = RoundedCornerShape(16.dp)) {
                            Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text("服务端会话同步失败", style = MaterialTheme.typography.titleSmall)
                                Text(error, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                                TextButton(agentVm::refresh, enabled = !currentAgentUi.listLoading,
                                    contentPadding = PaddingValues(0.dp)) { Text("重新加载") }
                            }
                        }
                    } }
                    val serverSessions = currentAgentUi.sessions
                    if (serverSessions.isNotEmpty()) {
                        item(key = "server-head") {
                            SimpleSectionLabel(Icons.Outlined.Monitor, "服务端正在运行", serverSessions.size)
                        }
                        items(serverSessions, key = { "server-${it.terminalId}" }) { session ->
                            SimpleAgentSessionRow(session) { openAgent(session) }
                        }
                        item(key = "server-foot") {
                            Text("实时镜像电脑终端输出，Claude 可回一句或处理待决策，Codex 暂只读。",
                                Modifier.fillMaxWidth().padding(top = 4.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = TbColors.TextMuted)
                        }
                    }
                    if (recent.isNotEmpty()) {
                        item(key = "recent-head") {
                            SimpleSectionLabel(Icons.Outlined.ChatBubbleOutline, "App 发起的会话", recent.size)
                        }
                        items(recent, key = { "recent-${it.id}" }) { session ->
                            AiRecentSessionRow(ui, session, { vm.open(session.id) }, { delete(session) })
                        }
                    }
                    when {
                        // 两组都还没有内容时给出加载/空态；任一分组有数据就直接平铺，不再插入提示。
                        ui.initialLoading -> if (serverSessions.isEmpty() && recent.isEmpty())
                            item(key = "recent-loading") { SimpleLoading("正在同步最近任务…") }
                        currentAgentUi.listError == null && !currentAgentUi.listLoaded ->
                            if (serverSessions.isEmpty() && recent.isEmpty())
                                item(key = "server-loading") { SimpleLoading("正在同步服务端会话…") }
                        serverSessions.isEmpty() && recent.isEmpty() -> item(key = "recent-empty") {
                            AiEmptyState(Icons.Outlined.ChatBubbleOutline, "第一段对话，从这里开始",
                                "选择项目与模型，开启你的新想法。")
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

/** 品牌 + 页面名，右侧只保留「我的」入口。 */
@Composable
private fun AiSimpleHeader(reconnecting: Boolean, profile: () -> Unit) {
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
            AiReconnectingIndicator(reconnecting)
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
) {
    val agents = if (ui.initialLoading) listOf("claude", "codex")
        else ui.availableAgents
    // 同步完成后只剩一个助手时无需选择：隐藏助手行，标志直接并入开始按钮。
    val singleAgent = !ui.initialLoading && agents.size == 1
    val enabled = !ui.initialLoading && !ui.working && !ui.authenticating
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
                ui.projects.map { AiChoice(it.path, it.name, it.path) }, enabled, vm::selectProject,
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
            Button(vm::create, enabled = ui.canCreate, shape = RoundedCornerShape(12.dp),
                colors = primaryButtonColors(), border = primaryControlBorder(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)) {
                if (ui.working) CircularProgressIndicator(Modifier.size(14.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
                else if (singleAgent) AiAgentLogo(agents.first(), Modifier.size(16.dp), agentTitle(agents.first()),
                    tint = LocalContentColor.current)
                else Icon(Icons.Outlined.Add, null, Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (ui.working) "正在创建…" else "开始对话", Modifier.weight(1f),
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

/** 最近会话 / 历史会话的两段式切换，数量只作辅助信息。 */
@Composable
private fun SimpleTabs(
    selected: SimpleHomeTab, recentCount: Int?, historyCount: Int?,
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
                SimpleHomeTab.Recent -> recentCount
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
 * 最近会话的小节标题：合并列表按「服务端正在运行 / App 发起」分组，
 * 样式与「项目配置」小节一致，数量只作辅助信息。
 */
@Composable
private fun SimpleSectionLabel(icon: ImageVector, text: String, count: Int) {
    Row(
        Modifier.fillMaxWidth().padding(top = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(icon, null, Modifier.size(13.dp), tint = TbColors.TextMuted)
        Text(text, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
        Spacer(Modifier.weight(1f))
        Text("$count 项", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
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

/** 服务端会话行：正在终端里运行的 Agent 会话，点击直接接管为接力会话（实时镜像 + 受限回复）。 */
@Composable
private fun SimpleAgentSessionRow(session: TerminalAgentSession, open: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Surface(onClick = open, color = Color.Transparent, modifier = Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 11.dp),
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
                if (session.pendingDecisionCount > 0) {
                    BadgedBox(badge = {
                        Badge(containerColor = TbColors.Accent, contentColor = TbColors.AccentInk) {
                            Text(if (session.pendingDecisionCount > 99) "99+" else session.pendingDecisionCount.toString())
                        }
                    }) { Icon(Icons.Outlined.PendingActions, "有待决策", Modifier.size(17.dp), tint = TbColors.Accent) }
                }
                Icon(Icons.Outlined.ChevronRight, "接管会话", Modifier.size(17.dp), tint = TbColors.TextMuted)
            }
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
