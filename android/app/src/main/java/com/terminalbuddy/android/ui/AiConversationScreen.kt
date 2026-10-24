package com.terminalbuddy.android.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.*
import kotlinx.serialization.json.*

/** 对话二级页：会话摘要、自然段回复与紧凑输入区。 */
@Composable
fun AiConversationScreen(ui: AiUiState, vm: AiViewModel) {
    val session = ui.selected ?: return
    var menu by rememberSaveable(session.id) { mutableStateOf(false) }
    var information by rememberSaveable(session.id) { mutableStateOf(false) }
    var usageInformation by rememberSaveable(session.id) { mutableStateOf(false) }
    var deleting by rememberSaveable(session.id) { mutableStateOf(false) }
    Scaffold(
        modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
        containerColor = TbColors.Surface,
        // 底部统一避让系统导航栏和软键盘，输入框与消息区共享同一可用高度。
        contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom),
        topBar = {
            Surface(color = TbColors.Surface) {
                Column {
                    Row(
                        Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 56.dp).padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(vm::closeSession) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回 AI 首页", Modifier.size(20.dp), tint = TbColors.TextMuted)
                        }
                        Row(Modifier.weight(1f).padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(session.title, Modifier.weight(1f, fill = false),
                                style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            AiReconnectingIndicator(ui.reconnecting)
                        }
                        IconButton({ menu = true }) {
                            Icon(Icons.Outlined.MoreHoriz, "对话操作", Modifier.size(20.dp), tint = TbColors.TextMuted)
                        }
                        ThemeToggleButton()
                    }
                    AiDivider()
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            ui.error?.let { AiError(it, vm::clearError) }
            AiConversation(ui, vm, Modifier.weight(1f), ui.selectedModelLabel, ui.selectedEffortLabel) { usageInformation = true }
        }
    }
    if (menu) {
        AiSheet("对话操作", { menu = false }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                AiConversationAction(Icons.Outlined.Info, "对话信息", { menu = false; information = true })
                AiConversationAction(Icons.Outlined.DataUsage, "上下文与 Token", { menu = false; usageInformation = true })
                AiConversationAction(Icons.Outlined.FolderOpen, "返回首页选择模型", { menu = false; vm.closeSession() })
                AiConversationAction(
                    Icons.Outlined.DeleteOutline, "删除对话", { menu = false; deleting = true },
                    enabled = !session.running && !ui.working, color = TbColors.Danger,
                )
            }
        }
    }
    if (information) {
        AiSheet("对话信息", { information = false }) {
            SelectionContainer(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(16.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    AiInfoField("对话标题", session.title)
                    AiInfoField("项目路径", session.projectPath, monospace = true)
                    AiInfoField("供应商与模型", session.targetLabel)
                    AiInfoField("思考强度", ui.selectedEffortLabel)
                    AiInfoField("当前状态", "${session.statusLabel} · ${if (ui.connected) "实时连接" else "自动同步"}")
                    AiInfoField("消息数量", "${session.messages.size} 条")
                }
            }
        }
    }
    if (usageInformation) AiUsageSheet(session, ui.selectedModelLabel, ui.selectedEffortLabel) { usageInformation = false }
    if (deleting) AiDeleteDialog(session, { deleting = false }) { deleting = false; vm.delete(session) }
}

@Composable
private fun AiConversationAction(
    icon: ImageVector, label: String, onClick: () -> Unit, enabled: Boolean = true, color: Color = TbColors.Text,
) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val tint = if (enabled) color else TbColors.TextMuted.copy(alpha = .5f)
        Icon(icon, null, Modifier.size(18.dp), tint = tint)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = tint)
    }
}

@Composable
private fun AiInfoField(label: String, value: String, monospace: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default)
    }
}

