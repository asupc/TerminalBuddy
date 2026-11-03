package com.terminalbuddy.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiLaunchModel
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel

/** 快速开始聚焦创建会话，近期会话作为次级入口。 */
@Composable
internal fun AiHomeWorkspace(ui: AiUiState, vm: AiViewModel, sessions: () -> Unit, more: () -> Unit) {
    val recent = ui.recentSessions
    LazyColumn(
        Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item(key = "launch") { AiQuickStart(ui, vm, more) }
        // 标题与卡片间距在上次减三分之一（20 → 13）的基础上再减半（→ 6.5）；卡片之间减三分之一（20 → 13）。
        item(key = "recent") {
            Column(verticalArrangement = Arrangement.spacedBy(6.5.dp)) {
                AiSectionTitle("最近任务") {
                    TextButton(sessions) {
                        Text("查看全部")
                        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp))
                    }
                }
                if (recent.isEmpty()) {
                    AiCard(shape = RoundedCornerShape(20.dp)) {
                        AiEmptyState(Icons.Outlined.ChatBubbleOutline,
                            if (ui.initialLoading) "正在同步会话" else "第一段对话，从这里开始",
                            if (ui.initialLoading) "准备好后，你的近期会话会显示在这里。" else "选择项目与模型，开启你的新想法。")
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(13.dp)) {
                        recent.forEach { session ->
                            AiSessionCard(ui, session, open = { vm.open(session.id) }, compact = true)
                        }
                    }
                }
            }
        }
    }
}

internal fun agentTitle(agent: String) = when (agent) { "codex" -> "Codex"; else -> "Claude Code" }

internal fun modelChoices(models: List<AiLaunchModel>) = models.map { target ->
    val details = buildList {
        add(target.provider.name)
        if (target.provider.isDefault) add("服务端默认供应商")
        if (target.model.effort.isNotBlank()) add("推理等级：${target.model.effortLabel}")
    }
    AiChoice(target.key, target.model.title, details.joinToString(" · "))
}

@Composable
private fun AiQuickStart(ui: AiUiState, vm: AiViewModel, more: () -> Unit) {
    // 同步期间以常见助手占位；完成后只保留项目已启用且服务端 Agent 管理中已安装的助手。
    val agents = if (ui.initialLoading) listOf("claude", "codex")
        else ui.availableAgents
    // 只剩一个助手时不再提供选择，标志直接并入开始按钮。
    val singleAgent = !ui.initialLoading && agents.size == 1
    val enabled = !ui.initialLoading && !ui.working && !ui.authenticating
    AiCard(shape = RoundedCornerShape(24.dp)) {
        // 整卡按 3/4 高度压缩：内边距、行距、行高与控件最小高度同步等比缩小。
        Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(15.dp)) {
            AiSectionTitle("开启新会话", compact = true) {
                IconButton(more, modifier = Modifier.size(32.dp), enabled = ui.authenticated && !ui.authenticating) {
                    Icon(Icons.Outlined.MoreHoriz, "更多服务端项目配置", Modifier.size(22.dp), tint = TbColors.TextMuted)
                }
            }
            AiChoiceField("工作项目", Icons.Outlined.FolderOpen, ui.projectPath, "选择一个项目",
                ui.projects.map { AiChoice(it.path, it.name, it.path) }, enabled, vm::selectProject,
                compact = true, inlineLabel = true)
            if (agents.isNotEmpty() && !singleAgent) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("选择助手", style = MaterialTheme.typography.labelMedium.copy(lineHeight = 13.sp), color = TbColors.TextMuted)
                AiAgentTabs(agents, ui.launchProvider?.agent.orEmpty(), vm::selectAgent,
                    enabledAgents = if (enabled) ui.availableAgents else emptyList(), stacked = true)
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
                Text(it, style = MaterialTheme.typography.bodySmall.copy(lineHeight = 15.sp), color = TbColors.TextMuted)
            }
            Button(vm::create, enabled = ui.canCreate, shape = RoundedCornerShape(12.dp),
                colors = primaryButtonColors(), border = primaryControlBorder(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp),
                contentPadding = PaddingValues(horizontal = 15.dp, vertical = 12.dp)) {
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
