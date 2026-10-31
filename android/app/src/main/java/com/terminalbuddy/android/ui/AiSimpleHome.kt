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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.R
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.data.AiHistorySession
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.ServerProfile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class SimpleHomeTab(val title: String) {
    Recent("最近任务"), History("历史会话"),
}

/**
 * 简版核心页：只保留快速开始。
 * 顶部品牌与「我的」入口，中间是压缩后的新会话配置，下方用 Tab 切换最近任务和历史会话。
 * 最近任务全部平铺，不再提供「查看全部」；历史会话跟随当前工作项目的选择过滤。
 */
@Composable
internal fun AiSimpleHome(
    ui: AiUiState, vm: AiViewModel,
    terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
    profile: () -> Unit, delete: (AiSession) -> Unit,
) {
    var tab by rememberSaveable(ui.activeAccountId) { mutableStateOf(SimpleHomeTab.Recent) }
    // 项目配置来自服务端，进入简版首页时同步一次，后续账号切换自动重新绑定。
    LaunchedEffect(ui.activeAccountId, ui.connectionRevision) {
        terminalVm.bindAccount()
        if (ui.authenticated) terminalVm.refresh()
    }
    val recent = remember(ui.sessions) { ui.sessions.sortedByDescending { it.updatedAt } }
    // 切换项目 / 助手或重新进入历史 Tab 时，按当前选择重新拉取 CLI 历史。
    LaunchedEffect(tab, ui.projectPath, ui.launchProvider?.agent, ui.connectionRevision) {
        if (tab == SimpleHomeTab.History) vm.loadHistoryForSelection()
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
                    recentCount = recent.size.takeIf { ui.homeLoaded },
                    historyCount = ui.historySessions.size.takeIf {
                        ui.historyProjectPath == ui.projectPath && ui.historyAgent == ui.launchProvider?.agent
                    },
                    select = { tab = it },
                )
            }
            when (tab) {
                SimpleHomeTab.Recent -> {
                    if (ui.initialLoading && recent.isEmpty()) item(key = "recent-loading") {
                        SimpleLoading("正在同步最近任务…")
                    } else if (recent.isEmpty()) item(key = "recent-empty") {
                        AiEmptyState(Icons.Outlined.ChatBubbleOutline, "第一段对话，从这里开始",
                            "选择项目与模型，开启你的新想法。")
                    } else {
                        items(recent, key = { "recent-${it.id}" }) { session ->
                            AiRecentSessionRow(ui, session, { vm.open(session.id) }, { delete(session) })
                        }
                    }
                }
                SimpleHomeTab.History -> {
                    val project = ui.launchProject
                    val agent = ui.launchProvider?.agent
                    val historyReady = agent != null && ui.historyProjectPath == project?.path &&
                        ui.historyAgent == agent && !ui.historyLoading
                    when {
                        project == null -> item(key = "history-no-project") {
                            AiEmptyState(Icons.Outlined.FolderOpen, "还没有选择工作项目",
                                "先在上方选择一个项目，历史会话会按项目自动筛选。")
                        }
                        agent == null -> item(key = "history-no-agent") {
                            AiEmptyState(Icons.Outlined.SmartToy, "当前项目还没有可用助手",
                                "请先在服务端为该项目启用助手并配置模型。")
                        }
                        !historyReady && ui.historySessions.isEmpty() -> item(key = "history-loading") {
                            SimpleLoading("正在读取 ${agentTitle(agent)} 历史会话…")
                        }
                        ui.historySessions.isEmpty() -> item(key = "history-empty") {
                            AiEmptyState(Icons.Outlined.History, "该项目暂无历史会话",
                                "在电脑或服务端用 ${agentTitle(agent)} 对话后，会出现在这里。")
                        }
                        else -> {
                            items(ui.historySessions, key = { "history-${it.sessionId}" }) { session ->
                                SimpleHistoryRow(agent.orEmpty(), session, !ui.working) {
                                    vm.resumeHistory(session)
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

/** 新会话配置卡：压缩纵向留白，Agent 只显示图标，不重复文字名称。 */
@Composable
private fun SimpleComposer(
    ui: AiUiState, vm: AiViewModel,
    terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
) {
    val agents = if (ui.initialLoading) listOf("claude", "codex")
        else ui.availableAgents.filter(ui::agentInstalled)
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
            if (agents.isNotEmpty()) {
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

/** 最近任务 / 历史会话的两段式切换，数量只作辅助信息。 */
@Composable
private fun SimpleTabs(
    selected: SimpleHomeTab, recentCount: Int?, historyCount: Int?, select: (SimpleHomeTab) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().selectableGroup()
            .background(TbColors.SurfaceHover, RoundedCornerShape(12.dp)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        SimpleHomeTab.entries.forEach { tab ->
            val active = selected == tab
            val count = if (tab == SimpleHomeTab.Recent) recentCount else historyCount
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

/** 历史会话行：与最近任务保持同样的两层信息，点击直接恢复为可发送的原生会话。 */
@Composable
private fun SimpleHistoryRow(agent: String, session: AiHistorySession, enabled: Boolean, open: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Surface(
            onClick = open, enabled = enabled, color = Color.Transparent,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                AiAgentBadge(agent, size = 25.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(session.displayTitle, style = MaterialTheme.typography.titleSmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                Icon(Icons.Outlined.Replay, "恢复历史会话", Modifier.size(17.dp), tint = TbColors.TextMuted)
            }
        }
        AiDivider(Modifier.padding(start = 43.dp))
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
