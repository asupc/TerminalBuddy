package com.terminalbuddy.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.TerminalAgentUiState
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.TerminalReplyStatus
import com.terminalbuddy.android.data.AiHistoryMessage
import com.terminalbuddy.android.data.AiHistoryTool
import com.terminalbuddy.android.data.AiMessage
import com.terminalbuddy.android.data.TerminalAgentSession

/**
 * 终端 Agent 会话的对话页：只读镜像以气泡展示（replay 消息不做逐字动画），
 * 受限回复单行输入；有待决策时引导到唯一的决策 Host。不显示 token 用量。
 */
@Composable
internal fun TerminalAgentChatScreen(
    ui: TerminalAgentUiState,
    vm: TerminalAgentViewModel,
    openDecision: (String) -> Unit,
    openTerminal: () -> Unit,
) {
    val session = ui.selected
    val listState = rememberLazyListState()
    // 首屏直接到底；之后仅在接近底部时跟随新消息，上滑阅读不被打断。
    var loadedOnce by remember { mutableStateOf(false) }
    LaunchedEffect(ui.messages.size, ui.pendingReply) {
        val count = listState.layoutInfo.totalItemsCount
        if (count > 0) {
            val nearBottom = (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= count - 3
            if (!loadedOnce || nearBottom) listState.animateScrollToItem(count - 1)
        }
        if (ui.messages.isNotEmpty()) loadedOnce = true
    }
    // edge-to-edge 下 adjustResize 不生效，输入法避让必须用 imePadding（与终端页签一致）。
    Column(Modifier.fillMaxSize().imePadding()) {
        AgentStatusStrip(ui, vm)
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
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f), state = listState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (ui.loadingMessages && ui.messages.isEmpty()) item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = TbColors.Accent)
                    }
                }
                items(ui.messages, key = { "agent-msg-${it.seq}" }) { message ->
                    AgentReplayMessage(session, message)
                }
                if (ui.sending) item(key = "sending") {
                    AgentPendingRow(text = "", label = "正在发送…", color = TbColors.TextMuted, spinning = true)
                }
                ui.pendingReply?.let { pending ->
                    item(key = "pending-reply") {
                        val (color, spinning) = when (pending.status) {
                            TerminalReplyStatus.Typed -> TbColors.TextMuted to false
                            TerminalReplyStatus.Delivered -> TbColors.Accent to false
                            // REST 已接受即写入成功，超时只代表 Agent 尚未处理，不是错误警示。
                            TerminalReplyStatus.Unconfirmed -> TbColors.TextMuted to false
                        }
                        AgentPendingRow(pending.text, pending.statusLabel, color, spinning)
                    }
                }
                if (!ui.loadingMessages && ui.messages.isEmpty() && ui.pendingReply == null && !ui.sending) {
                    item(key = "empty") {
                        Text(
                            "会话还没有可展示的消息；终端里产生的新内容会按条出现在这里。",
                            Modifier.fillMaxWidth().padding(vertical = 16.dp),
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
        if (session != null) AgentComposer(ui, vm, session, openDecision, openTerminal)
    }
}

/** 顶部信息条：阶段、模型、最后活动与镜像连接状态、手动刷新。 */
@Composable
private fun AgentStatusStrip(ui: TerminalAgentUiState, vm: TerminalAgentViewModel) {
    val session = ui.selected
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        if (session != null) {
            AgentPhaseTag(session)
            session.model?.takeIf(String::isNotBlank)?.let { model ->
                Text(model, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(relativeActivity(session.lastActivityAt), style = MaterialTheme.typography.labelSmall,
                color = TbColors.TextMuted, maxLines = 1)
        }
        Spacer(Modifier.weight(1f))
        if (ui.reconnecting && !ui.closed) {
            AiConnectionSpinner(TbColors.Accent, Modifier.size(13.dp))
            Text("重连中", style = MaterialTheme.typography.labelSmall, color = TbColors.Accent)
        }
        IconButton({ vm.refreshSession() }, enabled = session != null && !ui.loadingMessages) {
            Icon(Icons.Outlined.Refresh, "刷新会话内容", Modifier.size(19.dp), tint = TbColors.TextMuted)
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

/** 本地待确认 / 发送中的回复：右侧气泡 + 状态小字。 */
@Composable
private fun AgentPendingRow(text: String, label: String, color: Color, spinning: Boolean) {
    if (text.isNotBlank()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(
            color = TbColors.Accent.copy(alpha = .14f),
            shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp, bottomEnd = 3.dp, bottomStart = 12.dp),
        ) {
            SelectionContainer {
                Text(
                    text, Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
                )
            }
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(top = 2.dp), horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (spinning) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = color)
        Spacer(Modifier.width(5.dp))
        Text(label, style = MaterialTheme.typography.labelSmall, color = color)
    }
}

/** 单条 replay 消息：user 右气泡、assistant Markdown + 工具折叠、tool 记录折叠、system 灰字。 */
@Composable
private fun AgentReplayMessage(session: TerminalAgentSession, message: AiHistoryMessage) {
    when (message.role) {
        "user" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(
                Modifier.widthIn(max = 600.dp),
                color = TbColors.Accent.copy(alpha = .14f),
                shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp, bottomEnd = 3.dp, bottomStart = 12.dp),
            ) {
                SelectionContainer {
                    Text(
                        message.text, Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
                    )
                }
            }
        }
        "assistant" -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Top) {
                Box(
                    Modifier.size(26.dp).background(TbColors.Accent.copy(alpha = .1f), RoundedCornerShape(9.dp)),
                    contentAlignment = Alignment.Center,
                ) { AiAgentLogo(session.provider, Modifier.size(17.dp)) }
                // 按历史回放的方式包装 animate=false：不引入逐字动画状态。
                val animated = remember(session.terminalId, session.revision, message.seq, message.text) {
                    AiAnimatedMessage(
                        AiMessage(
                            "agent-${session.terminalId}-${message.seq}", "assistant",
                            message.text, message.timestamp ?: 0,
                        ),
                        animate = false,
                    )
                }
                AiMarkdownContent(
                    animated, MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
                    Modifier.weight(1f),
                )
            }
            if (message.tools.isNotEmpty()) AgentToolCalls(session.terminalId, message.seq, message.tools)
        }
        "tool" -> AgentToolRecord(message)
        else -> SelectionContainer(Modifier.fillMaxWidth()) {
            Text(
                message.text, Modifier.padding(vertical = 2.dp),
                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
            )
        }
    }
}

