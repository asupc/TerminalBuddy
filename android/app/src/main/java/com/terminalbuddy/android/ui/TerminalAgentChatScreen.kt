package com.terminalbuddy.android.ui

import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.TerminalAgentUiState
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.TerminalReplyStatus
import com.terminalbuddy.android.data.AiMessage
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.TerminalAgentSession

/** 终端只适配消息与操作，页面布局、消息动画、用量卡片和输入框共用完整版组件。 */
@Composable
internal fun TerminalAgentChatScreen(
    ui: TerminalAgentUiState,
    vm: TerminalAgentViewModel,
    openDecision: (String) -> Unit,
    openTerminal: () -> Unit,
    usageDetails: () -> Unit,
) {
    val session = ui.selected ?: return
    val conversation = remember(session, ui.messages, ui.starting) {
        agentConversationSession(session, ui.messages, ui.starting)
    }
    var usageExpanded by rememberSaveable(session.terminalId) { mutableStateOf(true) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(session.pendingDecisionId) {
        if (session.pendingDecisionId != null) { focus.clearFocus(); keyboard?.hide() }
    }
    val motion = rememberAiConversationMotion(conversation, ui.loadingMessages || ui.starting)
    val entries = motion.entries
    val showingMessages = !ui.closed && !ui.starting && session.mirror.available
    // 镜像换代只替换正文，保留用户的滚动位置。
    val scrollIdentity = "${session.terminalId}:${session.sessionId}"
    val lastMessage = ui.messages.lastOrNull()
    val assistantOutput = lastMessage?.let { it.role == "assistant" && it.text.isNotBlank() } == true
    val waitingForDecision = session.phase == "attention" || session.pendingDecisionCount > 0
    val pending = ui.pendingReply
    // 发送游标之后的助手正文才属于本次回复。
    val awaitingReply = pending != null && !(assistantOutput && (lastMessage?.seq ?: -1L) > pending.sentAfterSeq)
    val showReplyIndicator = showingMessages && !ui.loadingMessages &&
        (waitingForDecision || ui.sending || awaitingReply || (session.phase == "running" && !assistantOutput))
    val request = ui.messages.lastOrNull { it.role == "user" }
    val requestId = when {
        ui.sending -> "sending:${request?.seq}"
        pending != null -> "pending:${pending.requestId}"
        request != null -> "message:${request.seq}"
        else -> "phase:${session.phaseAt}"
    }
    val requestAt = when {
        ui.sending -> null
        pending != null -> pending.sentAt
        request != null -> request.timestamp
        else -> session.phaseAt
    }
    val elapsedSeconds = rememberAiReplyElapsedSeconds(conversation.id, requestId, requestAt, showReplyIndicator)
    val entryCount = entries.size + ui.queuedReplies.size + (if (showReplyIndicator) 1 else 0) +
        (if (ui.sending) 1 else 0) + (if (pending != null) 1 else 0)
    val scroll = rememberAiConversationScroll(
        scrollIdentity, !ui.loadingMessages && (showingMessages || ui.starting), entryCount,
    )
    Column(Modifier.fillMaxSize()) {
        ui.startError?.let { error ->
            Row(
                Modifier.fillMaxWidth().background(TbColors.Accent.copy(alpha = .08f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(error, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                    maxLines = 3, overflow = TextOverflow.Ellipsis)
                TextButton(openTerminal) { Text("看终端") }
                TextButton(vm::clearStartError) { Text("知道了") }
            }
        }
        ui.messagesError?.let { error ->
            Row(
                Modifier.fillMaxWidth().background(TbColors.Danger.copy(alpha = .08f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(error, Modifier.weight(1f), color = TbColors.Danger,
                    style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                TextButton(vm::refreshSession, enabled = !ui.loadingMessages) { Text("重试") }
            }
        }
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            when {
                ui.closed -> Column(
                    Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Icon(Icons.Outlined.LinkOff, null, Modifier.size(28.dp), tint = TbColors.TextMuted)
                    Text(ui.closedReason ?: "镜像连接已结束", style = MaterialTheme.typography.bodyMedium,
                        color = TbColors.TextMuted, textAlign = TextAlign.Center)
                    TextButton(vm::refreshSession, enabled = !ui.loadingMessages) { Text("刷新重试") }
                }
                !ui.starting && !session.mirror.available -> Column(
                    Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Icon(Icons.Outlined.CloudOff, null, Modifier.size(28.dp), tint = TbColors.TextMuted)
                    Text(mirrorReasonLabel(session), style = MaterialTheme.typography.bodyMedium,
                        color = TbColors.TextMuted, textAlign = TextAlign.Center)
                    OutlinedButton(openTerminal) { Text("打开终端") }
                }
                else -> {
                    LazyColumn(
                        Modifier.widthIn(max = 760.dp).fillMaxSize().align(Alignment.TopCenter)
                            .nestedScroll(scroll.gestures),
                        state = scroll.list, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(entries, key = { it.id }) { entry ->
                            when (entry) {
                                is AiConversationEntry.Message -> AiMessageBubble(entry.message, conversation.providerLabel)
                                is AiConversationEntry.Tools -> AiToolGroup(entry.messages, Modifier) { scroll.following = false }
                            }
                        }
                        if (ui.sending) item(key = "sending") {
                            AgentPendingRow("", "正在发送…", TbColors.TextMuted, true)
                        }
                        pending?.let {
                            item(key = "pending-reply") {
                                val color = if (it.status == TerminalReplyStatus.Delivered) TbColors.Accent else TbColors.TextMuted
                                AgentPendingRow(it.text, it.statusLabel, color, false)
                            }
                        }
                        itemsIndexed(ui.queuedReplies, key = { index, _ -> "queued-$index" }) { index, text ->
                            AgentPendingRow(
                                text, if (ui.starting) "Agent 启动后自动发送" else if (index == 0) "即将发送" else "排队中",
                                TbColors.TextMuted, false,
                            )
                        }
                        if (showReplyIndicator) item(key = "agent-status") {
                            val statusLabel = if (waitingForDecision) "等待确认" else "思考中"
                            AiReplyIndicator(
                                conversation.providerLabel,
                                if (ui.queuedReplies.isNotEmpty()) "$statusLabel · ${ui.queuedReplies.size} 条排队中" else statusLabel,
                                elapsedSeconds,
                                Modifier.animateItem(fadeInSpec = tween(120), placementSpec = null, fadeOutSpec = null),
                            )
                        }
                        item(key = "agent-bottom") { Spacer(Modifier.height(1.dp)) }
                    }
                    if (motion.messages.isEmpty() && pending == null && ui.queuedReplies.isEmpty() &&
                        !ui.sending && !showReplyIndicator
                    ) {
                        AiConversationEmptyState(
                            session.provider, ui.loadingMessages || !motion.initialized,
                            Modifier.align(Alignment.Center),
                            message = if (ui.starting) "正在启动，消息将在就绪后发送。" else null,
                        )
                    }
                    AiConversationJumpToLatest(
                        visible = session.pendingDecisionCount == 0 && !scroll.following && scroll.list.canScrollForward && entryCount > 0,
                        onClick = { scroll.following = true },
                        modifier = Modifier.align(Alignment.BottomCenter).padding(
                            start = 8.dp, end = if (usageExpanded) 8.dp else 64.dp, bottom = 8.dp),
                    )
                }
            }
            Column(
                Modifier.align(Alignment.BottomCenter).widthIn(max = 760.dp).fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (session.pendingDecisionCount > 0 && session.pendingDecisionId != null) {
                    Button(
                        { session.pendingDecisionId?.let(openDecision) },
                        Modifier.fillMaxWidth().heightIn(min = 42.dp), shape = RoundedCornerShape(11.dp),
                        colors = primaryButtonColors(), border = primaryControlBorder(),
                    ) {
                        Icon(Icons.Outlined.PendingActions, null, Modifier.size(17.dp))
                        Spacer(Modifier.width(7.dp))
                        Text("待决策 · ${session.pendingDecisionCount} 项待确认", style = MaterialTheme.typography.labelLarge)
                    }
                }
                if (!usageExpanded) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.BottomEnd) {
                    AiUsageExpandButton(onClick = { usageExpanded = true })
                }
            }
        }
        AgentComposer(ui, vm, session, conversation, usageExpanded, { usageExpanded = it }, usageDetails, openTerminal) {
            scroll.following = true
            vm.send()
        }
    }
}

@Composable
internal fun AgentPhaseTag(session: TerminalAgentSession) {
    val (background, content) = when (session.phase) {
        "attention" -> TbColors.Accent.copy(alpha = .16f) to TbColors.Accent
        "running" -> TbColors.Accent to TbColors.AccentInk
        "failed" -> TbColors.Danger.copy(alpha = .12f) to TbColors.Danger
        "ended" -> TbColors.SurfaceHover to TbColors.TextMuted
        else -> TbColors.SurfaceHover to TbColors.TextSoft
    }
    Surface(color = background, shape = RoundedCornerShape(5.dp)) {
        Text(
            session.phaseLabel, Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall, color = content, maxLines = 1,
        )
    }
}

/** 本地待确认与排队的回复同样使用完整版用户气泡，状态保留在气泡下方。 */
@Composable
private fun AgentPendingRow(text: String, label: String, color: Color, spinning: Boolean) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (text.isNotBlank()) {
            val message = remember(text) { AiAnimatedMessage(AiMessage("pending-$text", "user", text), animate = false) }
            AiMessageBubble(message, provider = "", sending = spinning)
        }
        Row(
            Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (spinning && text.isBlank()) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = color)
                Spacer(Modifier.width(5.dp))
            }
            Text(label, style = MaterialTheme.typography.labelSmall, color = color)
        }
    }
}

