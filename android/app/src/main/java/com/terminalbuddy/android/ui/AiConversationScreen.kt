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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.*
import kotlinx.serialization.json.*

/** 对话二级页：两行导航、自然段回复与紧凑输入区。 */
@Composable
fun AiConversationScreen(ui: AiUiState, vm: AiViewModel) {
    val session = ui.selected ?: return
    var menu by rememberSaveable(session.id) { mutableStateOf(false) }
    var information by rememberSaveable(session.id) { mutableStateOf(false) }
    var deleting by rememberSaveable(session.id) { mutableStateOf(false) }
    val status = when {
        ui.loadingSession -> "正在加载"
        session.running || session.status == "error" || session.status == "interrupted" -> session.statusLabel
        ui.connected -> "实时同步"
        else -> "自动同步"
    }
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
                        Column(Modifier.weight(1f).padding(start = 4.dp)) {
                            Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                AiStatusDot(
                                    when {
                                        session.status == "error" -> TbColors.Danger
                                        ui.connected || session.running -> TbColors.Accent
                                        else -> TbColors.TextMuted
                                    }
                                )
                                Text(
                                    "${session.providerLabel} · ${session.modelLabel} · $status",
                                    style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        if (ui.loadingSession) CircularProgressIndicator(
                            Modifier.padding(horizontal = 8.dp).size(18.dp), strokeWidth = 2.dp,
                        )
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
            AiConversation(ui, vm, Modifier.weight(1f))
        }
    }
    if (menu) {
        AiSheet("对话操作", { menu = false }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                AiConversationAction(Icons.Outlined.Info, "对话信息", { menu = false; information = true })
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
                    AiInfoField("当前状态", "${session.statusLabel} · ${if (ui.connected) "实时连接" else "自动同步"}")
                    AiInfoField("消息数量", "${session.messages.size} 条")
                }
            }
        }
    }
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
private fun AiConversation(ui: AiUiState, vm: AiViewModel, modifier: Modifier) {
    val session = ui.selected ?: return
    val motion = rememberAiConversationMotion(session, ui.loadingSession)
    val scroll = rememberAiConversationScroll(session.id, motion.initialized, motion.messages.size)
    val revealing by remember(motion) { derivedStateOf { motion.messages.any { it.isRevealing } } }
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
                    items(motion.messages, key = { it.id }) { message ->
                        AiMessageBubble(
                            message, session.providerLabel,
                            Modifier.animateItem(
                                fadeInSpec = null, placementSpec = spring(stiffness = Spring.StiffnessMediumLow),
                                fadeOutSpec = tween(140),
                            ),
                        )
                    }
                    if (session.running || revealing) item(key = "ai-status") {
                        AiReplyIndicator(
                            if (session.running) session.statusLabel else "正在回复",
                            Modifier.animateItem(placementSpec = spring(stiffness = Spring.StiffnessMediumLow)),
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
                        AiSmallIcon(Icons.Outlined.AutoAwesome)
                        Text(
                            if (ui.loadingSession || !motion.initialized) "正在加载消息…" else "发送第一条消息，开始对话。",
                            style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted,
                        )
                    }
                }
                androidx.compose.animation.AnimatedVisibility(
                    visible = !scroll.following && motion.messages.isNotEmpty(),
                    modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
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
            }
            session.error?.let {
                Text(
                    it, Modifier.fillMaxWidth().heightIn(max = 72.dp).verticalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    color = TbColors.Danger, style = MaterialTheme.typography.bodySmall,
                )
            }
            session.approvals.firstOrNull()?.let { AiApprovalCard(it, ui.working, approvalMaxHeight, vm::answer) }
            AiComposer(ui, session, { scroll.following = true; vm.send() }, vm::stop, vm::draft)
        }
    }
}

