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
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.data.AiProject
import com.terminalbuddy.android.data.ServerProfile
import com.terminalbuddy.android.data.ServerTerminal

/**
 * 服务端终端板块：上半是已打开的终端，下半按项目折叠列出可启动的配置。
 * 打开、启动、刷新与配置管理沿用同一个账号绑定的 ViewModel，不另行维护状态。
 */
@Composable
internal fun AiTerminalSessionsScreen(ui: ServerTerminalUiState, vm: ServerTerminalViewModel) {
    val busy = ui.launchingId != null
    // 外层按账号做了 key()，这里只需要记住本账号下展开的项目。
    var expandedProject by rememberSaveable { mutableStateOf<String?>(null) }
    val projects = remember(ui.projects, ui.profiles) {
        // 目录同时覆盖项目接口与配置分组：有些配置的 group 不在项目列表里，也要能启动。
        val names = LinkedHashSet<String>()
        ui.projects.forEach { if (it.name.isNotBlank()) names.add(it.name) }
        ui.profiles.forEach { names.add(it.projectName) }
        names.map { name ->
            AiProject(name = name, path = ui.projects.find { it.name == name }?.path.orEmpty())
        }
    }
    val launchable = ui.profiles.count { it.canLaunch }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(key = "heading") {
            AiSectionRow(
                title = "服务端终端",
                subtitle = if (ui.loaded) "${ui.terminals.size} 个已打开 · $launchable 个可启动" else "读取当前服务的终端",
            ) {
                if (ui.loading) {
                    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                        AiConnectionSpinner(TbColors.Accent, Modifier.size(20.dp))
                    }
                }
            }
        }
        ui.error?.let { error -> item(key = "error") {
            Surface(color = TbColors.Danger.copy(alpha = .08f), shape = RoundedCornerShape(16.dp)) {
                Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("终端列表同步失败", style = MaterialTheme.typography.titleSmall)
                    Text(error, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                    TextButton(vm::refresh, enabled = !ui.loading && !busy, contentPadding = PaddingValues(0.dp)) {
                        Text("重新加载")
                    }
                }
            }
        } }

        // ===== 已打开 =====
        if (ui.terminals.isNotEmpty()) {
            item(key = "open-label") {
                AiListLabel("已打开", Modifier.padding(top = 4.dp), trailing = "${ui.terminals.size} 个")
            }
        }
        items(ui.terminals, key = { "terminal:${it.id}" }) { terminal ->
            AiOpenTerminalCard(terminal, ui.profiles.find { it.id == terminal.profileId }, !busy) { vm.open(terminal) }
        }

        // ===== 项目配置 =====
        item(key = "config-label") {
            AiListLabel("项目配置", Modifier.padding(top = 8.dp), trailing = "${ui.profiles.size} 项")
        }
        if (ui.loaded && ui.profiles.isEmpty() && ui.error == null) item(key = "empty") {
            AiCard(shape = RoundedCornerShape(16.dp)) {
                AiEmptyState(Icons.Outlined.Terminal, "还没有终端配置", "在电脑端登记服务端项目与终端配置后，就能在这里直接启动。")
            }
        }
        projects.forEach { project ->
            val profiles = ui.profiles.filter { it.projectName == project.name }
            val expanded = expandedProject == project.name
            item(key = "project:${project.name}") {
                AiProjectAccordion(
                    name = project.name, path = project.path, expanded = expanded,
                    enabled = !busy, count = "${profiles.size} 项",
                    toggle = { expandedProject = if (expanded) null else project.name },
                ) {
                    if (profiles.isEmpty()) {
                        Text(
                            "暂无终端配置", Modifier.padding(vertical = 14.dp),
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                        )
                    }
                    profiles.forEachIndexed { index, profile ->
                        val open = ui.terminals.filter { it.profileId == profile.id }
                        AiProfileLaunchRow(
                            profile = profile, open = open, launchingId = ui.launchingId, busy = busy || ui.loading,
                            launch = { vm.launch(profile) },
                            // 已打开的配置点一下直接回到那个终端，不再重复起一个新的。
                            openTerminal = open.lastOrNull()?.let { terminal -> { vm.open(terminal) } },
                            // 最后一行不再画分隔线，避免和卡片底边叠成双线。
                            showDivider = index < profiles.lastIndex,
                        )
                    }
                }
            }
        }
        val orphaned = ui.terminals.filter { terminal -> ui.profiles.none { it.id == terminal.profileId } }
        if (orphaned.isNotEmpty()) item(key = "orphan-hint") {
            Text(
                "另有 ${orphaned.size} 个终端对应的配置已被删除，在上方「已打开」里仍可继续查看。",
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
            )
        }
        if (ui.terminals.isNotEmpty()) item(key = "hint") {
            Text(
                "离开页面后，终端继续保持运行。", Modifier.fillMaxWidth().padding(top = 4.dp),
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** 已打开的终端：一行标题 + 一行类型/目录，点开进入终端画面。 */
@Composable
private fun AiOpenTerminalCard(terminal: ServerTerminal, profile: ServerProfile?, enabled: Boolean, open: () -> Unit) {
    val type = terminal.terminalType.ifBlank { profile?.terminalType.orEmpty() }
    val typeName = terminalTypeLabel(type)
    val directory = terminal.directory?.takeIf(String::isNotBlank)
        ?: profile?.startupPath?.takeIf(String::isNotBlank)
    Surface(
        onClick = open, enabled = enabled, color = TbColors.Surface,
        shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, TbColors.Border),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier.size(34.dp).background(TbColors.SurfaceHover, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (type == "ssh") Icons.Outlined.Dns else Icons.Outlined.Terminal, null,
                    Modifier.size(19.dp), tint = TbColors.Accent)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(terminal.profileName, style = MaterialTheme.typography.titleSmall, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    AiStatusDot(TbColors.Accent)
                }
                Text(
                    listOfNotNull(typeName, directory).joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Text("已打开", style = MaterialTheme.typography.labelSmall, color = TbColors.Accent)
            Icon(Icons.Outlined.ChevronRight, "进入终端", Modifier.size(18.dp), tint = TbColors.TextMuted)
        }
    }
}

/** 项目卡内的可启动配置：名称 + 类型标签 + 启动命令，右侧按钮在已打开时变成对勾并直接进入终端。 */
@Composable
private fun AiProfileLaunchRow(
    profile: ServerProfile, open: List<ServerTerminal>, launchingId: String?, busy: Boolean,
    launch: () -> Unit, openTerminal: (() -> Unit)?, showDivider: Boolean = true,
) {
    val launching = launchingId == profile.id
    val alreadyOpen = openTerminal != null
    AiAccordionRow(
        enabled = (profile.canLaunch || alreadyOpen) && launchingId == null && !busy,
        icon = Icons.Outlined.Terminal,
        iconColor = if (profile.canLaunch || alreadyOpen) TbColors.Accent else TbColors.TextMuted,
        showDivider = showDivider,
        trailing = {
            if (launching) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = TbColors.Accent)
            } else {
                Box(
                    Modifier.size(32.dp)
                        .background(
                            if (alreadyOpen) TbColors.Accent else TbColors.Accent.copy(alpha = .12f),
                            RoundedCornerShape(10.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        if (alreadyOpen) Icons.Outlined.Check else Icons.Outlined.PlayArrow,
                        if (alreadyOpen) "已打开" else "启动${profile.name}",
                        Modifier.size(18.dp),
                        tint = if (alreadyOpen) TbColors.AccentInk else TbColors.Accent,
                    )
                }
            }
        },
        onClick = openTerminal ?: launch,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(profile.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false))
            AiTypeTag(terminalTypeLabel(profile.terminalType))
        }
        val detail = when {
            alreadyOpen -> "已打开 ${open.size} 个终端 · 点击继续查看"
            profile.startupCommands.isNotEmpty() -> profile.startupCommands.joinToString(" · ")
            profile.startupPath.isNotBlank() -> profile.startupPath
            !profile.canLaunch -> profile.unavailableReason
            else -> "点击启动"
        }
        Text(detail, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** 终端类型的小号标签，配置行里紧跟在配置名后面。 */
@Composable
private fun AiTypeTag(text: String) {
    Surface(color = TbColors.SurfaceHover, shape = RoundedCornerShape(4.dp)) {
        Text(
            text, Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall, color = TbColors.TextSoft, maxLines = 1,
        )
    }
}

/** 终端类型统一转成展示名，配置行与已打开终端共用。 */
internal fun terminalTypeLabel(type: String): String = when (type.lowercase()) {
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
