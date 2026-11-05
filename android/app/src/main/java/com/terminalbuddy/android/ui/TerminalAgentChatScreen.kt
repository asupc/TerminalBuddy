package com.terminalbuddy.android.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.semantics.stateDescription
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
 * 连续的思考/执行步骤折叠成一个块；受限回复支持多行（回车换行）；有待决策时引导到唯一的决策 Host。
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
    // edge-to-edge 下 adjustResize 不生效：底部同时避让系统导航栏与软键盘（取两者最大值），
    // 输入框不会在键盘弹起时被遮住，键盘收起后也不会压到手势导航条。
    Column(
        Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
    ) {
        AgentStatusStrip(ui, vm)
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
            val entries = remember(ui.messages) { groupAgentChatEntries(ui.messages) }
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
                items(entries, key = { it.key }) { entry ->
                    when (entry) {
                        is AgentChatEntry.Message -> AgentReplayMessage(session, entry.message)
                        is AgentChatEntry.Process -> AgentProcessGroup(entry.steps)
                    }
                }
                if (ui.sending) item(key = "sending") {
                    AgentPendingRow(text = "", label = "正在发送…", color = TbColors.TextMuted, spinning = true)
                }
                ui.pendingReply?.let { pending ->
                    item(key = "pending-reply") {
                        val (color, spinning) = when (pending.status) {
                            TerminalReplyStatus.Queued -> TbColors.TextMuted to false
                            TerminalReplyStatus.Typed -> TbColors.TextMuted to false
                            TerminalReplyStatus.Delivered -> TbColors.Accent to false
                            // REST 已接受即写入成功，超时只代表 Agent 尚未处理，不是错误警示。
                            TerminalReplyStatus.Unconfirmed -> TbColors.TextMuted to false
                        }
                        AgentPendingRow(pending.text, pending.statusLabel, color, spinning)
                    }
                }
                // 队列中尚未发出的输入：启动态等待 Agent 就绪，就绪后逐条自动发出。
                itemsIndexed(ui.queuedReplies, key = { index, _ -> "queued-$index" }) { index, text ->
                    AgentPendingRow(
                        text,
                        when {
                            index == 0 && ui.starting -> "Agent 启动后自动发送"
                            index == 0 -> "即将发送"
                            else -> "排队中"
                        },
                        TbColors.TextMuted, false,
                    )
                }
                if (!ui.loadingMessages && ui.messages.isEmpty() && ui.pendingReply == null &&
                    ui.queuedReplies.isEmpty() && !ui.sending
                ) {
                    item(key = "empty") {
                        Text(
                            "会话已就绪，还没有消息；发送第一条消息后，对话会按条显示在这里。",
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
            if (ui.starting) {
                // 启动态没有服务端元数据，阶段标签按「正在启动」显示，不误导为「运行中」。
                Surface(color = TbColors.Accent.copy(alpha = .16f), shape = RoundedCornerShape(5.dp)) {
                    Text(
                        "正在启动", Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelSmall, color = TbColors.Accent, maxLines = 1,
                    )
                }
            } else {
                AgentPhaseTag(session)
            }
            session.model?.takeIf(String::isNotBlank)?.let { model ->
                Text(model, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (!ui.starting) Text(relativeActivity(session.lastActivityAt), style = MaterialTheme.typography.labelSmall,
                color = TbColors.TextMuted, maxLines = 1)
        }
        Spacer(Modifier.weight(1f))
        if (ui.reconnecting && !ui.closed) {
            AiConnectionSpinner(TbColors.Accent, Modifier.size(13.dp))
            Text("重连中", style = MaterialTheme.typography.labelSmall, color = TbColors.Accent)
        }
        IconButton({ vm.refreshSession() }, enabled = session != null && !ui.loadingMessages && !ui.starting) {
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

/** 连续的思考/执行步骤合并成一个折叠块：默认只露出最新一步，展开后按原始顺序查看全部。 */
@Composable
private fun AgentProcessGroup(steps: List<AiHistoryMessage>) {
    // 只以首条 seq 作 key：同一步骤组追加新记录时保持展开状态。
    var expanded by rememberSaveable(steps.first().seq) { mutableStateOf(false) }
    val latest = steps.last()
    val summary = remember(latest) { processStepSummary(latest) }
    Column(
        Modifier.fillMaxWidth().animateContentSize(tween(160, easing = LinearOutSlowInEasing)),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }
                .semantics { stateDescription = if (expanded) "已展开思考过程" else "已折叠思考过程" }
                .heightIn(min = 40.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(14.dp), tint = TbColors.TextMuted)
            Text("思考过程", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            Text(
                steps.size.toString(), Modifier.background(TbColors.CanvasSoft, RoundedCornerShape(5.dp))
                    .padding(horizontal = 5.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
            )
            Spacer(Modifier.weight(1f))
            Text(
                summary, Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextSoft,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null,
                Modifier.size(14.dp), tint = TbColors.TextMuted,
            )
        }
        if (expanded) {
            Column(Modifier.fillMaxWidth()) {
                steps.forEach { step ->
                    key(step.seq) {
                        if (step.role == "assistant") AgentToolCallLine(step.tools)
                        else AgentToolRecord(step)
                    }
                }
            }
        }
    }
}

/** 思考过程展开后的助手工具调用行：工具名 · 入参摘要。 */
@Composable
private fun AgentToolCallLine(tools: List<AiHistoryTool>) {
    Column(Modifier.fillMaxWidth().padding(start = 36.dp)) {
        tools.forEach { tool ->
            SelectionContainer {
                Text(
                    listOf(tool.name, tool.summary).filter(String::isNotBlank).joinToString(" · "),
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                    color = TbColors.TextSoft, maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
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
            if (ui.starting) {
                Text(
                    "Agent 正在启动，输入会排队，就绪后自动发送",
                    style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                )
            } else if (session.provider == "codex" && session.canReply) {
                Text(
                    "Codex · 回复将写入终端，确认操作请在终端处理",
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
            // 启动态与在途发送同样允许输入：新内容进待发队列，按顺序发出。
            val enabled = (ui.starting || session.canReply) && !ui.closed
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                OutlinedTextField(
                    ui.draft, vm::draft, Modifier.weight(1f),
                    placeholder = {
                        Text(
                            when {
                                ui.starting -> "Agent 正在启动，可先输入需求"
                                session.canReply -> "回复内容，回车换行，点右侧发送"
                                else -> "当前不可回复"
                            },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    },
                    minLines = 1, maxLines = 4, enabled = enabled,
                    textStyle = MaterialTheme.typography.bodyMedium,
                    // 回车默认插入换行（多行草稿），发送统一走右侧按钮。
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
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
