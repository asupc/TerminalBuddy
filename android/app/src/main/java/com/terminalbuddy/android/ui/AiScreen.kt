package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.*
import kotlinx.serialization.json.*

/**
 * Ai 首页：服务连接、项目/供应商/模型选择、最近对话。
 * 移植自葫芦娃 Android `ui/AiScreen.kt`，数据来源换成 TerminalBuddy 后端。
 */
@Composable
fun AiScreen(ui: AiUiState, vm: AiViewModel) {
    var connection by rememberSaveable { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<AiSession?>(null) }
    BackHandler(connection) { connection = false }
    LaunchedEffect(ui.authenticated, ui.connectionRevision) { if (ui.authenticated) connection = false }
    if (!ui.authenticated || connection) {
        AiConnection(
            ui,
            { server, username, password -> vm.login(server, username, password) },
            if (ui.authenticated) ({ connection = false }) else null,
        )
        return
    }
    Column(Modifier.fillMaxSize()) {
        PageHeader("AI 对话") {
            IconButton(vm::refresh, enabled = !ui.loading) {
                if (ui.loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Icon(Icons.Outlined.Refresh, "刷新项目和模型")
            }
            var menu by remember { mutableStateOf(false) }
            Box {
                IconButton({ menu = true }) { Icon(Icons.Outlined.MoreHoriz, "服务连接操作") }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("服务连接") }, onClick = { menu = false; connection = true; vm.clearError() })
                    DropdownMenuItem(text = { Text("退出 AI 服务") }, onClick = { menu = false; vm.logout() })
                }
            }
        }
        ui.error?.let { ErrorBar(it, vm::clearError) }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item(key = "connection") {
                Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(12.dp)) {
                    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        RoundIcon(Icons.Outlined.Dns)
                        Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                            Text(ui.username, style = MaterialTheme.typography.titleSmall)
                            Text(
                                ui.server, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        AssistChip(
                            onClick = { connection = true },
                            label = { Text(if (ui.connected) "实时连接" else "切换服务") },
                        )
                    }
                }
            }
            item(key = "launch") {
                Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(12.dp)) {
                    Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        SectionCaption("开始新的对话", "选择项目和模型")
                        AiChoiceField(
                            "项目", ui.launchProject?.name, "选择服务端项目",
                            ui.projects.map { AiChoice(it.path, it.name, it.path) },
                            !ui.loading && !ui.working, vm::selectProject,
                        )
                        AiChoiceField(
                            "模型供应商", ui.launchProvider?.label, "选择模型供应商",
                            ui.availableProviders.map {
                                AiChoice(it.id, it.label, if (it.isDefault) "服务端默认供应商" else "${it.models.size} 个可用模型")
                            },
                            !ui.loading && !ui.working, vm::selectProvider,
                        )
                        AiChoiceField(
                            "模型", ui.launchModel?.title, "选择模型",
                            ui.launchProvider?.models.orEmpty().map {
                                AiChoice(it.id, it.title, if (it.effort.isBlank()) "" else "推理等级：${it.effortLabel}")
                            },
                            !ui.loading && !ui.working, vm::selectModel,
                        )
                        when {
                            ui.loading -> Text("正在同步项目和模型…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                            ui.projects.isEmpty() -> Text("服务端还没有登记项目，请先在桌面端添加项目后刷新。", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                            ui.availableProviders.isEmpty() -> Text("该项目尚未启用 Claude 或 Codex，请在桌面端项目设置中开启。", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                            ui.launchProvider?.models?.isEmpty() == true -> Text("该供应商还没有可用模型，请在服务端配置后刷新。", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        }
                        Button(
                            vm::create, Modifier.fillMaxWidth().heightIn(min = 50.dp),
                            enabled = ui.canCreate, shape = RoundedCornerShape(10.dp),
                        ) {
                            if (ui.working) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                            }
                            Text(if (ui.working) "正在创建…" else "开始对话")
                        }
                    }
                }
            }
            item(key = "recent-title") { Text("最近对话", style = MaterialTheme.typography.titleMedium) }
            if (ui.sessions.isEmpty()) item(key = "empty") {
                Text("还没有对话，选择上方项目和模型即可开始。", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
            items(ui.sessions, key = { it.id }) { session ->
                Surface(
                    onClick = { vm.open(session.id) },
                    color = MaterialTheme.colorScheme.surfaceContainer,
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        RoundIcon(Icons.Outlined.AutoAwesome)
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                            Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                session.targetLabel, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                "${session.statusLabel} · ${session.projectPath}", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        IconButton({ deleting = session }, enabled = !session.running && !ui.working) {
                            Icon(Icons.Outlined.DeleteOutline, "删除对话", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
    deleting?.let { session -> AiDeleteDialog(session, { deleting = null }) { deleting = null; vm.delete(session) } }
}

private data class AiChoice(val id: String, val title: String, val subtitle: String = "")

/** 下拉选择框：点击整行展开，选项显示标题和可选说明。 */
@Composable
private fun AiChoiceField(
    label: String, value: String?, placeholder: String, choices: List<AiChoice>,
    enabled: Boolean, select: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(
                { expanded = true }, Modifier.fillMaxWidth(), enabled = enabled && choices.isNotEmpty(),
                shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(14.dp),
            ) {
                Text(
                    value ?: placeholder, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Start,
                )
                Icon(Icons.Outlined.ExpandMore, null)
            }
            DropdownMenu(expanded && enabled, { expanded = false }, Modifier.heightIn(max = 360.dp).widthIn(max = 560.dp)) {
                choices.forEach { choice ->
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(choice.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                if (choice.subtitle.isNotBlank()) Text(
                                    choice.subtitle, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        },
                        onClick = { expanded = false; select(choice.id) },
                    )
                }
            }
        }
    }
}

/** 独立二级会话页：顶部会话信息，底部输入框，不显示一级导航。 */
@Composable
fun AiConversationScreen(ui: AiUiState, vm: AiViewModel) {
    val session = ui.selected ?: return
    var deleting by remember { mutableStateOf(false) }
    Scaffold(
        modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surface) {
                Row(
                    Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 8.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(vm::closeSession) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回 Ai 首页") }
                    Column(Modifier.weight(1f).padding(horizontal = 6.dp)) {
                        Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            session.targetLabel, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            "${session.statusLabel} · ${if (ui.connected) "实时连接" else "自动同步"}",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (ui.loadingSession) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        IconButton({ menu = true }) { Icon(Icons.Outlined.MoreHoriz, "对话操作") }
                        DropdownMenu(menu, { menu = false }) {
                            DropdownMenuItem(text = { Text("返回首页选择模型") }, onClick = { menu = false; vm.closeSession() })
                            DropdownMenuItem(
                                text = { Text("删除对话") }, enabled = !session.running && !ui.working,
                                onClick = { menu = false; deleting = true },
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ui.error?.let { ErrorBar(it, vm::clearError) }
            AiConversation(ui, vm, Modifier.weight(1f))
        }
    }
    if (deleting) AiDeleteDialog(session, { deleting = false }) { deleting = false; vm.delete(session) }
}

@Composable
private fun AiDeleteDialog(session: AiSession, dismiss: () -> Unit, confirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss, title = { Text("删除对话") },
        text = { Text("删除「${session.title}」在 AI 中保存的消息？项目文件不会被删除。") },
        confirmButton = { TextButton(confirm) { Text("删除") } },
        dismissButton = { TextButton(dismiss) { Text("取消") } },
    )
}

/** 服务连接表单：地址 + 账号 + 密码，密码不落盘。 */
@Composable
private fun AiConnection(ui: AiUiState, login: (String, String, String) -> Unit, back: (() -> Unit)?) {
    var server by rememberSaveable(ui.server) { mutableStateOf(ui.server) }
    var username by rememberSaveable(ui.username) { mutableStateOf(ui.username) }
    var password by remember { mutableStateOf("") }
    var visible by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (back != null) TextButton(back) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, null)
            Text("返回")
        }
        RoundIcon(Icons.Outlined.AutoAwesome, modifier = Modifier.size(60.dp))
        Text("连接 AI 服务", style = MaterialTheme.typography.headlineSmall)
        Text("填写 TerminalBuddy 服务地址和账号，手机即可与服务器上的 Claude、Codex 对话。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            server, { server = it }, Modifier.fillMaxWidth(), label = { Text("服务地址") },
            placeholder = { Text("http://192.168.1.10:9600") }, singleLine = true, enabled = !ui.authenticating,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), shape = RoundedCornerShape(10.dp),
        )
        OutlinedTextField(
            username, { username = it }, Modifier.fillMaxWidth(), label = { Text("服务账号") },
            singleLine = true, enabled = !ui.authenticating, shape = RoundedCornerShape(10.dp),
        )
        OutlinedTextField(
            password, { password = it }, Modifier.fillMaxWidth(), label = { Text("服务密码") },
            singleLine = true, enabled = !ui.authenticating,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), shape = RoundedCornerShape(10.dp),
            trailingIcon = {
                IconButton({ visible = !visible }) {
                    Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, "显示或隐藏密码")
                }
            },
        )
        ui.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Button(
            { login(server, username, password) }, Modifier.fillMaxWidth().heightIn(min = 50.dp),
            enabled = !ui.authenticating, shape = RoundedCornerShape(10.dp),
        ) {
            if (ui.authenticating) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(if (ui.authenticating) "正在连接…" else "连接并登录")
        }
        Text(
            "使用桌面端「设置 → 远程访问」里配置的账号和密码。密码不会保存，登录令牌由设备加密保存。",
            color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun AiConversation(ui: AiUiState, vm: AiViewModel, modifier: Modifier) {
    val session = ui.selected ?: return
    val motion = rememberAiConversationMotion(session, ui.loadingSession)
    val scroll = rememberAiConversationScroll(session.id, motion.initialized, motion.messages.size)
    val revealing by remember(motion) { derivedStateOf { motion.messages.any { it.isRevealing } } }
    Column(modifier.fillMaxWidth().imePadding()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                Modifier.fillMaxSize().nestedScroll(scroll.gestures),
                state = scroll.list,
                contentPadding = PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
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
                // 真实底部锚点：回复高度超过一屏时也能顺利跟随。
                item(key = "ai-bottom") { Spacer(Modifier.height(1.dp)) }
            }
            if (motion.messages.isEmpty() && (!session.running || ui.loadingSession)) {
                Text(
                    if (ui.loadingSession || !motion.initialized) "正在加载消息…" else "发送第一条消息，开始对话。",
                    Modifier.align(Alignment.Center).padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // 显式指定通用重载，避免嵌套 Box 时命中 ColumnScope 版本。
            androidx.compose.animation.AnimatedVisibility(
                visible = !scroll.following && motion.messages.isNotEmpty(),
                modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp),
                enter = fadeIn(tween(180)) + slideInVertically(tween(220)) { it / 2 },
                exit = fadeOut(tween(120)) + slideOutVertically(tween(160)) { it / 2 },
            ) {
                FilledTonalButton({ scroll.following = true }, elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = 3.dp)) {
                    Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("回到最新")
                }
            }
        }
        session.error?.let {
            Text(
                it, Modifier.fillMaxWidth().heightIn(max = 100.dp).verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
            )
        }
        session.approvals.firstOrNull()?.let { AiApprovalCard(it, ui.working, vm::answer) }
        Surface(color = MaterialTheme.colorScheme.surface) {
            Row(
                Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    ui.draft, vm::draft, Modifier.weight(1f),
                    placeholder = { Text("给 ${session.providerLabel} 发消息…") },
                    maxLines = 5, enabled = !ui.loadingSession, shape = RoundedCornerShape(12.dp),
                    textStyle = MaterialTheme.typography.bodyMedium,
                )
                if (session.running) {
                    FilledIconButton(vm::stop, enabled = !ui.working, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Outlined.Stop, "中断回复")
                    }
                } else {
                    FilledIconButton(
                        { scroll.following = true; vm.send() },
                        enabled = ui.draft.isNotBlank() && !ui.sending && !ui.loadingSession,
                        modifier = Modifier.size(48.dp),
                    ) {
                        if (ui.sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.AutoMirrored.Outlined.Send, "发送消息")
                    }
                }
            }
        }
    }
}

