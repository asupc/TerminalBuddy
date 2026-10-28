package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiLaunchModel
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.historyProject

/** Tab 是工作台卡片的顶边，内容区和 Tab 共用同一个 Surface 与滚动容器。 */
@Composable
internal fun AiHomeWorkspace(
    ui: AiUiState, vm: AiViewModel, accounts: () -> Unit,
    delete: (AiSession) -> Unit, deleteAll: () -> Unit,
) {
    var tab by rememberSaveable(ui.activeAccountId) { mutableIntStateOf(0) }
    val quickListState = rememberLazyListState()
    val projectListState = rememberLazyListState()
    var configPath by rememberSaveable(ui.activeAccountId) { mutableStateOf<String?>(null) }
    var historyQuery by rememberSaveable(ui.activeAccountId) { mutableStateOf("") }
    var currentProjectOnly by rememberSaveable(ui.activeAccountId) { mutableStateOf(true) }
    var historyLimit by rememberSaveable(ui.activeAccountId, historyQuery, currentProjectOnly, ui.projectPath) { mutableIntStateOf(10) }
    LaunchedEffect(ui.connectionRevision) { configPath = null }
    val history = ui.history
    val matchingHistory = history.sessions.filter { session ->
        val projectMatches = !currentProjectOnly || ui.launchProject == null ||
            historyProject(listOfNotNull(ui.launchProject), session.projectDir) != null
        projectMatches && (historyQuery.isBlank() || session.title.contains(historyQuery.trim(), true) ||
            session.projectDir.contains(historyQuery.trim(), true))
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Dns, null, Modifier.size(20.dp), tint = TbColors.TextMuted)
            Column(Modifier.weight(1f).padding(start = 9.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(ui.username, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false))
                    AiStatusDot(TbColors.Accent)
                    Text("已登录", style = MaterialTheme.typography.labelMedium, color = TbColors.Accent)
                }
                Text(ui.server, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(accounts, enabled = !ui.working && !ui.authenticating) { Text("切换") }
        }
        Surface(Modifier.fillMaxWidth().weight(1f), shape = RoundedCornerShape(18.dp),
            color = TbColors.Surface, border = BorderStroke(1.dp, TbColors.Border)) {
            Column {
                AiWorkspaceTabs(tab) { tab = it }
                LazyColumn(Modifier.fillMaxWidth().weight(1f), state = if (tab == 0) quickListState else projectListState,
                    contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 16.dp, bottom = 12.dp)) {
                    if (tab == 0) {
                        item(key = "launch") { AiQuickStart(ui, vm) }
                        if (ui.launchProvider?.agent in listOf("claude", "pi")) {
                            item(key = "cli-history") {
                                AiHistorySection(ui, vm::toggleHistory, vm::resumeHistory)
                            }
                        } else {
                            item(key = "history-toggle") {
                                Spacer(Modifier.height(17.dp)); AiDivider()
                                Surface(onClick = vm::toggleCodexHistory, enabled = !ui.authenticating && !ui.working,
                                    modifier = Modifier.semantics { stateDescription = if (history.expanded) "已展开历史会话" else "已折叠历史会话" },
                                    color = TbColors.Surface) {
                                    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp), verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Icon(Icons.Outlined.History, null, Modifier.size(19.dp), tint = TbColors.TextMuted)
                                        Text("历史会话", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                                        Text("Codex", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                                        Icon(if (history.expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                                            null, Modifier.size(19.dp), tint = TbColors.TextMuted)
                                    }
                                }
                            }
                            if (history.expanded) {
                                item(key = "history-controls") {
                                    OutlinedTextField(historyQuery, { historyQuery = it }, Modifier.fillMaxWidth(), singleLine = true,
                                        label = { Text("搜索标题或项目路径") }, leadingIcon = { Icon(Icons.Outlined.Search, null) })
                                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                        FilterChip(currentProjectOnly, { currentProjectOnly = !currentProjectOnly },
                                            label = { Text("仅当前项目") }, enabled = ui.launchProject != null)
                                        Spacer(Modifier.weight(1f))
                                        Text("${matchingHistory.size} 段会话", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                                        IconButton(vm::loadCodexHistory, enabled = !history.loading) {
                                            if (history.loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                            else Icon(Icons.Outlined.Refresh, "刷新 Codex 历史", Modifier.size(20.dp))
                                        }
                                    }
                                    history.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger) }
                                    if (history.indexing) Text("首次扫描还有会话待补齐，可稍后刷新查看。", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                                    if (!history.loading && history.loaded && matchingHistory.isEmpty()) {
                                        Text("没有符合条件的 Codex 历史会话。", Modifier.padding(vertical = 15.dp),
                                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                                    }
                                }
                                items(matchingHistory.take(historyLimit), key = { "codex-history-${it.sessionId}" }) { session ->
                                    AiHistorySessionRow(session) { vm.openCodexHistory(session) }
                                }
                                if (matchingHistory.size > historyLimit) item(key = "history-more") {
                                    TextButton({ historyLimit += 10 }, Modifier.fillMaxWidth()) {
                                        Text("显示更多历史（剩余 ${matchingHistory.size - historyLimit} 段）")
                                    }
                                }
                            }
                        }
                        item(key = "recent-heading") {
                            AiDivider()
                            Row(Modifier.fillMaxWidth().padding(top = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("最近对话", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                                Text("${ui.sessions.size} 段对话", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                                TextButton(deleteAll, enabled = ui.sessions.any { !it.running } && !ui.loading && !ui.working,
                                    contentPadding = PaddingValues(horizontal = 6.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = TbColors.Danger)) {
                                    if (ui.deletingAll) CircularProgressIndicator(Modifier.size(15.dp), strokeWidth = 2.dp)
                                    else Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(15.dp))
                                    Spacer(Modifier.width(3.dp)); Text(if (ui.deletingAll) "删除中…" else "一键删除", style = MaterialTheme.typography.labelMedium)
                                }
                            }
                        }
                        if (ui.sessions.isEmpty()) item(key = "recent-empty") {
                            Text("还没有对话，选好项目和模型后开始吧。", Modifier.padding(vertical = 22.dp),
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                        }
                        items(ui.sessions, key = { "recent-${it.id}" }) { session ->
                            AiRecentSessionRow(ui, session, { vm.open(session.id) }, { delete(session) })
                        }
                    } else {
                        item(key = "projects-heading") {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("已配置项目", style = MaterialTheme.typography.titleMedium)
                                    Text("${ui.projects.size} 个项目 · 使用服务端已有配置", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                                }
                                IconButton(vm::refresh, enabled = !ui.loading && !ui.working) {
                                    if (ui.loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                    else Icon(Icons.Outlined.Refresh, "刷新服务端项目", Modifier.size(20.dp))
                                }
                            }
                        }
                        if (ui.projects.isEmpty()) item(key = "projects-empty") {
                            Text(if (ui.initialLoading) "正在同步项目和模型…" else "服务端还没有登记项目，请先在服务端添加后刷新。",
                                Modifier.padding(vertical = 24.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                        }
                        items(ui.projects, key = { "project-${it.path}" }) { project ->
                            AiServerProjectRow(ui, project) { configPath = project.path }
                        }
                        item(key = "projects-source") {
                            Text("项目与模型配置统一在服务端管理", Modifier.fillMaxWidth().padding(top = 15.dp),
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                        }
                    }
                }
            }
        }
    }
    ui.projects.find { it.path == configPath }?.let { project ->
        AiProjectConfigSheet(ui, project, { configPath = null }) { modelKey ->
            configPath = null
            vm.createFromProject(project.path, modelKey)
        }
    }
}

@Composable
private fun AiWorkspaceTabs(selected: Int, select: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().selectableGroup().background(TbColors.SurfaceHover)) {
        listOf("快速开始" to Icons.Outlined.Bolt, "服务端项目" to Icons.Outlined.FolderOpen).forEachIndexed { index, (label, icon) ->
            val active = selected == index
            Column(Modifier.weight(1f).background(if (active) TbColors.Surface else TbColors.SurfaceHover)
                .selectable(active, role = Role.Tab, onClick = { select(index) }), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.height(3.dp).width(28.dp).background(if (active) TbColors.Accent else TbColors.SurfaceHover,
                    RoundedCornerShape(bottomStart = 3.dp, bottomEnd = 3.dp)))
                Row(Modifier.heightIn(min = 51.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Icon(icon, null, Modifier.size(16.dp), tint = if (active) TbColors.Accent else TbColors.TextMuted)
                    Text(label, style = MaterialTheme.typography.labelLarge, color = if (active) TbColors.Accent else TbColors.TextMuted)
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(if (active) TbColors.Surface else TbColors.Border))
            }
        }
    }
}

internal fun agentTitle(agent: String) = when (agent) { "codex" -> "Codex"; "pi" -> "Pi"; else -> "Claude Code" }

internal fun modelChoices(models: List<AiLaunchModel>) = models.map { target ->
    val details = buildList {
        add(target.provider.name)
        if (target.provider.isDefault) add("服务端默认供应商")
        if (target.model.effort.isNotBlank()) add("推理等级：${target.model.effortLabel}")
    }
    AiChoice(target.key, target.model.title, details.joinToString(" · "))
}

@Composable
private fun AiQuickStart(ui: AiUiState, vm: AiViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("新对话", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            Button(vm::create, enabled = ui.canCreate, shape = RoundedCornerShape(11.dp), contentPadding = PaddingValues(horizontal = 12.dp),
                modifier = Modifier.heightIn(min = 46.dp)) {
                Icon(Icons.Outlined.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(5.dp)); Text("开始对话")
            }
        }
        AiChoiceField("项目", Icons.Outlined.FolderOpen, ui.projectPath, "选择项目",
            ui.projects.map { AiChoice(it.path, it.name, it.path) }, !ui.initialLoading && !ui.working, vm::selectProject)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AiChoiceField("Agent", Icons.Outlined.AutoAwesome, ui.launchProvider?.agent.orEmpty(), "选择 Agent",
                ui.availableAgents.map { AiChoice(it, agentTitle(it), agent = it) }, !ui.initialLoading && !ui.working,
                vm::selectAgent, Modifier.weight(1f))
            AiChoiceField("模型", Icons.Outlined.Tune, ui.launchModelKey, "选择模型", modelChoices(ui.availableModels),
                !ui.initialLoading && !ui.working, vm::selectModel, Modifier.weight(1f))
        }
        val hint = when {
            ui.initialLoading -> "正在同步项目和模型…"
            ui.projects.isEmpty() -> "服务端还没有登记项目，请添加后刷新。"
            ui.availableAgents.isEmpty() -> "该项目没有可用 Agent，请在服务端启用并配置模型。"
            ui.availableModels.isEmpty() -> "该 Agent 暂无可用模型，请在服务端配置。"
            else -> ui.launchProvider?.name?.let { "$it · ${ui.launchModel?.title.orEmpty()}" }
        }
        hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted) }
    }
}

@Composable
private fun AiRecentSessionRow(ui: AiUiState, session: AiSession, open: () -> Unit, delete: () -> Unit) {
    val projectName = ui.projects.find { it.path == session.projectPath }?.name
        ?: session.projectPath.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
    Surface(onClick = open, enabled = !ui.deletingAll && !ui.working, color = TbColors.Surface) {
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            AiAgentBadge(session.provider)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(session.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (session.id in ui.unviewedIds) Text(if (session.status == "idle") "已完成未查看" else "未查看",
                    style = MaterialTheme.typography.labelMedium, color = TbColors.Accent)
                if (session.running || session.status == "error" || session.status == "interrupted") Text(session.statusLabel,
                    style = MaterialTheme.typography.labelMedium, color = if (session.status == "error") TbColors.Danger else TbColors.Accent)
                Text("$projectName · ${session.targetLabel}", style = MaterialTheme.typography.bodySmall,
                    color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(delete, enabled = !session.running && !ui.working && !ui.deletingAll) {
                Icon(Icons.Outlined.DeleteOutline, "删除对话", Modifier.size(18.dp), tint = TbColors.TextMuted)
            }
        }
    }
    AiDivider(Modifier.padding(start = 40.dp))
}
