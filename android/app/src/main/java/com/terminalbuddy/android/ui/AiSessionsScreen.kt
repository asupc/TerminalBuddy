package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.historyProject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 会话分类独立于快速开始的助手选择，查找会话不会改动启动配置。 */
@Composable
internal fun AiSessionsScreen(
    ui: AiUiState, vm: AiViewModel, start: () -> Unit,
    delete: (AiSession) -> Unit, deleteAll: () -> Unit,
) {
    var agent by rememberSaveable(ui.activeAccountId) { mutableStateOf(ui.launchProvider?.agent ?: "claude") }
    var query by rememberSaveable(ui.activeAccountId) { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var projectOnly by rememberSaveable(ui.activeAccountId) { mutableStateOf(false) }
    var historyLimit by rememberSaveable(ui.activeAccountId, query, projectOnly, ui.projectPath) { mutableIntStateOf(10) }
    val agents = listOf("claude", "codex") + if (agent == "pi" || ui.providers.any { it.agent == "pi" } || ui.sessions.any { it.provider == "pi" }) listOf("pi") else emptyList()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val needle = query.trim()
    val sessions = ui.sessions.filter { session ->
        session.provider == agent && (needle.isEmpty() || session.title.contains(needle, true) ||
            session.projectPath.contains(needle, true) || session.targetLabel.contains(needle, true))
    }.sortedByDescending { it.updatedAt }
    val history = ui.history
    val matchingHistory = history.sessions.filter { session ->
        (!projectOnly || ui.launchProject == null || historyProject(listOfNotNull(ui.launchProject), session.projectDir) != null) &&
            (needle.isEmpty() || session.displayTitle.contains(needle, true) || session.projectDir.contains(needle, true))
    }
    LazyColumn(Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item(key = "agent-filter") { AiAgentTabs(agents, agent, { agent = it }) }
        item(key = "search") {
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(),
                placeholder = { Text("搜索会话或项目") }, singleLine = true, shape = RoundedCornerShape(16.dp),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide(); focus.clearFocus() }),
                leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(21.dp)) },
                trailingIcon = {
                    if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Icons.Outlined.Close, "清空搜索", Modifier.size(20.dp)) }
                })
        }
        item(key = "summary") {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                val unread = sessions.count { it.id in ui.unviewedIds }
                Text("${sessions.size} 段会话${if (unread > 0) " · $unread 段有更新" else ""}", Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                Box {
                    IconButton({ menu = true }) { Icon(Icons.Outlined.MoreHoriz, "更多会话操作", tint = TbColors.TextMuted) }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text(if (ui.deletingAll) "正在清理…" else "清理全部空闲会话") },
                            leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(20.dp)) },
                            enabled = ui.sessions.any { !it.running } && !ui.loading && !ui.working && !ui.deletingAll,
                            onClick = { menu = false; deleteAll() })
                    }
                }
            }
        }
        if (ui.initialLoading && sessions.isEmpty()) item(key = "loading") {
            AiCard(shape = RoundedCornerShape(20.dp)) {
                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("正在同步会话…", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                }
            }
        } else if (sessions.isEmpty()) item(key = "empty") {
            AiCard(shape = RoundedCornerShape(20.dp)) {
                AiEmptyState(Icons.Outlined.ChatBubbleOutline,
                    if (needle.isNotEmpty()) "没有找到相关会话" else "还没有 ${if (agent == "claude") "Claude" else agentTitle(agent)} 会话",
                    if (needle.isNotEmpty()) "换个关键词试试，或查看下方服务端历史。" else "从一个问题开始，和你的助手一起把想法变成现实。") {
                    TextButton({ if (needle.isNotEmpty()) query = "" else start() }) {
                        Text(if (needle.isNotEmpty()) "清空搜索" else "开启新会话")
                    }
                }
            }
        }
        items(sessions, key = { "session-${it.id}" }) { session ->
            AiSessionCard(ui, session, { vm.open(session.id) }, { delete(session) })
        }
        item(key = "history-heading") {
            AiSectionTitle("服务端历史", "继续在电脑上开始的对话", modifier = Modifier.padding(top = 12.dp))
        }
        if (agent == "codex") {
            item(key = "codex-history-toggle") {
                Surface(onClick = vm::toggleCodexHistory, enabled = !ui.working && !ui.authenticating,
                    color = TbColors.Surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, TbColors.Border)) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(Icons.Outlined.History, null, Modifier.size(21.dp), tint = TbColors.TextMuted)
                        Text("Codex 历史会话", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        Icon(if (history.expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                            if (history.expanded) "收起历史" else "展开历史", Modifier.size(21.dp), tint = TbColors.TextMuted)
                    }
                }
            }
            if (history.expanded) {
                item(key = "history-controls") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            FilterChip(projectOnly, { projectOnly = !projectOnly }, label = { Text("仅当前项目") }, enabled = ui.launchProject != null)
                            Spacer(Modifier.weight(1f))
                            Text("${matchingHistory.size} 段", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                            IconButton(vm::loadCodexHistory, enabled = !history.loading && !ui.working) {
                                if (history.loading) CircularProgressIndicator(Modifier.size(19.dp), strokeWidth = 2.dp)
                                else Icon(Icons.Outlined.Refresh, "刷新历史", Modifier.size(21.dp))
                            }
                        }
                        if (projectOnly) AiChoiceField("历史项目", Icons.Outlined.FolderOpen, ui.projectPath, "选择项目",
                            ui.projects.map { AiChoice(it.path, it.name, it.path) }, !ui.working, vm::selectProject)
                        history.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger) }
                        if (history.indexing) Text("首次扫描仍在补齐历史，可稍后刷新。", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                        if (!history.loading && history.loaded && matchingHistory.isEmpty()) Text("暂无符合条件的历史会话。",
                            Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
                items(matchingHistory.take(historyLimit), key = { "history-${it.sessionId}" }) { session ->
                    AiCard(shape = RoundedCornerShape(16.dp)) {
                        Box(Modifier.padding(horizontal = 14.dp)) { AiHistorySessionRow(session) { vm.openCodexHistory(session) } }
                    }
                }
                if (matchingHistory.size > historyLimit) item(key = "history-more") {
                    TextButton({ historyLimit += 10 }, Modifier.fillMaxWidth()) { Text("加载更多历史会话") }
                }
            }
        } else {
            item(key = "cli-history") {
                AiCard(shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        val projects = ui.projects.filter { project -> ui.projectModels(project, agent).isNotEmpty() }
                        AiChoiceField("历史项目", Icons.Outlined.FolderOpen, ui.projectPath, "选择项目",
                            projects.map { AiChoice(it.path, it.name, it.path) }, !ui.working && !ui.authenticating, vm::selectProject)
                        if (ui.launchProvider?.agent == agent) {
                            val historyUi = ui.copy(historySessions = if (ui.historyLoading) emptyList() else ui.historySessions.filter {
                                needle.isEmpty() || it.displayTitle.contains(needle, true) || it.projectDir.contains(needle, true)
                            })
                            AiHistorySection(historyUi, vm::toggleHistory, vm::resumeHistory)
                        } else {
                            TextButton({
                                vm.selectAgent(agent)
                                if (!ui.historyExpanded) vm.toggleHistory()
                            }, enabled = agent in ui.availableAgents && !ui.working && !ui.authenticating,
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                                Icon(Icons.Outlined.History, null, Modifier.size(19.dp))
                                Spacer(Modifier.width(8.dp))
                                Text("查看 ${agentTitle(agent)} 历史")
                            }
                            if (agent !in ui.availableAgents) Text("选择已配置该助手的项目后，可查看服务端历史。",
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                        }
                    }
                }
            }
        }
    }
}