/** assistant 消息附带的工具调用列表：默认只露最新一条摘要，点击展开全部。 */
@Composable
private fun AgentToolCalls(sessionKey: String, seq: Long, tools: List<AiHistoryTool>) {
    var expanded by rememberSaveable("calls-$sessionKey-$seq") { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(start = 36.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }
                .heightIn(min = 36.dp).padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(14.dp), tint = TbColors.TextMuted)
            Text("工具调用", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
            Text(
                tools.size.toString(), Modifier.background(TbColors.CanvasSoft, RoundedCornerShape(5.dp))
                    .padding(horizontal = 5.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
            )
            Spacer(Modifier.weight(1f))
            Text(
                if (expanded) "收起" else "展开", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
            )
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null,
                Modifier.size(14.dp), tint = TbColors.TextMuted,
            )
        }
        val shown = if (expanded) tools else tools.take(1)
        shown.forEach { tool ->
            SelectionContainer {
                Text(
                    listOf(tool.name, tool.summary).filter(String::isNotBlank).joinToString(" · "),
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                    color = TbColors.TextSoft, maxLines = if (expanded) 3 else 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** role=tool 的执行记录：折叠摘要，展开显示原始输出。 */
@Composable
private fun AgentToolRecord(message: AiHistoryMessage) {
    var expanded by rememberSaveable("record-${message.seq}") { mutableStateOf(false) }
    val firstLine = message.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    val summary = if (firstLine.startsWith("{") || firstLine.startsWith("[")) "工具返回结果"
        else firstLine.ifBlank { "执行过程" }
    Column(Modifier.fillMaxWidth().padding(start = 36.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }
                .heightIn(min = 36.dp).padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(14.dp), tint = TbColors.Accent)
            Text(
                "${message.toolName ?: "工具"} · $summary", Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall, color = TbColors.TextSoft,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null,
                Modifier.size(14.dp), tint = TbColors.TextMuted,
            )
        }
        if (expanded) Surface(color = TbColors.CanvasSoft, shape = RoundedCornerShape(8.dp)) {
            SelectionContainer(Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState())) {
                Text(
                    message.text, Modifier.padding(10.dp), fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextSoft,
                )
            }
        }
    }
}

/** 输入区：默认开启；canReply=false 禁用并显示服务端原因；待决策置顶引导到唯一决策 Host。 */
@Composable
private fun AgentComposer(
    ui: TerminalAgentUiState,
    vm: TerminalAgentViewModel,
    session: TerminalAgentSession,
    openDecision: (String) -> Unit,
    openTerminal: () -> Unit,
) {
    Surface(color = TbColors.Surface) {
        Column(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ui.sendError?.let { AiError(it, vm::clearSendError) }
            if (session.pendingDecisionCount > 0 && session.pendingDecisionId != null) {
                Button(
                    { session.pendingDecisionId?.let(openDecision) },
                    Modifier.fillMaxWidth().heightIn(min = 42.dp),
                    shape = RoundedCornerShape(11.dp), colors = primaryButtonColors(), border = primaryControlBorder(),
                ) {
                    Icon(Icons.Outlined.PendingActions, null, Modifier.size(17.dp))
                    Spacer(Modifier.width(7.dp))
                    Text(
                        if (session.pendingDecisionCount > 1) "待决策 · ${session.pendingDecisionCount} 项待确认"
                        else "待决策 · 1 项待确认",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
            if (session.provider == "codex" && session.canReply) {
                Text(
                    "Codex · 回复将作为一行输入写入终端，确认操作请在终端处理",
                    style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                )
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
            val enabled = session.canReply && !ui.sending && !ui.closed
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                OutlinedTextField(
                    ui.draft, vm::draft, Modifier.weight(1f),
                    placeholder = { Text(if (session.canReply) "回复一句，将写入终端" else "当前不可回复", style = MaterialTheme.typography.bodyMedium) },
                    singleLine = true, enabled = enabled,
                    textStyle = MaterialTheme.typography.bodyMedium,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { vm.send() }),
                    shape = RoundedCornerShape(12.dp),
                )
                IconButton(
                    vm::send, enabled = enabled && ui.draft.isNotBlank(),
                    modifier = Modifier.size(44.dp).semantics { contentDescription = "发送到终端" },
                ) {
                    if (ui.sending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = TbColors.Accent)
                    else Icon(Icons.Outlined.ArrowUpward, null, Modifier.size(19.dp),
                        tint = if (enabled && ui.draft.isNotBlank()) TbColors.Accent else TbColors.TextMuted)
                }
            }
            Text(
                "仅支持一句纯文本，会作为按键写入终端；斜杠命令、多行与控制字符不可用。",
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
            )
        }
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
