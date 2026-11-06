package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.TerminalAgentUiState
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.data.ServerProfile
import com.terminalbuddy.android.data.ServerTerminal
import com.terminalbuddy.android.data.TerminalAgentSession

/**
 * 服务端终端板块：列出已打开的终端与正在运行的 Agent 会话，不再展示项目配置。
 * 打开、刷新与 Agent 管理沿用同一个账号绑定的 ViewModel，不另行维护状态。
 * 「Agent 会话」区来自独立的 `/api/terminal-agents` 数据源：普通终端列表会过滤
 * owner != web，不能用它推导 Agent 列表；两个列表各自 loading / error。
 */
@Composable
internal fun AiTerminalSessionsScreen(
    ui: ServerTerminalUiState, vm: ServerTerminalViewModel,
    agentUi: TerminalAgentUiState, agentVm: TerminalAgentViewModel,
    openAgent: (TerminalAgentSession) -> Unit,
) {
    val busy = ui.launchingId != null
    // 长按 Agent 会话 → 确认后关闭承载该会话的服务端终端（Agent 随之结束）。
    var closeTarget by remember { mutableStateOf<TerminalAgentSession?>(null) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(key = "heading") {
            AiSectionRow(
                title = "服务端终端",
                subtitle = if (ui.loaded) "${ui.terminals.size} 个已打开" else "读取当前服务的终端",
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
            val agent = agentUi.sessions.find { it.terminalId == terminal.id }
            AiOpenTerminalCard(
                terminal, ui.profiles.find { it.id == terminal.profileId }, !busy,
                agent = agent,
                openTerminal = { vm.open(terminal) },
                openAgent = { agent?.let(openAgent) },
            )
        }

        // ===== Agent 会话（独立数据源，含 PC 终端上正在运行的会话）=====
        agentUi.listError?.let { error -> item(key = "agent-error") {
            Surface(color = TbColors.Danger.copy(alpha = .08f), shape = RoundedCornerShape(16.dp)) {
                Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Agent 会话同步失败", style = MaterialTheme.typography.titleSmall)
                    Text(error, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                    TextButton(agentVm::refresh, enabled = !agentUi.listLoading && !busy, contentPadding = PaddingValues(0.dp)) {
                        Text("重新加载")
                    }
                }
            }
        } }
        if (agentUi.listLoading && agentUi.sessions.isEmpty()) item(key = "agent-loading") {
            Text(
                "正在同步终端 Agent 会话…", Modifier.padding(vertical = 6.dp),
                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
            )
        }
        agentUi.closeError?.let { error -> item(key = "agent-close-error") {
            Surface(color = TbColors.Danger.copy(alpha = .08f), shape = RoundedCornerShape(12.dp)) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        error, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                        color = TbColors.Danger, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    TextButton(agentVm::clearCloseError) { Text("知道了") }
                }
            }
        } }
        if (agentUi.sessions.isNotEmpty()) {
            item(key = "agent-label") {
                AiListLabel("Agent 会话", Modifier.padding(top = 8.dp), trailing = "${agentUi.sessions.size} 个")
            }
            items(agentUi.sessions, key = { "agent:${it.terminalId}" }) { agent ->
                AiAgentSessionCard(
                    agent, !busy,
                    closing = agentUi.closingTerminalId == agent.terminalId,
                    open = { openAgent(agent) },
                    requestClose = { closeTarget = agent },
                )
            }
            item(key = "agent-hint") {
                Text(
                    "服务端终端里正在运行的 Claude / Codex 会话：查看实时镜像，可回一句或处理待决策；长按可关闭。",
                    style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                )
            }
        }

        // ===== 项目配置已从此页移除：终端页只保留「打开现有终端 / 查看 Agent 会话」 =====

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
    val target = closeTarget
    if (target != null) AlertDialog(
        onDismissRequest = { closeTarget = null },
        title = { Text("关闭服务端 Agent") },
        text = {
            Text("关闭「${target.displayTitle}」所在的服务端终端？终端里的 Agent 会话会随之结束，未保存的工作将丢失。")
        },
        confirmButton = {
            TextButton({
                closeTarget = null
                agentVm.closeSession(target)
            }) { Text("关闭", color = TbColors.Danger) }
        },
        dismissButton = { TextButton({ closeTarget = null }) { Text("取消") } },
    )
}

/** 已打开的终端：一行标题 + 一行类型/目录，点开进入终端画面；有 Agent 绑定时追加快捷入口。 */
@Composable
private fun AiOpenTerminalCard(
    terminal: ServerTerminal, profile: ServerProfile?, enabled: Boolean,
    agent: TerminalAgentSession?, openTerminal: () -> Unit, openAgent: () -> Unit,
) {
    val type = terminal.terminalType.ifBlank { profile?.terminalType.orEmpty() }
    val typeName = terminalTypeLabel(type)
    val directory = terminal.directory?.takeIf(String::isNotBlank)
        ?: profile?.startupPath?.takeIf(String::isNotBlank)
    Surface(
        onClick = openTerminal, enabled = enabled, color = TbColors.Surface,
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
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                if (agent != null) Surface(
                    onClick = openAgent, enabled = enabled,
                    color = TbColors.Accent.copy(alpha = .12f), shape = RoundedCornerShape(8.dp),
                ) {
                    Row(
                        Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        AiAgentLogo(agent.provider, Modifier.size(13.dp), tint = TbColors.Accent)
                        Text("Agent 会话", style = MaterialTheme.typography.labelSmall, color = TbColors.Accent)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("已打开", style = MaterialTheme.typography.labelSmall, color = TbColors.Accent)
                    Icon(Icons.Outlined.ChevronRight, "进入终端", Modifier.size(18.dp), tint = TbColors.TextMuted)
                }
            }
        }
    }
}

/** 终端 Agent 会话卡：provider 徽标 + 标题 + 阶段，有待决策时带角标；长按关闭服务端 Agent。 */
@Composable
private fun AiAgentSessionCard(
    session: TerminalAgentSession, enabled: Boolean,
    closing: Boolean, open: () -> Unit, requestClose: () -> Unit,
) {
    Surface(
        color = TbColors.Surface,
        shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, TbColors.Border),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp)
                .combinedClickable(enabled = enabled, onClick = open,
                    onLongClickLabel = "关闭服务端 Agent", onLongClick = requestClose)
                .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AiAgentBadge(session.provider, size = 34.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        session.displayTitle, style = MaterialTheme.typography.titleSmall, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                    AgentPhaseTag(session)
                }
                Text(
                    listOfNotNull(
                        terminalTypeLabel(session.terminalType),
                        session.model?.takeIf(String::isNotBlank),
                        session.directory?.takeIf(String::isNotBlank),
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (closing) {
                CircularProgressIndicator(Modifier.size(19.dp), strokeWidth = 2.dp, color = TbColors.TextMuted)
            } else if (session.pendingDecisionCount > 0) {
                BadgedBox(badge = {
                    Badge(containerColor = TbColors.Accent, contentColor = TbColors.AccentInk) {
                        Text(if (session.pendingDecisionCount > 99) "99+" else session.pendingDecisionCount.toString())
                    }
                }) {
                    Icon(Icons.Outlined.PendingActions, "有待决策", Modifier.size(19.dp), tint = TbColors.Accent)
                }
            } else {
                Icon(Icons.Outlined.ChevronRight, "查看 Agent 会话", Modifier.size(18.dp), tint = TbColors.TextMuted)
            }
        }
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