/** 模型与用量直接复用完整版卡片，终端接口未上报的统计保持未知。 */
@Composable
private fun AgentComposer(
    ui: TerminalAgentUiState, vm: TerminalAgentViewModel, session: TerminalAgentSession, conversation: AiSession,
    usageExpanded: Boolean, onUsageExpandedChange: (Boolean) -> Unit, usageDetails: () -> Unit,
    openTerminal: () -> Unit, send: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
                ui.sendError?.let { AiError(it, vm::clearSendError) }
                if (!ui.starting && !session.canReply) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            session.replyBlockedReason ?: "当前阶段暂不支持回复",
                            Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                            maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                        TextButton(openTerminal) { Text("打开终端") }
                    }
                }
                AiUsageCard(
                    conversation, conversation.modelLabel, "跟随服务端", usageDetails,
                    expanded = usageExpanded, onExpandedChange = onUsageExpandedChange,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        val enabled = (ui.starting || session.canReply) && !ui.closed
        AiMessageComposer(
            value = ui.draft, onValueChange = vm::draft,
            placeholder = if (enabled) "给 ${conversation.providerLabel} 发消息…" else "当前不可回复",
            enabled = enabled, actionEnabled = enabled && ui.draft.isNotBlank(), onAction = send,
            actionLabel = if (ui.starting || ui.sending || ui.queuedReplies.isNotEmpty()) "发送排队消息" else "发送消息",
        )
    }
}

private fun mirrorReasonLabel(session: TerminalAgentSession): String = when (session.mirror.reason) {
    "transcript_too_large" -> "会话转录过大，镜像暂不可用；请在终端页查看，或稍后在历史会话中回顾。"
    "transcript_unreadable" -> "会话转录读取失败，镜像暂不可用；请打开终端直接查看。"
    else -> "镜像暂不可用（${session.mirror.reason ?: "未知原因"}），请打开终端直接查看。"
}

