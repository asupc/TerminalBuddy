package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.terminalbuddy.android.notifications.AiBackgroundCompatibility
import com.terminalbuddy.android.notifications.AiTaskNotifications

private enum class AgentSessionTab { Chat, Terminal }

/**
 * 终端 Agent 会话宿主：共用完整版聊天布局，从对话菜单打开原终端。
 * 对话页提供镜像与受限回复，终端页复用不含头栏的 ServerTerminalContent。
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
    var menu by rememberSaveable(session?.terminalId.orEmpty()) { mutableStateOf(false) }
    var information by rememberSaveable(session?.terminalId.orEmpty()) { mutableStateOf(false) }
    var usageInformation by rememberSaveable(session?.terminalId.orEmpty()) { mutableStateOf(false) }
    var vivoBackgroundGuide by rememberSaveable(session?.terminalId.orEmpty()) { mutableStateOf(false) }
    val context = LocalContext.current
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

    AiConversationLayout(
        title = session?.displayTitle ?: "远程会话", reconnecting = agentUi.reconnecting,
        onBack = back, onMenu = { menu = true },
        actions = {
            if (activeTab == AgentSessionTab.Terminal) IconButton({ activeTab = AgentSessionTab.Chat }) {
                Icon(Icons.Outlined.ChatBubbleOutline, "返回对话", Modifier.size(20.dp), tint = TbColors.TextMuted)
            }
        },
    ) {
        if (activeTab == AgentSessionTab.Chat) AiNotificationPermission()
        when (activeTab) {
            AgentSessionTab.Chat -> Box(Modifier.fillMaxWidth().weight(1f)) {
                if (session != null) {
                    TerminalAgentChatScreen(
                        ui = agentUi, vm = agentVm,
                        openDecision = openDecision,
                        openTerminal = { activeTab = AgentSessionTab.Terminal },
                        usageDetails = { usageInformation = true },
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
    if (menu) {
        AiSheet("对话操作", { menu = false }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                AiConversationAction(Icons.Outlined.NotificationsActive, "决策横幅通知", {
                    menu = false; AiTaskNotifications.openDecisionSettings(context)
                })
                AiConversationAction(Icons.Outlined.NotificationsActive, "结束横幅通知", {
                    menu = false; AiTaskNotifications.openResultSettings(context)
                })
                AiConversationAction(Icons.Outlined.BatteryFull, "后台运行设置", {
                    menu = false
                    if (AiBackgroundCompatibility.isVivoDevice()) vivoBackgroundGuide = true
                    else AiTaskNotifications.openBackgroundSettings(context)
                })
                AiConversationAction(Icons.Outlined.Info, "对话信息", { menu = false; information = true })
                AiConversationAction(Icons.Outlined.DataUsage, "上下文与 Token", {
                    menu = false; usageInformation = true
                }, enabled = session != null)
                AiConversationAction(Icons.Outlined.FolderOpen, "返回首页选择模型", { menu = false; onBack() })
                AiConversationAction(
                    if (activeTab == AgentSessionTab.Chat) Icons.Outlined.Terminal else Icons.Outlined.ChatBubbleOutline,
                    if (activeTab == AgentSessionTab.Chat) "打开终端" else "返回对话",
                    {
                        menu = false
                        activeTab = if (activeTab == AgentSessionTab.Chat) AgentSessionTab.Terminal else AgentSessionTab.Chat
                    },
                )
                AiConversationAction(Icons.Outlined.Refresh, "刷新消息", { menu = false; agentVm.refreshSession() },
                    enabled = session != null && !agentUi.loadingMessages && !agentUi.starting)
            }
        }
    }
    if (information) {
        AiSheet("对话信息", { information = false }) {
            SelectionContainer(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(16.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    AiInfoField("会话来源", "服务端终端")
                    session?.let {
                        AiInfoField("对话标题", it.displayTitle)
                        AiInfoField("项目路径", it.directory?.takeIf(String::isNotBlank) ?: "未提供", monospace = true)
                        AiInfoField("供应商与模型", listOfNotNull(agentTitle(it.provider), it.model?.takeIf(String::isNotBlank)).joinToString(" · "))
                        AiInfoField("思考强度", "跟随服务端")
                        AiInfoField("当前状态", "${if (agentUi.starting) "正在启动" else it.phaseLabel} · ${if (agentUi.connected) "实时连接" else "自动同步"}")
                        AiInfoField("终端类型", terminalTypeLabel(it.terminalType))
                    }
                    AiInfoField("消息数量", "${agentUi.total} 条")
                    if (agentUi.queuedReplies.isNotEmpty()) AiInfoField("待发消息", "${agentUi.queuedReplies.size} 条")
                }
            }
        }
    }
    if (vivoBackgroundGuide) AiVivoBackgroundGuide { vivoBackgroundGuide = false }
    if (usageInformation && session != null) {
        val conversation = agentConversationSession(session)
        AiUsageSheet(
            conversation, conversation.modelLabel, "跟随服务端",
            unavailableMessage = "当前终端会话尚未提供用量统计。",
        ) { usageInformation = false }
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
