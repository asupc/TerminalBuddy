package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.TerminalAgentUiState
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.data.ServerTerminal

private enum class AgentSessionTab { Chat, Terminal }

/**
 * 终端 Agent 会话宿主：「对话（默认）/ 终端」双页签。
 * 对话页是只读镜像 + 受限回复；终端页复用不含头栏的 ServerTerminalContent 查看同一终端。
 * 镜像 WS 仅在对话页签且 Activity START 时保持，切页签 / 退后台立即断开。
 */
@Composable
internal fun TerminalAgentSessionScreen(
    agentUi: TerminalAgentUiState,
    agentVm: TerminalAgentViewModel,
    terminalUi: ServerTerminalUiState,
    terminalVm: ServerTerminalViewModel,
    onBack: () -> Unit,
    onBackFromTerminal: () -> Unit,
    openDecision: (String) -> Unit,
) {
    val session = agentUi.selected
    var activeTab by rememberSaveable(session?.terminalId.orEmpty()) {
        mutableStateOf(AgentSessionTab.Chat)
    }
    val back: () -> Unit = {
        if (activeTab == AgentSessionTab.Terminal) onBackFromTerminal() else onBack()
    }

    // 可见性 = Agent 宿主存在 + 对话页签 + Activity START；三个条件任一失效都立即断开镜像。
    var activityStarted by remember { mutableStateOf(false) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> activityStarted = true
                Lifecycle.Event.ON_STOP -> activityStarted = false
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(activityStarted, activeTab, session?.terminalId) {
        agentVm.setVisible(activityStarted && activeTab == AgentSessionTab.Chat && session != null)
    }
    DisposableEffect(agentVm) { onDispose { agentVm.setVisible(false) } }
    BackHandler(onBack = back)

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding()
                .padding(start = 6.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(back, enabled = true) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回终端列表", Modifier.size(22.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    session?.displayTitle ?: "Agent 会话",
                    style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                val subtitle = listOfNotNull(
                    session?.let { terminalTypeLabel(it.terminalType) },
                    session?.directory?.takeIf(String::isNotBlank),
                ).joinToString(" · ")
                if (subtitle.isNotBlank()) Text(
                    subtitle, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            AgentTabPills(activeTab) { activeTab = it }
        }
        AiDivider()
        when (activeTab) {
            AgentSessionTab.Chat -> Box(Modifier.fillMaxWidth().weight(1f)) {
                if (session != null) {
                    TerminalAgentChatScreen(
                        ui = agentUi, vm = agentVm,
                        openDecision = openDecision,
                        openTerminal = { activeTab = AgentSessionTab.Terminal },
                    )
                } else {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = TbColors.Accent)
                            Text(
                                if (agentUi.starting) "正在启动 Agent…" else "正在载入会话…",
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                            )
                        }
                    }
                }
            }
            AgentSessionTab.Terminal -> AgentTerminalPane(
                agentUi = agentUi, terminalUi = terminalUi, terminalVm = terminalVm,
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        }
    }
}

/** 对话 / 终端页签切换；与底部导航和列表页的 Tab 层级区分。 */
@Composable
private fun AgentTabPills(active: AgentSessionTab, select: (AgentSessionTab) -> Unit) {
    Row(
        Modifier.background(TbColors.ButtonTrack, RoundedCornerShape(12.dp)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        AgentSessionTab.entries.forEach { tab ->
            val isActive = tab == active
            Surface(
                onClick = { select(tab) },
                color = if (isActive) TbColors.ButtonBackground else Color.Transparent,
                shape = RoundedCornerShape(9.dp),
                border = if (isActive) primaryControlBorder() else null,
            ) {
                Text(
                    if (tab == AgentSessionTab.Chat) "对话" else "终端",
                    Modifier.padding(horizontal = 13.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (isActive) TbColors.ButtonForeground else TbColors.TextSoft,
                )
            }
        }
    }
}

/**
 * 终端页签内容：以查看模式打开该终端（Agent 列表已按 Web 可见性过滤，
 * 不再受普通终端 open() 的 owner 限制），复用无头栏的 ServerTerminalContent。
 */
@Composable
private fun AgentTerminalPane(
    agentUi: TerminalAgentUiState,
    terminalUi: ServerTerminalUiState,
    terminalVm: ServerTerminalViewModel,
    modifier: Modifier = Modifier,
) {
    val session = agentUi.selected
    if (session == null) {
        Box(modifier, contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = TbColors.Accent)
        }
        return
    }
    LaunchedEffect(session.terminalId) {
        terminalVm.openView(
            ServerTerminal(
                id = session.terminalId,
                profileName = session.profileName.ifBlank { session.displayTitle },
                terminalType = session.terminalType,
                directory = session.directory,
            ),
        )
    }
    val terminal = terminalUi.selected?.takeIf { it.id == session.terminalId }
    val context = LocalContext.current
    if (terminal == null) {
        Box(modifier, contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = TbColors.Accent)
        }
        return
    }
    val host = remember(terminalUi.connection, terminal.id) { LocalTerminalView(context, terminalVm) }
    val textMode = !terminalUi.rendererReady || terminalUi.renderingError != null
    Column(modifier.imePadding().navigationBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                terminalUi.status, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
                color = if (terminalUi.terminalError != null) TbColors.Danger else TbColors.TextMuted,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            IconButton({
                if (textMode) host.copyText(terminalUi.outputLog) else host.copySelection()
            }) {
                Icon(Icons.Outlined.ContentCopy, if (textMode) "复制文本日志" else "复制选中的终端内容",
                    Modifier.size(18.dp), tint = TbColors.TextMuted)
            }
        }
        ServerTerminalContent(terminalUi, terminalVm, host, Modifier.weight(1f))
    }
}
