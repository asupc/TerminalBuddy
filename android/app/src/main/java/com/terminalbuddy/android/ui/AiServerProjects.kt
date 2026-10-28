package com.terminalbuddy.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.data.AiProject

@Composable
internal fun AiServerProjectRow(ui: AiUiState, project: AiProject, configure: () -> Unit) {
    val available = ui.projectModels(project).isNotEmpty()
    Column(Modifier.fillMaxWidth().padding(top = 17.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(39.dp).background(TbColors.Accent.copy(alpha = .1f), RoundedCornerShape(11.dp)),
                contentAlignment = Alignment.Center) { Icon(Icons.Outlined.FolderOpen, null, Modifier.size(22.dp), tint = TbColors.Accent) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(project.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(project.path, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (ui.projectPath == project.path) Text("当前选择", style = MaterialTheme.typography.labelMedium, color = TbColors.Accent)
        }
        Row(Modifier.padding(top = 9.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            project.enabledAgents.names.forEach { agent ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    AiAgentLogo(agent, Modifier.size(13.dp))
                    Text(agentTitle(agent), style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                }
            }
        }
        if (!available) Text(if (project.enabledAgents.names.isEmpty()) "服务端尚未启用 Agent" else "已启用的 Agent 暂无可用模型",
            Modifier.padding(top = 7.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
        Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(configure, enabled = !ui.working && !ui.initialLoading, contentPadding = PaddingValues(horizontal = 0.dp)) {
                Icon(Icons.Outlined.Tune, null, Modifier.size(16.dp)); Spacer(Modifier.width(5.dp)); Text("查看配置")
            }
            Spacer(Modifier.weight(1f))
            FilledTonalButton(configure, enabled = available && !ui.working && !ui.initialLoading, shape = RoundedCornerShape(10.dp)) {
                Icon(Icons.Outlined.Add, null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("开始对话")
            }
        }
        AiDivider()
    }
}

@Composable
internal fun AiProjectConfigSheet(ui: AiUiState, project: AiProject, dismiss: () -> Unit, start: (String) -> Unit) {
    val enabledAgents = project.enabledAgents.names
    var chosenAgent by rememberSaveable(ui.activeAccountId, project.path) {
        mutableStateOf(ui.launchProvider?.agent?.takeIf { it in enabledAgents } ?: enabledAgents.firstOrNull().orEmpty())
    }
    val agent = chosenAgent.takeIf { it in enabledAgents } ?: enabledAgents.firstOrNull().orEmpty()
    val models = ui.projectModels(project, agent)
    var chosenModel by rememberSaveable(ui.activeAccountId, project.path, agent) { mutableStateOf(ui.launchModelKey) }
    val target = models.find { it.key == chosenModel }
        ?: models.firstOrNull { it.provider.isDefault } ?: models.firstOrNull()
    AiSheet("项目配置", dismiss) {
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false).selectableGroup(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 13.dp)) {
            item(key = "project") {
                Text(project.name, style = MaterialTheme.typography.titleMedium)
                Text(project.path, Modifier.padding(top = 5.dp, bottom = 15.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                AiDivider()
                Text("已启用的 Agent", Modifier.padding(top = 15.dp, bottom = 9.dp), style = MaterialTheme.typography.titleSmall)
                if (enabledAgents.isEmpty()) Text("请先在服务端为该项目启用 Agent。", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    enabledAgents.forEach { id ->
                        Surface(onClick = { chosenAgent = id }, modifier = Modifier.weight(1f), shape = RoundedCornerShape(10.dp),
                            color = if (agent == id) TbColors.Accent.copy(alpha = .12f) else TbColors.SurfaceHover) {
                            Row(Modifier.heightIn(min = 46.dp).padding(horizontal = 5.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally)) {
                                AiAgentLogo(id, Modifier.size(16.dp))
                                Text(agentTitle(id), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("供应商与模型", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    Text("${models.size} 项配置", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                }
                if (models.isEmpty()) Text("该 Agent 暂无可用模型，请在服务端配置后刷新。", Modifier.padding(vertical = 16.dp),
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
            items(models, key = { it.key }) { option ->
                Row(Modifier.fillMaxWidth().selectable(option.key == target?.key, role = Role.RadioButton,
                    onClick = { chosenModel = option.key }).padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    RadioButton(option.key == target?.key, onClick = null)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(option.provider.name + if (option.provider.isDefault) " · 服务端默认" else "",
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                        Text(option.model.title, style = MaterialTheme.typography.titleSmall)
                        if (option.model.effort.isNotBlank()) Text("推理等级：${option.model.effortLabel}",
                            style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                    }
                }
                AiDivider()
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 10.dp, bottom = 20.dp)) {
            target?.let { Text("${project.name} · ${agentTitle(agent)} · ${it.provider.name}",
                Modifier.padding(bottom = 9.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted) }
            Button({ target?.let { start(it.key) } }, Modifier.fillMaxWidth(),
                colors = primaryButtonColors(), border = primaryControlBorder(),
                enabled = target != null && !ui.working && !ui.initialLoading, shape = RoundedCornerShape(11.dp)) {
                Icon(Icons.Outlined.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("使用此配置开始对话")
            }
        }
    }
}