@Composable
private fun AiConversation(
    ui: AiUiState, vm: AiViewModel, modifier: Modifier, modelLabel: String, effortLabel: String,
    usageDetails: () -> Unit,
) {
    val session = ui.selected ?: return
    var usageExpanded by rememberSaveable(session.id) { mutableStateOf(true) }
    val motion = rememberAiConversationMotion(session, ui.loadingSession)
    val entries = motion.entries
    val scroll = rememberAiConversationScroll(session.id, motion.initialized, entries.size)
    val revealing by remember(motion) { derivedStateOf { motion.messages.any { it.isRevealing } } }
    val replying = !ui.loadingSession && (session.running || revealing)
    // 按正文与工具执行阶段切换提示，工具记录 ID 更新时保持状态行，不重新淡入。
    val renderedAssistantOutput by remember(motion) {
        derivedStateOf {
            motion.messages.lastOrNull()?.let {
                it.role == "assistant" && (it.text.isNotBlank() || it.isRevealing)
            } == true
        }
    }
    val latestMessage = session.messages.lastOrNull()
    val assistantOutput = latestMessage?.let { it.role == "assistant" && it.text.isNotBlank() } == true
    val showReplyIndicator = !ui.loadingSession && session.running &&
        (session.status == "approval" || (!assistantOutput && !renderedAssistantOutput && !revealing))
    val elapsedSeconds = rememberAiReplyElapsedSeconds(session, replying)
    BoxWithConstraints(modifier.fillMaxWidth()) {
        // 确认区随键盘后的可用高度收缩，避免把消息区域全部挤出屏幕。
        val approvalMaxHeight = (maxHeight * .45f).coerceIn(120.dp, 260.dp).coerceAtMost(maxHeight)
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    Modifier.widthIn(max = 760.dp).fillMaxSize().align(Alignment.TopCenter).nestedScroll(scroll.gestures),
                    state = scroll.list, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // 流式内容使用实际布局位置，逐字显示与底部跟随负责平滑过渡。
                    items(entries, key = { it.id }) { entry ->
                        when (entry) {
                            is AiConversationEntry.Message -> AiMessageBubble(entry.message, session.providerLabel)
                            is AiConversationEntry.Tools -> AiToolGroup(entry.messages, Modifier) { scroll.following = false }
                        }
                    }
                    if (showReplyIndicator) item(key = "ai-status") {
                        AiReplyIndicator(
                            session.providerLabel, if (session.status == "approval") "等待确认" else "思考中", elapsedSeconds,
                            Modifier.animateItem(fadeInSpec = tween(120), placementSpec = null, fadeOutSpec = null),
                        )
                    }
                    // 保留真实底部锚点，长于一屏的流式回复也能继续跟随。
                    item(key = "ai-bottom") { Spacer(Modifier.height(1.dp)) }
                }
                if (motion.messages.isEmpty() && (!session.running || ui.loadingSession)) {
                    Column(
                        Modifier.align(Alignment.Center).padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        AiAgentBadge(session.provider)
                        Text(
                            if (ui.loadingSession || !motion.initialized) "正在加载消息…" else "发送第一条消息，开始对话。",
                            style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted,
                        )
                    }
                }
                // 展开执行记录会暂停自动跟随，仅在下方仍有内容可滚动时显示返回按钮。
                androidx.compose.animation.AnimatedVisibility(
                    visible = !scroll.following && scroll.list.canScrollForward && motion.messages.isNotEmpty(),
                    modifier = Modifier.align(Alignment.BottomCenter).padding(
                        start = 8.dp, end = if (usageExpanded) 8.dp else 64.dp, bottom = 8.dp),
                    enter = fadeIn(tween(180)) + slideInVertically(tween(220)) { it / 2 },
                    exit = fadeOut(tween(120)) + slideOutVertically(tween(160)) { it / 2 },
                ) {
                    FilledTonalButton(
                        { scroll.following = true }, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                        elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = 2.dp),
                    ) {
                        Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("回到最新")
                    }
                }
                if (!usageExpanded) {
                    Box(Modifier.align(Alignment.BottomCenter).widthIn(max = 760.dp).fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 8.dp), contentAlignment = Alignment.BottomEnd) {
                        AiUsageExpandButton(onClick = { usageExpanded = true })
                    }
                }
            }
            session.error?.let {
                Text(
                    it, Modifier.fillMaxWidth().heightIn(max = 72.dp).verticalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    color = TbColors.Danger, style = MaterialTheme.typography.bodySmall,
                )
            }
            session.approvals.firstOrNull()?.let { AiApprovalCard(it, ui.working, approvalMaxHeight, vm::answer) }
            Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                AiUsageCard(session, modelLabel, effortLabel, usageDetails,
                    expanded = usageExpanded, onExpandedChange = { usageExpanded = it },
                    modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth())
            }
            AiComposer(ui, session, { scroll.following = true; vm.send() }, vm::stop, vm::draft)
        }
    }
}

