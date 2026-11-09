package com.terminalbuddy.android.ui

import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.TerminalAgentUiState
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.TerminalReplyStatus
import com.terminalbuddy.android.data.AiHistoryMessage
import com.terminalbuddy.android.data.AiMessage
import com.terminalbuddy.android.data.TerminalAgentSession

/**
 * 终端 Agent 会话使用完整版聊天组件展示消息和执行记录，沿用原终端镜像与受限回复通道。
 * 转录按条更新；启动排队、待决策入口和终端切换保留原有行为。
 */
@Composable
internal fun TerminalAgentChatScreen(
    ui: TerminalAgentUiState,
    vm: TerminalAgentViewModel,
    openDecision: (String) -> Unit,
    openTerminal: () -> Unit,
) {
    val session = ui.selected
    val entries = remember(ui.messages) { groupAgentChatEntries(ui.messages) }
    val showingMessages = session != null && !ui.closed && !ui.starting && session.mirror.available
    val conversationId = "${session?.terminalId}:${session?.sessionId}:${session?.revision}"
    // 滚动位置不随镜像换代（revision 变化）重置：rotated 只整体替换消息内容，
    // 列表状态归零会把视口拽回顶部并触发跟随滚动，用户的历史浏览位置也被丢弃。
    val scrollIdentity = "${session?.terminalId}:${session?.sessionId}"
    val lastMessage = ui.messages.lastOrNull()
    val assistantOutput = lastMessage?.let { it.role == "assistant" && it.text.isNotBlank() } == true
    val waitingForDecision = session?.phase == "attention" || (session?.pendingDecisionCount ?: 0) > 0
    val pending = ui.pendingReply
    // 只把发送游标之后的助手正文视为本次回复，避免上一轮正文遮掉新消息的等待状态。
    val awaitingReply = pending != null && !(assistantOutput && (lastMessage?.seq ?: -1L) > pending.sentAfterSeq)
    // 本地发送到转录出现前也显示状态，避免原终端已收到输入而页面还没有反馈。
    val showReplyIndicator = showingMessages && !ui.loadingMessages &&
        (waitingForDecision || ui.sending || awaitingReply || (session?.phase == "running" && !assistantOutput))
    val request = ui.messages.lastOrNull { it.role == "user" }
    val requestId = when {
        ui.sending -> "sending:${request?.seq}"
        pending != null -> "pending:${pending.requestId}"
        request != null -> "message:${request.seq}"
        else -> "phase:${session?.phaseAt}"
    }
    val requestAt = when {
        ui.sending -> null
        pending != null -> pending.sentAt
        request != null -> request.timestamp
        else -> session?.phaseAt
    }
    val elapsedSeconds = rememberAiReplyElapsedSeconds(conversationId, requestId, requestAt, showReplyIndicator)
    val entryCount = entries.size + ui.queuedReplies.size + (if (showReplyIndicator) 1 else 0) +
        (if (ui.sending) 1 else 0) + (if (ui.pendingReply != null) 1 else 0)
    val scroll = rememberAiConversationScroll(scrollIdentity, showingMessages && !ui.loadingMessages, entryCount)
    // edge-to-edge 下 adjustResize 不生效：底部同时避让系统导航栏与软键盘（取两者最大值），
    // 输入框不会在键盘弹起时被遮住，键盘收起后也不会压到手势导航条。
    Column(
        Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
    ) {
        ui.startError?.let { error ->
            Row(
                Modifier.fillMaxWidth().background(TbColors.Accent.copy(alpha = .08f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    error, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                    maxLines = 3, overflow = TextOverflow.Ellipsis,
                )
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
                Text(
                    error, Modifier.weight(1f), color = TbColors.Danger,
                    style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis,
                )
                TextButton({ vm.refreshSession() }, enabled = !ui.loadingMessages) { Text("重试") }
            }
        }
        if (session == null) {
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = TbColors.Accent)
            }
        } else if (ui.closed) {
            Column(
                Modifier.fillMaxWidth().weight(1f).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Icons.Outlined.LinkOff, null, Modifier.size(28.dp), tint = TbColors.TextMuted)
                Text(ui.closedReason ?: "镜像连接已结束", style = MaterialTheme.typography.bodyMedium,
                    color = TbColors.TextMuted, textAlign = TextAlign.Center)
                TextButton({ vm.refreshSession() }, enabled = !ui.loadingMessages) { Text("刷新重试") }
            }
        } else if (ui.starting) {
            // 启动态：终端已建好、Agent 绑定还没出现。不显示「镜像不可用」，
            // 而是说明可以直接输入（内容进队列，就绪后自动发送）。
            Column(
                Modifier.fillMaxWidth().weight(1f).padding(horizontal = 24.dp, vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = TbColors.Accent)
                Text(
                    "正在启动 Agent，可以直接输入需求；就绪后会自动发送。",
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    textAlign = TextAlign.Center,
                )
                TextButton(openTerminal) { Text("查看终端启动过程") }
                if (ui.queuedReplies.isNotEmpty()) {
                    Column(
                        Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        ui.queuedReplies.forEachIndexed { index, text ->
                            AgentPendingRow(
                                text, if (index == 0) "Agent 启动后自动发送" else "排队中",
                                TbColors.TextMuted, false,
                            )
                        }
                    }
                }
            }
        } else if (!session.mirror.available) {
            Column(
                Modifier.fillMaxWidth().weight(1f).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Icons.Outlined.CloudOff, null, Modifier.size(28.dp), tint = TbColors.TextMuted)
                Text(mirrorReasonLabel(session), style = MaterialTheme.typography.bodyMedium,
                    color = TbColors.TextMuted, textAlign = TextAlign.Center)
                OutlinedButton(openTerminal) { Text("打开终端") }
            }
        } else {
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                LazyColumn(
                    Modifier.widthIn(max = 760.dp).fillMaxSize().align(Alignment.TopCenter)
                        .nestedScroll(scroll.gestures),
                    state = scroll.list,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (ui.loadingMessages && ui.messages.isEmpty()) item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = TbColors.Accent)
                        }
                    }
                    items(entries, key = { it.key }) { entry ->
                        when (entry) {
                            is AgentChatEntry.Message -> AgentReplayMessage(session, entry.message)
                            is AgentChatEntry.Process -> AgentProcessGroup(session, entry.steps) {
                                scroll.following = false
                            }
                        }
                    }
                    if (ui.sending) item(key = "sending") {
                        AgentPendingRow(text = "", label = "正在发送…", color = TbColors.TextMuted, spinning = true)
                    }
                    ui.pendingReply?.let { pending ->
                        item(key = "pending-reply") {
                            val color = if (pending.status == TerminalReplyStatus.Delivered) TbColors.Accent else TbColors.TextMuted
                            AgentPendingRow(pending.text, pending.statusLabel, color, false)
                        }
                    }
                    itemsIndexed(ui.queuedReplies, key = { index, _ -> "queued-$index" }) { index, text ->
                        AgentPendingRow(text, if (index == 0) "即将发送" else "排队中", TbColors.TextMuted, false)
                    }
                    if (showReplyIndicator) item(key = "agent-status") {
                        val statusLabel = if (waitingForDecision) "等待确认" else "思考中"
                        AiReplyIndicator(
                            session.provider,
                            if (ui.queuedReplies.isNotEmpty()) "$statusLabel · ${ui.queuedReplies.size} 条排队中" else statusLabel,
                            elapsedSeconds,
                            null,
                            Modifier.animateItem(fadeInSpec = tween(120), placementSpec = null, fadeOutSpec = null),
                        )
                    }
                    if (!ui.loadingMessages && ui.messages.isEmpty() && ui.pendingReply == null &&
                        ui.queuedReplies.isEmpty() && !ui.sending && !showReplyIndicator
                    ) {
                        item(key = "empty") {
                            Column(
                                Modifier.fillMaxWidth().padding(24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                AiAgentBadge(session.provider)
                                Text(
                                    "发送第一条消息，开始对话。",
                                    style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted,
                                    textAlign = TextAlign.Center,
                                )
                            }
                        }
                    }
                    item(key = "agent-bottom") { Spacer(Modifier.height(1.dp)) }
                }
                androidx.compose.animation.AnimatedVisibility(
                    visible = !scroll.following && scroll.list.canScrollForward && entryCount > 0,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
                    enter = fadeIn(tween(180)) + slideInVertically(tween(220)) { it / 2 },
                    exit = fadeOut(tween(120)) + slideOutVertically(tween(160)) { it / 2 },
                ) {
                    FilledTonalButton(
                        { scroll.following = true }, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                        colors = primaryButtonColors(tonal = true), border = primaryControlBorder(),
                        elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = 2.dp),
                    ) {
                        Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("回到最新")
                    }
                }
            }
        }
        if (session != null) AgentComposer(ui, vm, session, openDecision, openTerminal) {
            scroll.following = true
            vm.send()
        }
    }
}

