package com.terminalbuddy.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.data.ServerProfile
import com.terminalbuddy.android.data.ServerTerminal

@Composable
internal fun ServerProjectProfilesDialog(ui: ServerTerminalUiState, vm: ServerTerminalViewModel) {
    var expandedProject by remember { mutableStateOf<String?>(null) }
    val busy = ui.launchingId != null
    AiSheet("服务端项目与配置", vm::dismissConfigurations, heightFraction = .75f, action = {
        IconButton(vm::refresh, enabled = !ui.loading && !busy) {
            Icon(Icons.Outlined.Refresh, "刷新项目配置", Modifier.size(20.dp), tint = TbColors.TextMuted)
        }
    }) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ui.error?.let { message ->
            Column(Modifier.padding(12.dp)) {
                Text(message, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                TextButton(vm::refresh, enabled = !ui.loading && !busy) { Text("刷新列表") }
            }
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!ui.loaded && ui.loading) item {
                Text("正在读取服务端项目与配置…", Modifier.padding(12.dp), color = TbColors.TextMuted)
            }
            if (ui.loaded && ui.projects.isEmpty()) item {
                Text("服务端暂无项目配置", Modifier.padding(12.dp), color = TbColors.TextMuted)
            }
            ui.projects.forEach { project ->
                val profiles = ui.profiles.filter { it.projectName == project.name }
                val expanded = expandedProject == project.name
                item(key = "project:${project.name}") {
                    Surface(onClick = {
                        expandedProject = if (expandedProject == project.name) null else project.name
                    }, color = TbColors.SurfaceHover, shape = RoundedCornerShape(10.dp)) {
                        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(if (expanded) Icons.Outlined.ExpandMore else Icons.Outlined.ChevronRight, null, Modifier.size(20.dp))
                            Column(Modifier.weight(1f)) {
                                Text(project.name, style = MaterialTheme.typography.titleSmall)
                                if (project.path.isNotBlank()) Text(project.path,
                                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Text("${profiles.size}", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                        }
                    }
                }
                if (expanded) {
                    if (profiles.isEmpty()) item(key = "empty:${project.name}") {
                        Text("暂无配置", Modifier.padding(start = 28.dp, top = 6.dp, bottom = 6.dp),
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                    items(profiles, key = { "profile:${it.id}" }) { profile ->
                        ServerProfileRow(profile, ui.launchingId, ui.loading && !ui.loaded,
                            ui.terminals.filter { it.profileId == profile.id }, vm::launch, vm::open)
                    }
                }
            }
            val orphaned = ui.terminals.filter { terminal -> ui.profiles.none { it.id == terminal.profileId } }
            if (orphaned.isNotEmpty()) {
                item { Text("其他已打开的终端", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.titleSmall) }
                items(orphaned, key = { "terminal:${it.id}" }) { terminal ->
                    ContinueTerminal(terminal, !busy) { vm.open(terminal) }
                }
            }
        }
    }
}

@Composable
private fun ServerProfileRow(
    profile: ServerProfile, launchingId: String?, loading: Boolean, terminals: List<ServerTerminal>,
    launch: (ServerProfile) -> Unit, open: (ServerTerminal) -> Unit,
) {
    val launching = launchingId == profile.id
    Column(Modifier.fillMaxWidth().padding(start = 16.dp)) {
        Surface(onClick = { launch(profile) }, enabled = profile.canLaunch && launchingId == null && !loading,
            shape = RoundedCornerShape(10.dp), color = TbColors.Surface) {
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp, horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Outlined.Terminal, null, Modifier.size(20.dp), tint = TbColors.TextMuted)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(profile.name, style = MaterialTheme.typography.titleSmall)
                    Text(profile.terminalType.uppercase(), style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                    if (profile.startupCommands.isNotEmpty()) Text(profile.startupCommands.joinToString("\n"),
                        fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                        color = TbColors.TextMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (!profile.canLaunch) Text(profile.unavailableReason,
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                }
                if (launching) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.Outlined.PlayArrow, "执行${profile.name}", Modifier.size(22.dp),
                    tint = if (profile.canLaunch) TbColors.Accent else TbColors.TextMuted)
            }
        }
        terminals.forEach { terminal -> ContinueTerminal(terminal, launchingId == null) { open(terminal) } }
        AiDivider()
    }
}

@Composable
private fun ContinueTerminal(terminal: ServerTerminal, enabled: Boolean, open: () -> Unit) {
    TextButton(open, enabled = enabled) {
        Icon(Icons.Outlined.OpenInNew, null, Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text("继续查看 · ${terminal.profileName} · ${terminal.id.take(8)}",
            style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
