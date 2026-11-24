package com.terminalbuddy.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiServerHistoryKey
import com.terminalbuddy.android.AiServerProjectHistory
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiHistorySession
import com.terminalbuddy.android.data.AiProject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val SERVER_SESSION_TIME_FORMATTER = DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault())

/** 助手按服务端安装状态展示；项目默认收起，展开后按项目懒加载，历史记录由外层惰性列表承载。 */
@Composable
internal fun AiServerSessionsScreen(ui: AiUiState, vm: AiViewModel) {
    val agents = listOf("claude", "codex")
    var selectedAgent by rememberSaveable(ui.activeAccountId) { mutableStateOf("claude") }
    val agent = selectedAgent.takeIf { it in agents } ?: agents.first()
    var resumingId by remember(ui.activeAccountId) { mutableStateOf<String?>(null) }
    LaunchedEffect(ui.working) { if (!ui.working) resumingId = null }
    var limits by rememberSaveable(ui.activeAccountId, agent) { mutableStateOf(mapOf<String, Int>()) }
    val projects = ui.projects.distinctBy { it.path }
    val listState = rememberSaveable(ui.activeAccountId, agent, saver = LazyListState.Saver) { LazyListState() }
    LaunchedEffect(agent, ui.activeAccountId, ui.connectionRevision) {
        vm.reloadExpandedServerHistory(agent)
    }
    Column(Modifier.fillMaxSize()) {
        // 不再显示「服务端历史」标题行，直接从 Claude / Codex 助手切换开始。
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 16.dp, bottom = 12.dp),
        ) {
            AiServerAgentTabs(agents, agent) { selectedAgent = it }
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f), state = listState,
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (ui.initialLoading && projects.isEmpty()) item(key = "loading-projects") {
                AiCard(shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text("正在同步服务端项目…", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
            } else if (projects.isEmpty()) item(key = "empty-projects") {
                AiCard(shape = RoundedCornerShape(16.dp)) {
                    AiEmptyState(Icons.Outlined.FolderOpen, "还没有服务端项目", "请先在服务端登记项目，随后可在这里查看历史会话。")
                }
            }
            projects.forEach { project ->
                val history = ui.serverHistory[AiServerHistoryKey(agent, project.path)] ?: AiServerProjectHistory()
                item(key = "project:$agent:${project.path}") {
                    AiServerHistoryProjectCard(
                        project = project, agent = agent, history = history,
                        limit = limits[project.path] ?: 10, resumingId = resumingId, ui = ui,
                        toggle = { vm.toggleServerHistory(agent, project.path) },
                        load = { vm.loadServerHistory(agent, project.path) },
                        more = { limits = limits + (project.path to (limits[project.path] ?: 10) + 10) },
                        open = { session ->
                            resumingId = session.sessionId
                            vm.resumeServerHistory(agent, project, session)
                        },
                    )
                }
            }
            if (projects.isNotEmpty()) item(key = "projects-foot") {
                Text(
                    "共 ${projects.size} 个项目 · 历史记录来自服务端转录",
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * 智能体切换：图标 + 名称的下划线标签，与板块一级切换（顶部文字标签）区分层级。
 * 服务端板块的助手只决定「看谁的历史」，不影响快速开始里的选择。
 */
@Composable
private fun AiServerAgentTabs(agents: List<String>, selected: String, select: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        agents.forEach { choice ->
            val active = choice == selected
            val ink = if (active) TbColors.Text else TbColors.TextSoft
            Column(
                Modifier
                    .selectable(selected = active, role = Role.Tab, onClick = { select(choice) })
                    .padding(top = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    AiAgentLogo(choice, Modifier.size(15.dp), tint = ink)
                    Text(
                        if (choice == "claude") "Claude" else agentTitle(choice), maxLines = 1,
                        style = MaterialTheme.typography.labelMedium.copy(
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                        ),
                        color = ink,
                    )
                }
                // 固定宽度的短线：选中时点亮，未选中留透明占位，切换时行高与列宽都不跳动。
                Box(
                    Modifier.width(18.dp).height(2.dp)
                        .background(if (active) TbColors.Accent else Color.Transparent, RoundedCornerShape(1.dp)),
                )
            }
        }
    }
}

/** 一个项目 = 一张折叠卡：标题行回答「哪个项目」，展开后列出可续接的历史会话。
 * 层级与「服务端项目与配置」弹窗一致，只把明细换成历史记录行。
 */
@Composable
private fun AiServerHistoryProjectCard(
    project: AiProject, agent: String, history: AiServerProjectHistory, limit: Int,
    resumingId: String?, ui: AiUiState,
    toggle: () -> Unit, load: () -> Unit, more: () -> Unit, open: (AiHistorySession) -> Unit,
) {
    val busy = ui.working || ui.authenticating
    val resumable = ui.projectModels(project, agent).isNotEmpty()
    val shown = history.sessions.take(limit)
    AiProjectAccordion(
        name = project.name, path = project.path, expanded = history.expanded, enabled = !busy,
        count = if (history.loaded) "${history.sessions.size} 段" else null,
        toggle = toggle,
    ) {
        history.error?.let { error ->
            Column(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("历史会话加载失败", style = MaterialTheme.typography.titleSmall)
                Text(error, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                TextButton({ load() }, enabled = !history.loading && !busy, contentPadding = PaddingValues(0.dp)) {
                    Text("重新加载")
                }
            }
            AiDivider()
        }
        if (history.loading && shown.isEmpty()) Text(
            "正在读取 ${agentTitle(agent)} 历史…", Modifier.padding(vertical = 14.dp),
            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
        )
        if (history.loaded && history.sessions.isEmpty() && history.error == null) Text(
            "暂无 ${agentTitle(agent)} 历史会话", Modifier.padding(vertical = 14.dp),
            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
        )
        if (!resumable && history.sessions.isNotEmpty()) Text(
            if (!project.enabledAgents.enabled(agent)) "该项目尚未启用 ${agentTitle(agent)}，启用后可继续历史对话。"
            else "该项目暂无可用模型，请先在服务端配置。",
            Modifier.padding(vertical = 10.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
        )
        shown.forEachIndexed { index, session ->
            AiAccordionRow(
                enabled = !busy && resumable,
                // 最后一行不再画分隔线，避免和卡片底边形成双线；后面还有「加载更多」时保留。
                showDivider = index < shown.lastIndex || history.sessions.size > limit,
                trailing = {
                    if (ui.working && resumingId == session.sessionId) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = TbColors.TextMuted)
                    } else {
                        Icon(
                            Icons.Outlined.Replay, "继续历史对话",
                            Modifier.size(18.dp), tint = TbColors.TextMuted,
                        )
                    }
                },
                onClick = { open(session) },
            ) {
                Text(session.displayTitle, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    buildList {
                        add("${session.messageCount} 条消息")
                        if (session.updatedAt > 0) add(SERVER_SESSION_TIME_FORMATTER.format(Instant.ofEpochMilli(session.updatedAt)))
                        session.model?.takeIf(String::isNotBlank)?.let(::add)
                    }.joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (history.sessions.size > limit) TextButton(
            more, modifier = Modifier.fillMaxWidth().padding(top = 2.dp), contentPadding = PaddingValues(vertical = 6.dp),
        ) {
            Text("加载更多（还有 ${history.sessions.size - limit} 段）", style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.width(4.dp))
            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
        }
    }
}