/** 发送后仍可编辑下一条消息，输入框左侧独立显示请求发送进度。 */
@Composable
private fun AiComposer(
    ui: AiUiState, session: AiSession, send: () -> Unit, stop: () -> Unit, draft: (String) -> Unit,
) {
    val actionEnabled = if (session.running) !ui.working else ui.draft.isNotBlank() && !ui.sending && !ui.loadingSession
    Surface(color = TbColors.Surface) {
        Box(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                Modifier.widthIn(max = 760.dp).fillMaxWidth(), color = TbColors.CanvasSoft,
                border = BorderStroke(1.dp, TbColors.Border), shape = RoundedCornerShape(14.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                    if (ui.sending) {
                        Box(Modifier.width(36.dp).height(48.dp).semantics { contentDescription = "消息发送中" },
                            contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(18.dp), color = TbColors.Accent, strokeWidth = 2.dp)
                        }
                    }
                    BasicTextField(
                        value = ui.draft, onValueChange = draft,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                            .padding(start = 12.dp, end = 4.dp, top = 12.dp, bottom = 12.dp)
                            .semantics { contentDescription = "消息输入框" },
                        enabled = !ui.loadingSession, minLines = 1, maxLines = 4,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = TbColors.Text, fontSize = 14.sp, lineHeight = 20.sp),
                        cursorBrush = SolidColor(TbColors.Accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                        decorationBox = { innerTextField ->
                            Box(contentAlignment = Alignment.CenterStart) {
                                if (ui.draft.isEmpty()) Text(
                                    "给 ${session.providerLabel} 发消息…", color = TbColors.TextMuted,
                                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                innerTextField()
                            }
                        },
                    )
                    IconButton(
                        if (session.running) stop else send, enabled = actionEnabled, modifier = Modifier.size(48.dp)
                            .semantics { contentDescription = if (session.running) "中断回复" else if (ui.sending) "正在发送" else "发送消息" },
                    ) {
                        Box(
                            Modifier.size(32.dp).background(
                                TbColors.Accent.copy(alpha = if (actionEnabled) 1f else .35f), RoundedCornerShape(10.dp),
                            ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                if (session.running) Icons.Outlined.Stop else Icons.Outlined.ArrowUpward, null,
                                Modifier.size(18.dp), tint = TbColors.AccentInk,
                            )
                        }
                    }
                }
            }
        }
    }
}

private val AiAvatarSize = 28.dp