/** 同一会话卡片用于首页预览和完整列表，状态、未读和时间保持一致；compact 为首页的四分之三高度版本。 */
@Composable
internal fun AiSessionCard(
    ui: AiUiState, session: AiSession, open: () -> Unit, delete: (() -> Unit)? = null, compact: Boolean = false,
) {
    var menu by remember(session.id) { mutableStateOf(false) }
    val projectName = ui.projects.find { it.path == session.projectPath }?.name
        ?: session.projectPath.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
    val unread = session.id in ui.unviewedIds
    Surface(onClick = open, enabled = !ui.working && !ui.deletingAll, color = TbColors.Surface,
        shape = RoundedCornerShape(if (compact) 15.dp else 20.dp), border = BorderStroke(1.dp, TbColors.Border)) {
        Column(
            Modifier.fillMaxWidth().padding(if (compact) 12.dp else 16.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 9.dp else 12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 10.dp)) {
                AiAgentBadge(session.provider, size = if (compact) 23.dp else 30.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 3.dp)) {
                    Text(session.title, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleSmall.copy(lineHeight = if (compact) 17.sp else 22.sp))
                    Text(projectName.ifBlank { "未命名项目" }, color = TbColors.TextMuted, maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall.copy(lineHeight = if (compact) 15.sp else 20.sp))
                }
                if (delete == null) Icon(Icons.Outlined.ChevronRight, null,
                    Modifier.size(if (compact) 15.dp else 20.dp), tint = TbColors.TextMuted)
                else Box {
                    IconButton({ menu = true }, enabled = !ui.working && !ui.deletingAll) {
                        Icon(Icons.Outlined.MoreHoriz, "会话操作", Modifier.size(if (compact) 15.dp else 20.dp), tint = TbColors.TextMuted)
                    }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("删除会话") }, enabled = !session.running && !ui.working && !ui.deletingAll,
                            leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(20.dp)) },
                            onClick = { menu = false; delete() })
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val status = when {
                    session.running || session.status in listOf("error", "interrupted") -> session.statusLabel
                    unread -> "有新进展"
                    else -> session.providerLabel
                }
                Text(status, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 14.sp else 18.sp),
                    color = if (session.status == "error") TbColors.Danger else if (unread || session.running) TbColors.Text else TbColors.TextMuted)
                Text("·", color = TbColors.TextMuted, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 14.sp else 18.sp))
                Text(session.modelLabel, Modifier.weight(1f), color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall.copy(lineHeight = if (compact) 15.sp else 20.sp))
                Text(sessionTime(session.updatedAt),
                    style = MaterialTheme.typography.labelSmall.copy(lineHeight = if (compact) 13.sp else 16.sp),
                    color = TbColors.TextMuted)
            }
        }
    }
}

private fun sessionTime(timestamp: Long): String {
    if (timestamp <= 0) return ""
    val minutes = ((System.currentTimeMillis() - timestamp).coerceAtLeast(0) / 60_000)
    return when {
        minutes == 0L -> "刚刚"
        minutes < 60 -> "${minutes} 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        else -> SimpleDateFormat("MM-dd", Locale.CHINA).format(Date(timestamp))
    }
}
