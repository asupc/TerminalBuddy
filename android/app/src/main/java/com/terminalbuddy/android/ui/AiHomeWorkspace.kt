package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiLaunchModel
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiProject

/** 快速开始聚焦创建会话，项目配置与近期会话作为次级入口。 */
@Composable
internal fun AiHomeWorkspace(ui: AiUiState, vm: AiViewModel, sessions: () -> Unit) {
    var showProjects by rememberSaveable(ui.activeAccountId) { mutableStateOf(false) }
    var configPath by rememberSaveable(ui.activeAccountId) { mutableStateOf<String?>(null) }
    LaunchedEffect(ui.connectionRevision) { configPath = null; showProjects = false }
    val recent = ui.sessions.sortedByDescending { it.updatedAt }.take(2)
    LazyColumn(
        Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item(key = "launch") { AiQuickStart(ui, vm) }
        item(key = "recent-heading") {
            AiSectionTitle("继续上次的对话") {
                TextButton(sessions) {
                    Text("查看全部")
                    Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp))
                }
            }
        }
        if (recent.isEmpty()) item(key = "recent-empty") {
            AiCard(shape = RoundedCornerShape(20.dp)) {
                AiEmptyState(Icons.Outlined.ChatBubbleOutline,
                    if (ui.initialLoading) "正在同步会话" else "第一段对话，从这里开始",
                    if (ui.initialLoading) "准备好后，你的近期会话会显示在这里。" else "选择项目与模型，开启你的新想法。")
            }
        }
        items(recent, key = { "recent-${it.id}" }) { session ->
            AiSessionCard(ui, session, open = { vm.open(session.id) })
        }
        item(key = "projects-heading") {
            AiSectionTitle("项目空间", "${ui.projects.size} 个项目来自当前服务") {
                TextButton({ showProjects = true }) {
                    Text("全部项目")
                    Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp))
                }
            }
        }
        if (ui.projects.isEmpty()) item(key = "projects-empty") {
            AiCard(shape = RoundedCornerShape(20.dp)) {
                AiEmptyState(Icons.Outlined.FolderOpen,
                    if (ui.initialLoading) "正在同步项目" else "还没有项目",
                    if (ui.initialLoading) "连接后将自动载入项目与模型。" else "在服务端登记项目后，即可在这里开始对话。")
            }
        }
        items(ui.projects.take(3), key = { "project-${it.path}" }) { project ->
            AiProjectTile(project, ui.projectPath == project.path, !ui.working && !ui.initialLoading) { configPath = project.path }
        }
    }
    if (showProjects) {
        AiSheet("项目空间", { showProjects = false }) {
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f, fill = false),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            ) {
                item {
                    AiSectionTitle("服务端项目", "项目与模型统一在服务端管理") {
                        IconButton(vm::refresh, enabled = !ui.loading && !ui.working) {
                            if (ui.loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            else Icon(Icons.Outlined.Refresh, "刷新项目", Modifier.size(22.dp))
                        }
                    }
                }
                if (ui.projects.isEmpty()) item {
                    AiEmptyState(Icons.Outlined.FolderOpen, "还没有项目", "在服务端登记项目后刷新查看。")
                }
                items(ui.projects, key = { it.path }) { project ->
                    AiServerProjectRow(ui, project) { showProjects = false; configPath = project.path }
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
    val agents = listOf("claude", "codex") + if ("pi" in ui.availableAgents) listOf("pi") else emptyList()
    val enabled = !ui.initialLoading && !ui.working && !ui.authenticating
    AiCard(shape = RoundedCornerShape(24.dp)) {
        // 整卡按 3/4 高度压缩：内边距、行距、行高与控件最小高度同步等比缩小。
        Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(15.dp)) {
            AiSectionTitle("开启新会话", "选好项目，交给你熟悉的助手", compact = true)
            AiChoiceField("工作项目", Icons.Outlined.FolderOpen, ui.projectPath, "选择一个项目",
                ui.projects.map { AiChoice(it.path, it.name, it.path) }, enabled, vm::selectProject, compact = true)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("选择助手", style = MaterialTheme.typography.labelMedium.copy(lineHeight = 13.sp), color = TbColors.TextMuted)
                AiAgentTabs(agents, ui.launchProvider?.agent.orEmpty(), vm::selectAgent,
                    enabledAgents = if (enabled) ui.availableAgents else emptyList(), compact = true)
            }
            AiChoiceField("使用模型", Icons.Outlined.Tune, ui.launchModelKey, "选择模型",
                modelChoices(ui.availableModels), enabled, vm::selectModel, compact = true)
            val hint = when {
                ui.initialLoading -> "正在同步项目和模型…"
                ui.projects.isEmpty() -> "请先在服务端登记项目。"
                ui.availableAgents.isEmpty() -> "该项目尚未配置可用助手，请在服务端配置模型。"
                ui.availableModels.isEmpty() -> "当前助手暂无可用模型，请在服务端配置。"
                else -> null
            }
            hint?.let {
                Text(it, style = MaterialTheme.typography.bodySmall.copy(lineHeight = 15.sp), color = TbColors.TextMuted)
            }
            Button(vm::create, enabled = ui.canCreate, shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp),
                contentPadding = PaddingValues(horizontal = 15.dp, vertical = 12.dp)) {
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

@Composable
private fun AiProjectTile(project: AiProject, current: Boolean, enabled: Boolean, open: () -> Unit) {
    Surface(onClick = open, enabled = enabled, color = TbColors.Surface, shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, TbColors.Border)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 80.dp).padding(16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AiSmallIcon(Icons.Outlined.FolderOpen)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(project.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(project.path, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (current) Text("当前", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(19.dp), tint = TbColors.TextMuted)
        }
    }
}