/** 用户消息为右侧小气泡，助手正文与思考状态共用左侧头像。 */
@Composable
private fun AiMessageBubble(message: AiAnimatedMessage, provider: String, modifier: Modifier = Modifier) {
    val mine = message.role == "user"
    val entrance by animateFloatAsState(
        if (message.entered) 1f else 0f,
        animationSpec = tween(if (mine) 280 else 160, easing = FastOutSlowInEasing), label = "ai-message-entrance",
    )
    LaunchedEffect(message) { message.entered = true }
    val animated = modifier.fillMaxWidth().graphicsLayer {
        alpha = entrance
        translationY = if (mine) (1f - entrance) * 10.dp.toPx() else 0f
    }
    if (mine) {
        Box(animated, contentAlignment = Alignment.CenterEnd) {
            Surface(
                Modifier.padding(start = 28.dp).widthIn(max = 600.dp).animateContentSize(tween(160, easing = LinearOutSlowInEasing)),
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
    } else {
        val textStyle = MaterialTheme.typography.bodyMedium.copy(
            fontSize = 14.sp, lineHeight = 20.sp,
            lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
        )
        val firstLineHeight = with(LocalDensity.current) { textStyle.lineHeight.toDp() }
        // 头像与首行的中心对齐；字体放大时调整头像，换行时仍锚定首行。
        val avatarTopPadding = ((firstLineHeight - AiAvatarSize) / 2).coerceAtLeast(0.dp)
        val textTopPadding = ((AiAvatarSize - firstLineHeight) / 2).coerceAtLeast(0.dp)
        Row(animated, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            AiAvatar(provider, Modifier.padding(top = avatarTopPadding))
            if (message.role == "assistant") {
                AiMarkdownContent(message, textStyle, Modifier.weight(1f).padding(top = textTopPadding))
            } else {
                SelectionContainer(Modifier.weight(1f).padding(top = textTopPadding)) {
                    Text(message.text, style = textStyle)
                }
            }
        }
    }
}

/** 相邻工具调用合并成一组，默认只露出最新记录，展开后按原始顺序查看历史。 */
@Composable
private fun AiToolGroup(messages: List<AiAnimatedMessage>, modifier: Modifier, onInspect: () -> Unit) {
    var expanded by rememberSaveable(messages.first().id) { mutableStateOf(false) }
    val latest = messages.last()
    val hasHistory = messages.size > 1
    Column(
        modifier.fillMaxWidth().padding(start = 38.dp)
            .animateContentSize(tween(160, easing = LinearOutSlowInEasing)),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = hasHistory, role = Role.Button) {
                expanded = !expanded
                if (expanded) onInspect()
            }.semantics { stateDescription = if (expanded) "已展开历史记录" else "已折叠历史记录" }
                .heightIn(min = 44.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(15.dp), tint = TbColors.TextMuted)
            Text("执行记录", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            Text(
                messages.size.toString(), Modifier.background(TbColors.CanvasSoft, RoundedCornerShape(5.dp))
                    .padding(horizontal = 5.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
            )
            Spacer(Modifier.weight(1f))
            if (hasHistory) {
                Text(
                    if (expanded) "收起记录" else "展开 " + (messages.size - 1) + " 条",
                    style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                )
                Icon(
                    if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null,
                    Modifier.size(15.dp), tint = TbColors.TextMuted,
                )
            }
        }
        val visibleMessages = if (expanded) messages else listOf(latest)
        visibleMessages.forEach { message ->
            key(message.id) {
                val isLatest = message.id == latest.id
                if (isLatest) AiDivider()
                AiToolMessage(message, isLatest, onInspect)
            }
        }
    }
}

@Composable
private fun AiToolMessage(message: AiAnimatedMessage, latest: Boolean, onInspect: () -> Unit) {
    var expanded by rememberSaveable(message.id) { mutableStateOf(false) }
    val summary = remember(message.text) {
        val firstLine = message.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
        // 结构化工具输出只在详情中展示，避免把 JSON 挤进摘要行。
        if (firstLine.startsWith("{") || firstLine.startsWith("[")) "工具返回结果" else firstLine.ifBlank { "执行过程" }
    }
    Column(Modifier.fillMaxWidth().animateContentSize(tween(160, easing = LinearOutSlowInEasing))) {
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button) {
                expanded = !expanded
                if (expanded) onInspect()
            }.semantics { stateDescription = if (expanded) "已展开记录详情" else "已折叠记录详情" }
                .heightIn(min = 44.dp).padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Outlined.Terminal, null, Modifier.size(15.dp),
                tint = if (latest) TbColors.Accent else TbColors.TextMuted,
            )
            Text(
                summary, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                color = if (latest) TbColors.Text else TbColors.TextSoft,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (latest) Text("最新", style = MaterialTheme.typography.labelMedium, color = TbColors.Accent)
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null,
                Modifier.size(14.dp), tint = TbColors.TextMuted,
            )
        }
        if (expanded) {
            Surface(color = TbColors.CanvasSoft, shape = RoundedCornerShape(8.dp)) {
                SelectionContainer(Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState())) {
                    Text(
                        message.text, Modifier.padding(10.dp), fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextSoft,
                    )
                }
            }
        }
    }
}