/** 消息气泡：用户靠右、助手靠左、工具调用用等宽字体并默认折叠。 */
@Composable
private fun AiMessageBubble(message: AiAnimatedMessage, provider: String, modifier: Modifier = Modifier) {
    val mine = message.role == "user"
    val tool = message.role == "tool"
    var expanded by remember(message.id) { mutableStateOf(false) }
    val entrance by animateFloatAsState(
        if (message.entered) 1f else 0f,
        animationSpec = tween(280, easing = FastOutSlowInEasing), label = "ai-message-entrance",
    )
    LaunchedEffect(message) { message.entered = true }
    val colors = MaterialTheme.colorScheme
    Column(
        modifier.fillMaxWidth().graphicsLayer {
            alpha = entrance
            translationY = (1f - entrance) * 12.dp.toPx()
        },
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        Text(
            if (mine) "我" else if (tool) "执行过程" else provider,
            Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant,
        )
        Surface(
            Modifier.widthIn(max = 600.dp).animateContentSize(tween(160, easing = LinearOutSlowInEasing)),
            color = when {
                mine -> colors.primary.copy(alpha = .16f)
                tool -> colors.surfaceVariant
                else -> colors.surface
            },
            shape = RoundedCornerShape(12.dp),
        ) {
            Column(Modifier.padding(14.dp)) {
                SelectionContainer {
                    Text(
                        message.text,
                        style = if (tool) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium,
                        fontFamily = if (tool) FontFamily.Monospace else FontFamily.Default,
                        maxLines = if (tool && !expanded) 4 else Int.MAX_VALUE,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (tool && (message.text.length > 180 || message.text.count { it == '\n' } >= 4)) {
                    TextButton({ expanded = !expanded }) { Text(if (expanded) "收起" else "展开执行日志") }
                }
            }
        }
    }
}

/** 三点跳动 + 状态文字，表示服务端正在生成。 */
@Composable
private fun AiReplyIndicator(label: String, modifier: Modifier = Modifier) {
    val pulse = rememberInfiniteTransition(label = "ai-typing")
    val dotColor = MaterialTheme.colorScheme.primary
    Row(modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
                    Modifier.size(4.dp).graphicsLayer {
                        alpha = opacity
                        translationY = -2.dp.toPx() * opacity
                    }.background(dotColor, CircleShape)
                )
            }
        }
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * Codex 命令执行/文件修改确认与用户问题卡片。
 * 无 questions 时是二元确认；有 questions 时每个问题都要作答才能发送。
 */
@Composable
private fun AiApprovalCard(approval: AiApproval, working: Boolean, answer: (AiApproval, String, JsonObject) -> Unit) {
    var responses by remember(approval.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    val questions = approval.details.rows("questions").map { it.asObject() }
    Surface(
        Modifier.fillMaxWidth().heightIn(max = 300.dp).padding(horizontal = 12.dp, vertical = 4.dp),
        color = MaterialTheme.colorScheme.primary.copy(alpha = .10f), shape = RoundedCornerShape(12.dp),
    ) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (questions.isEmpty()) "AI 请求操作确认" else "AI 需要你的回复", style = MaterialTheme.typography.titleSmall)
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
                    TextButton({ responses = responses + (id to label) }, enabled = !working) {
                        Text(if (responses[id] == label) "✓ $label" else label)
                    }
                }
                OutlinedTextField(
                    responses[id].orEmpty(), { responses = responses + (id to it) }, Modifier.fillMaxWidth(),
                    label = { Text("回复") }, maxLines = 3, enabled = !working,
                )
            }
            Row(Modifier.align(Alignment.End)) {
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
                ) { Text(if (questions.isEmpty()) "允许本次" else "发送回复") }
            }
        }
    }
}