/** 48dp 单行输入区：随输入增高，最多四行；按钮保留完整触控区域。 */
@Composable
private fun AiComposer(ui: AiUiState, session: AiSession, send: () -> Unit, stop: () -> Unit, draft: (String) -> Unit) {
    val actionEnabled = if (session.running) !ui.working else ui.draft.isNotBlank() && !ui.sending && !ui.loadingSession
    Surface(color = TbColors.Surface) {
        Column {
            AiDivider()
            Box(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Surface(
                    Modifier.widthIn(max = 760.dp).fillMaxWidth(), color = TbColors.CanvasSoft,
                    border = BorderStroke(1.dp, TbColors.Border), shape = RoundedCornerShape(14.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
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
                                Box {
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
                                if (ui.sending && !session.running) CircularProgressIndicator(
                                    Modifier.size(16.dp), color = TbColors.AccentInk, strokeWidth = 2.dp,
                                )
                                else Icon(
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
}

/** 用户消息为右侧小气泡，助手为左侧自然段 + 小标记，工具调用为可折叠卡片。 */
@Composable
private fun AiMessageBubble(message: AiAnimatedMessage, provider: String, modifier: Modifier = Modifier) {
    val mine = message.role == "user"
    val entrance by animateFloatAsState(
        if (message.entered) 1f else 0f,
        animationSpec = tween(280, easing = FastOutSlowInEasing), label = "ai-message-entrance",
    )
    LaunchedEffect(message) { message.entered = true }
    val animated = modifier.fillMaxWidth().graphicsLayer {
        alpha = entrance
        translationY = (1f - entrance) * 10.dp.toPx()
    }
    if (message.role == "tool") {
        AiToolMessage(message, animated.padding(start = 28.dp))
    } else if (mine) {
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
        Row(animated, horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.Top) {
            Box(
                Modifier.padding(top = 1.dp).size(21.dp).background(TbColors.SurfaceHover, RoundedCornerShape(7.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.AutoAwesome, "$provider 回复", Modifier.size(13.dp), tint = TbColors.Accent)
            }
            SelectionContainer(Modifier.weight(1f).animateContentSize(tween(160, easing = LinearOutSlowInEasing))) {
                Text(message.text, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp))
            }
        }
    }
}

@Composable
private fun AiToolMessage(message: AiAnimatedMessage, modifier: Modifier) {
    var expanded by rememberSaveable(message.id) { mutableStateOf(false) }
    val summary = message.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty().ifBlank { "执行过程" }
    Surface(
        modifier.animateContentSize(tween(160, easing = LinearOutSlowInEasing)), color = TbColors.CanvasSoft,
        shape = RoundedCornerShape(9.dp), border = BorderStroke(1.dp, TbColors.BorderSoft),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { expanded = !expanded }
                    .heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Outlined.Terminal, null, Modifier.size(15.dp), tint = TbColors.TextMuted)
                Text(
                    summary, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(if (expanded) "收起" else "展开", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(15.dp), tint = TbColors.TextMuted)
            }
            if (expanded) {
                AiDivider()
                SelectionContainer {
                    Text(
                        message.text, Modifier.fillMaxWidth().padding(10.dp), fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextSoft,
                    )
                }
            }
        }
    }
}

@Composable
private fun AiReplyIndicator(label: String, modifier: Modifier = Modifier) {
    val pulse = rememberInfiniteTransition(label = "ai-typing")
    Row(
        modifier.padding(start = 28.dp, top = 2.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.height(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            repeat(3) { index ->
                val opacity by pulse.animateFloat(
                    initialValue = .3f, targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        tween(450, easing = FastOutSlowInEasing), RepeatMode.Reverse,
                        initialStartOffset = StartOffset(index * 150),
                    ),
                    label = "ai-typing-dot-$index",
                )
                Box(
                    Modifier.size(3.dp).graphicsLayer {
                        alpha = opacity
                        translationY = -2.dp.toPx() * opacity
                    }.background(TbColors.Accent, CircleShape)
                )
            }
        }
        Text(label, color = TbColors.TextMuted, style = MaterialTheme.typography.bodySmall)
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