@Composable
private fun AiAvatar(provider: String, modifier: Modifier = Modifier) {
    Box(
        modifier.size(AiAvatarSize).background(TbColors.Accent.copy(alpha = .1f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        AiAgentLogo(provider, Modifier.size(20.dp), contentDescription = "$provider 头像")
    }
}

@Composable
private fun AiReplyIndicator(provider: String, label: String, elapsedSeconds: Long, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        AiAvatar(provider)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, color = TbColors.TextMuted, style = MaterialTheme.typography.bodySmall)
            AiConnectionSpinner(TbColors.Accent, Modifier.size(14.dp))
            Text(
                (elapsedSeconds / 60).toString().padStart(2, '0') + ":" + (elapsedSeconds % 60).toString().padStart(2, '0'),
                color = TbColors.TextMuted, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/** Codex 操作确认 / 用户问题：无 questions 为二元确认，有 questions 时逐题作答。 */
@Composable
private fun AiApprovalCard(approval: AiApproval, working: Boolean, maxHeight: Dp, answer: (AiApproval, String, JsonObject) -> Unit) {
    var responses by remember(approval.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    val questions = approval.details.rows("questions").map { it.asObject() }
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp).heightIn(max = maxHeight),
        color = TbColors.SurfaceHover, shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, TbColors.Border),
    ) {
        Column(Modifier.padding(horizontal = 10.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Outlined.VerifiedUser, null, Modifier.size(16.dp), tint = TbColors.Accent)
                Text(if (questions.isEmpty()) "需要你确认" else "AI 需要你的回复", style = MaterialTheme.typography.titleSmall)
            }
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (questions.isEmpty()) SelectionContainer {
                    Text(
                        approval.details.text("command", "reason", fallback = "是否允许本次文件修改或命令执行？"),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                questions.forEach { question ->
                    val id = question.text("id")
                    Text(question.text("question", "header"), style = MaterialTheme.typography.bodyMedium)
                    question.rows("options").forEach { option ->
                        val label = option.asObject().text("label")
                        TextButton(
                            { responses = responses + (id to label) }, enabled = !working, modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
                        ) {
                            RadioButton(selected = responses[id] == label, onClick = null, enabled = !working)
                            Spacer(Modifier.width(8.dp))
                            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    OutlinedTextField(
                        responses[id].orEmpty(), { responses = responses + (id to it) }, Modifier.fillMaxWidth(),
                        label = { Text("回复") }, maxLines = 3, enabled = !working, shape = RoundedCornerShape(10.dp),
                        textStyle = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                TextButton({ answer(approval, "decline", JsonObject(emptyMap())) }, enabled = !working) { Text("拒绝") }
                TextButton(
                    {
                        val values = buildJsonObject {
                            responses.forEach { (id, value) ->
                                put(id, buildJsonObject { put("answers", buildJsonArray { add(value) }) })
                            }
                        }
                        answer(approval, "accept", values)
                    },
                    enabled = !working && questions.all { responses[it.text("id")]?.isNotBlank() == true },
                ) {
                    Text(if (questions.isEmpty()) "允许本次" else "发送回复")
                }
            }
        }
    }
}
