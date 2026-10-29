package com.terminalbuddy.android.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiServerHistoryKey
import com.terminalbuddy.android.AiServerProjectHistory
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiHistorySession
import com.terminalbuddy.android.data.AiProject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 助手按服务端安装状态展示；项目默认收起，展开后按项目懒加载，历史记录仍使用外层惰性列表。 */
@Composable
internal fun AiServerSessionsScreen(ui: AiUiState, vm: AiViewModel) {
    val agents = listOf("claude", "codex", "pi").filter(ui::agentInstalled)
    var selectedAgent by rememberSaveable(ui.activeAccountId) { mutableStateOf("claude") }
    val agent = selectedAgent.takeIf { it in agents } ?: agents.firstOrNull()
    var resumingId by remember(ui.activeAccountId) { mutableStateOf<String?>(null) }
    LaunchedEffect(ui.working) { if (!ui.working) resumingId = null }
    var limits by rememberSaveable(ui.activeAccountId, agent) { mutableStateOf(mapOf<String, Int>()) }
    val projects = ui.projects.distinctBy { it.path }
    val listState = rememberSaveable(ui.activeAccountId, agent, saver = LazyListState.Saver) { LazyListState() }
    LaunchedEffect(agent, ui.activeAccountId, ui.connectionRevision) {
        if (agent != null) vm.reloadExpandedServerHistory(agent)
    }
    Column(Modifier.fillMaxSize()) {
        if (agent == null) {
            AiCard(Modifier.fillMaxWidth().padding(20.dp), shape = RoundedCornerShape(14.dp)) {
                AiEmptyState(Icons.Outlined.SmartToy, "暂无已安装的智能体", "请先在服务端 Agent 管理中安装助手，再查看历史会话。")
            }
            return@Column
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 20.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("服务端历史", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                Text("按项目归档", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
            }
            Row(
                Modifier.fillMaxWidth().selectableGroup()
                    .background(TbColors.Surface, RoundedCornerShape(12.dp))
                    .border(1.dp, TbColors.BorderSoft, RoundedCornerShape(12.dp))
                    .padding(3.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                agents.forEach { choice ->
                    val selected = choice == agent
                    val ink = if (selected) TbColors.Text else TbColors.TextSoft
                    Tab(
                        selected = selected,
                        onClick = { selectedAgent = choice },
                        modifier = Modifier.weight(1f).clip(RoundedCornerShape(9.dp))
                            .background(if (selected) TbColors.SurfaceHover else Color.Transparent),
                        selectedContentColor = TbColors.Text,
                        unselectedContentColor = TbColors.TextSoft,
                    ) {
                        Row(
                            Modifier.heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                        ) {
                            AiAgentLogo(choice, Modifier.size(16.dp), tint = ink)
                            Text(
                                if (choice == "claude") "Claude" else agentTitle(choice),
                                Modifier.weight(1f, fill = false),
                                style = MaterialTheme.typography.labelLarge.copy(
                                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                ),
                                color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f), state = listState,
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item(key = "projects-heading") {
                Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("服务端项目", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                    Text("${projects.size} 个项目", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                }
            }
            if (ui.initialLoading && projects.isEmpty()) item(key = "loading-projects") {
                AiCard(shape = RoundedCornerShape(14.dp)) {
                    Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text("正在同步服务端项目…", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
            } else if (projects.isEmpty()) item(key = "empty-projects") {
                AiCard(shape = RoundedCornerShape(14.dp)) {
                    AiEmptyState(Icons.Outlined.FolderOpen, "还没有服务端项目", "请先在当前服务端登记项目，随后可在这里查看历史会话。")
                }
            }
            projects.forEach { project ->
                val history = ui.serverHistory[AiServerHistoryKey(agent, project.path)] ?: AiServerProjectHistory()
                val prefix = "$agent:${project.path.length}:${project.path}"
                item(key = "project:$prefix") {
                    AiHistoryProjectHeader(project, history, !ui.working && !ui.authenticating) {
                        vm.toggleServerHistory(agent, project.path)
                    }
                }
                if (history.expanded) {
                    item(key = "controls:$prefix") {
                        Row(Modifier.fillMaxWidth().padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(when {
                                history.loading && !history.loaded -> "正在同步历史会话…"
                                history.loaded -> "${history.sessions.size} 段会话 · 最近更新优先"
                                else -> "项目历史会话"
                            }, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                            IconButton({ vm.loadServerHistory(agent, project.path) }, enabled = !history.loading && !ui.working && !ui.authenticating) {
                                if (history.loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                else Icon(Icons.Outlined.Refresh, "刷新${project.name}的历史会话", Modifier.size(20.dp), tint = TbColors.TextMuted)
                            }
                        }
                    }
                    history.error?.let { error -> item(key = "error:$prefix") {
                        Surface(Modifier.fillMaxWidth().padding(start = 12.dp), color = TbColors.Surface, shape = RoundedCornerShape(14.dp)) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("历史会话加载失败", style = MaterialTheme.typography.titleSmall)
                                Text(error, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                                TextButton({ vm.loadServerHistory(agent, project.path) }, enabled = !history.loading && !ui.working && !ui.authenticating) {
                                    Text("重新加载")
                                }
                            }
                        }
                    } }
                    if (history.loaded && history.sessions.isEmpty() && history.error == null) item(key = "empty:$prefix") {
                        Surface(Modifier.padding(start = 12.dp), color = TbColors.Surface, shape = RoundedCornerShape(14.dp)) {
                            AiEmptyState(Icons.Outlined.History, "暂无 ${agentTitle(agent)} 历史会话", "在服务端使用该助手进行对话后，可刷新查看记录。")
                        }
                    }
                    val canResume = ui.projectModels(project, agent).isNotEmpty()
                    if (agent != "codex" && !canResume && history.sessions.isNotEmpty()) item(key = "configuration:$prefix") {
                        Text(if (!project.enabledAgents.enabled(agent)) "该项目尚未启用 ${agentTitle(agent)}，启用后可继续历史对话。"
                            else "该项目暂无可用模型，请先在服务端配置。",
                            Modifier.padding(start = 14.dp, bottom = 4.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                    val limit = limits[project.path] ?: 10
                    items(history.sessions.take(limit), key = { "session:$prefix:${it.sessionId}" }) { session ->
                        AiServerHistoryCard(
                            agent, session, enabled = !ui.working && !ui.authenticating && (agent == "codex" || canResume),
                            loading = ui.working && resumingId == session.sessionId,
                            open = {
                                if (agent == "codex") vm.openCodexHistory(session)
                                else {
                                    resumingId = session.sessionId
                                    vm.resumeServerHistory(agent, project, session)
                                }
                            },
                        )
                    }
                    if (history.sessions.size > limit) item(key = "more:$prefix") {
                        TextButton({ limits = limits + (project.path to limit + 10) },
                            modifier = Modifier.fillMaxWidth().padding(start = 12.dp)) {
                            Text("加载更多（还有 ${history.sessions.size - limit} 段）")
                            Spacer(Modifier.width(4.dp))
                            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(18.dp))
                        }
                    }
                    item(key = "space:$prefix") { Spacer(Modifier.height(6.dp)) }
                }
            }
        }
    }
}

@Composable
private fun AiHistoryProjectHeader(project: AiProject, history: AiServerProjectHistory, enabled: Boolean, toggle: () -> Unit) {
    val rotation by animateFloatAsState(if (history.expanded) 180f else 0f, label = "项目展开箭头")
    Surface(
        onClick = toggle, enabled = enabled,
        modifier = Modifier.fillMaxWidth().semantics { stateDescription = if (history.expanded) "已展开" else "已折叠" },
        color = if (history.expanded) TbColors.Accent.copy(alpha = .05f) else TbColors.Surface,
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, if (history.expanded) TbColors.Accent.copy(alpha = .3f) else TbColors.Border),
    ) {
        Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(34.dp).background(TbColors.SurfaceHover, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                Icon(if (history.expanded) Icons.Outlined.FolderOpen else Icons.Outlined.Folder, null, Modifier.size(20.dp), tint = TbColors.Accent)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(project.name, style = MaterialTheme.typography.titleSmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(project.path, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (history.loaded) Text("${history.sessions.size} 段", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
            Icon(Icons.Outlined.ExpandMore, if (history.expanded) "收起项目历史" else "展开项目历史",
                Modifier.size(22.dp).rotate(rotation), tint = TbColors.TextMuted)
        }
    }
}

@Composable
private fun AiServerHistoryCard(agent: String, session: AiHistorySession, enabled: Boolean, loading: Boolean, open: () -> Unit) {
    Surface(
        onClick = open, enabled = enabled,
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp).alpha(if (enabled || loading) 1f else .55f),
        color = TbColors.Canvas, shape = RoundedCornerShape(10.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AiAgentBadge(agent, size = 26.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(session.displayTitle, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val details = buildList {
                    add("${session.messageCount} 条消息")
                    if (session.updatedAt > 0) add(SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(Date(session.updatedAt)))
                    session.model?.takeIf(String::isNotBlank)?.let { add(it) }
                }
                Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Icon(if (agent == "codex") Icons.Outlined.ChevronRight else Icons.Outlined.Replay,
                if (agent == "codex") "查看历史记录" else "继续历史对话", Modifier.size(20.dp), tint = TbColors.TextMuted)
        }
    }
}
