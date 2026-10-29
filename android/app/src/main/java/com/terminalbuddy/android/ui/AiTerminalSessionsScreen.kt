package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.data.ServerProfile
import com.terminalbuddy.android.data.ServerTerminal

/** 只展示现有服务端终端；打开、刷新与配置管理沿用同一个账号绑定的 ViewModel。 */
@Composable
internal fun AiTerminalSessionsScreen(ui: ServerTerminalUiState, vm: ServerTerminalViewModel) {
    val busy = ui.launchingId != null
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item(key = "heading") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("已打开的终端", style = MaterialTheme.typography.titleSmall)
                    Text(if (ui.loaded) "${ui.terminals.size} 个终端" else "读取当前服务的终端",
                        style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                }
                IconButton(vm::refresh, enabled = !ui.loading && !busy) {
                    Icon(Icons.Outlined.Refresh, "刷新终端列表", Modifier.size(20.dp), tint = TbColors.TextMuted)
                }
                TextButton(vm::showConfigurations, enabled = !busy) {
                    Icon(Icons.Outlined.Add, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("新建终端", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
        if (ui.loading) item(key = "loading") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                if (!ui.loaded) Text("正在同步终端与项目配置…", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
        }
        ui.error?.let { error -> item(key = "error") {
            Surface(color = TbColors.Danger.copy(alpha = .08f), shape = RoundedCornerShape(14.dp)) {
                Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("终端列表同步失败", style = MaterialTheme.typography.titleSmall)
                    Text(error, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                    TextButton(vm::refresh, enabled = !ui.loading && !busy) { Text("重新加载") }
                }
            }
        } }
        if (ui.loaded && ui.terminals.isEmpty() && ui.error == null) item(key = "empty") {
            AiEmptyState(Icons.Outlined.Terminal, "还没有打开的终端", "从服务端项目配置中选择一个配置，打开终端后就会显示在这里。") {
                TextButton(vm::showConfigurations, enabled = !busy) { Text("查看项目配置") }
            }
        }
        items(ui.terminals, key = { "terminal:${it.id}" }) { terminal ->
            AiTerminalSessionRow(terminal, ui.profiles.find { it.id == terminal.profileId }, !busy) { vm.open(terminal) }
        }
        if (ui.terminals.isNotEmpty()) item(key = "hint") {
            Text("离开页面后，终端继续保持运行。", Modifier.fillMaxWidth().padding(top = 4.dp),
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

@Composable
private fun AiTerminalSessionRow(terminal: ServerTerminal, profile: ServerProfile?, enabled: Boolean, open: () -> Unit) {
    val type = terminal.terminalType.ifBlank { profile?.terminalType.orEmpty() }
    val typeName = when (type.lowercase()) {
        "powershell", "pwsh" -> "PowerShell"
        "cmd" -> "CMD"
        "ssh" -> "SSH"
        "docker" -> "Docker"
        "k8s" -> "Kubernetes"
        "bash" -> "Bash"
        "zsh" -> "Zsh"
        "sh" -> "Shell"
        else -> type.ifBlank { "终端" }
    }
    val directory = terminal.directory?.takeIf(String::isNotBlank)
        ?: profile?.startupPath?.takeIf(String::isNotBlank)
    Surface(onClick = open, enabled = enabled, color = TbColors.Surface,
        shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, TbColors.BorderSoft)) {
        Column {
            Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(36.dp).background(TbColors.SurfaceHover, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                    Icon(if (type == "ssh") Icons.Outlined.Dns else Icons.Outlined.Terminal, null,
                        Modifier.size(20.dp), tint = TbColors.Accent)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(terminal.profileName, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(typeName, directory).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text("已打开", style = MaterialTheme.typography.labelSmall, color = TbColors.Accent)
                Icon(Icons.Outlined.ChevronRight, "进入终端", Modifier.size(18.dp), tint = TbColors.TextMuted)
            }
            profile?.startupCommands?.takeIf { it.isNotEmpty() }?.let { commands ->
                Column(Modifier.fillMaxWidth().background(TbColors.SurfaceHover).padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("启动命令", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                    Text(commands.joinToString("\n"), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                        maxLines = 3, overflow = TextOverflow.Ellipsis, color = TbColors.TextSoft)
                }
            }
        }
    }
}