/** 远程会话展示真实的模型与阶段，卡片边框、间距与完整版输入区保持一致。 */
@Composable
private fun AgentSessionMetadata(ui: TerminalAgentUiState, vm: TerminalAgentViewModel, session: TerminalAgentSession) {
    Surface(color = TbColors.CanvasSoft, shape = RoundedCornerShape(15.dp), border = BorderStroke(1.dp, TbColors.Border)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            AiAgentLogo(session.provider, Modifier.size(22.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    listOf(agentTitle(session.provider), session.model?.takeIf(String::isNotBlank) ?: "服务端默认模型").joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (!ui.starting) Text(
                    relativeActivity(session.lastActivityAt), style = MaterialTheme.typography.labelSmall,
                    color = TbColors.TextMuted, maxLines = 1,
                )
            }
            if (ui.starting) Text("正在启动", style = MaterialTheme.typography.labelSmall, color = TbColors.Accent)
            else AgentPhaseTag(session)
            IconButton(vm::refreshSession, enabled = !ui.loadingMessages && !ui.starting) {
                Icon(Icons.Outlined.Refresh, "刷新会话内容", Modifier.size(19.dp), tint = TbColors.TextMuted)
            }
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

/** 转录只适配消息数据，头像、首行对齐、Markdown 和用户气泡均复用完整版组件。 */
@Composable
private fun AgentReplayMessage(session: TerminalAgentSession, message: AiHistoryMessage) {
    val animated = remember(session.terminalId, session.sessionId, session.revision, message) {
        AiAnimatedMessage(
            AiMessage("agent-${session.terminalId}-${session.sessionId}-${session.revision}-${message.seq}", message.role, message.text, message.timestamp ?: 0),
            animate = false,
        )
    }
    AiMessageBubble(animated, session.provider)
}

/** 只转换工具名称、入参和原始输出，执行记录的折叠与详情直接复用完整版。 */
@Composable
private fun AgentProcessGroup(session: TerminalAgentSession, steps: List<AiHistoryMessage>, onInspect: () -> Unit) {
    val messages = remember(session.terminalId, session.sessionId, session.revision, steps) {
        steps.flatMap { step ->
            val id = "agent-${session.terminalId}-${session.sessionId}-${session.revision}-${step.seq}"
            if (step.role == "assistant") {
                step.tools.mapIndexed { index, tool ->
                    AiMessage("$id-call-$index", "tool", listOf(tool.name, tool.summary).filter(String::isNotBlank).joinToString(" · "))
                }
            } else {
                listOf(AiMessage(id, "tool", processStepSummary(step) + "\n\n" + step.text, step.timestamp ?: 0))
            }
        }.map { AiAnimatedMessage(it, animate = false) }
    }
    if (messages.isNotEmpty()) AiToolGroup(messages, Modifier, onInspect)
}

/** 共享完整版输入框；启动排队、决策入口与终端回复仍由原来的接力 ViewModel 处理。 */
@Composable
private fun AgentComposer(
    ui: TerminalAgentUiState,
    vm: TerminalAgentViewModel,
    session: TerminalAgentSession,
    openDecision: (String) -> Unit,
    openTerminal: () -> Unit,
    send: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ui.sendError?.let { AiError(it, vm::clearSendError) }
                if (session.pendingDecisionCount > 0 && session.pendingDecisionId != null) {
                    Button(
                        { session.pendingDecisionId?.let(openDecision) },
                        Modifier.fillMaxWidth().heightIn(min = 42.dp),
                        shape = RoundedCornerShape(11.dp), colors = primaryButtonColors(), border = primaryControlBorder(),
                    ) {
                        Icon(Icons.Outlined.PendingActions, null, Modifier.size(17.dp))
                        Spacer(Modifier.width(7.dp))
                        Text("待决策 · ${session.pendingDecisionCount} 项待确认", style = MaterialTheme.typography.labelLarge)
                    }
                }
                AgentSessionMetadata(ui, vm, session)
                if (ui.starting) {
                    Text("正在启动，消息将在就绪后发送", Modifier.padding(horizontal = 2.dp),
                        style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                } else if (!session.canReply) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            session.replyBlockedReason ?: "当前阶段暂不支持回复",
                            Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                            maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                        TextButton(openTerminal) { Text("打开终端") }
                    }
                }
            }
        }
        val enabled = (ui.starting || session.canReply) && !ui.closed
        val providerLabel = if (session.provider == "codex") "Codex" else "Claude"
        AiMessageComposer(
            value = ui.draft, onValueChange = vm::draft,
            placeholder = when {
                ui.starting -> "先输入需求，就绪后发送…"
                session.canReply -> "给 $providerLabel 发消息…"
                else -> "当前不可回复"
            },
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

private fun relativeActivity(timestamp: Long?): String {
    if (timestamp == null || timestamp <= 0) return "活动时间未知"
    val minutes = ((System.currentTimeMillis() - timestamp).coerceAtLeast(0)) / 60_000
    return when {
        minutes < 1 -> "刚刚活动"
        minutes < 60 -> "${minutes} 分钟前活动"
        minutes < 24 * 60 -> "${minutes / 60} 小时前活动"
        else -> "更早前活动"
    }
}
