package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.R
import com.terminalbuddy.android.data.AiSession

/** AI 首页：服务连接、新对话配置、最近对话。 */
@Composable
fun AiScreen(ui: AiUiState, vm: AiViewModel) {
    var connection by rememberSaveable { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<AiSession?>(null) }
    var confirmDeleteAll by remember { mutableStateOf(false) }
    val deletableCount = ui.sessions.count { !it.running }
    BackHandler(connection) { connection = false }
    LaunchedEffect(ui.authenticated, ui.connectionRevision) { if (ui.authenticated) connection = false }
    if (!ui.authenticated || connection) {
        AiConnection(ui, vm::login, if (ui.authenticated) ({ connection = false }) else null)
        return
    }
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        PageHeader("TerminalBuddy", reconnecting = ui.reconnecting) {
            var menu by remember { mutableStateOf(false) }
            Box {
                IconButton({ menu = true }) {
                    Icon(Icons.Outlined.MoreHoriz, "服务连接操作", Modifier.size(20.dp), tint = TbColors.TextMuted)
                }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("服务连接") }, onClick = { menu = false; connection = true; vm.clearError() })
                    DropdownMenuItem(text = { Text("退出 AI 服务") }, onClick = { menu = false; vm.logout() })
                }
            }
        }
        ui.error?.let { AiError(it, vm::clearError) }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
        ) {
            item(key = "connection") {
                Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Dns, null, Modifier.size(18.dp), tint = TbColors.TextMuted)
                    Column(Modifier.weight(1f).padding(start = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                ui.username, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.titleSmall,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            AiStatusDot(TbColors.Accent)
                            Text("已登录", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                        }
                        Text(
                            ui.server, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            item(key = "launch") {
                AiCard {
                    Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("新对话", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                            Button(
                                vm::create, enabled = ui.canCreate, shape = RoundedCornerShape(10.dp),
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                if (ui.working) CircularProgressIndicator(Modifier.size(16.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
                                else Icon(Icons.Outlined.Add, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(4.dp))
                                Text(if (ui.working) "创建中" else "开始对话")
                            }
                        }
                        AiChoiceField(
                            "项目", Icons.Outlined.FolderOpen, ui.projectPath, "选择项目",
                            ui.projects.map { AiChoice(it.path, it.name, it.path) },
                            !ui.initialLoading && !ui.working, vm::selectProject,
                        )
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AiChoiceField(
                                "Agent", Icons.Outlined.AutoAwesome, ui.launchProvider?.agent.orEmpty(), "选择 Agent",
                                ui.availableAgents.map { AiChoice(it, if (it == "codex") "Codex" else "Claude Code", agent = it) },
                                !ui.initialLoading && !ui.working, vm::selectAgent, Modifier.weight(1f),
                            )
                            AiChoiceField(
                                "模型", Icons.Outlined.Tune, ui.launchModelKey, "选择模型",
                                ui.availableModels.map { target ->
                                    val details = buildList {
                                        add(target.provider.name)
                                        if (target.provider.isDefault) add("服务端默认供应商")
                                        if (target.model.effort.isNotBlank()) add("推理等级：${target.model.effortLabel}")
                                    }
                                    AiChoice(target.key, target.model.title, details.joinToString(" · "))
                                },
                                !ui.initialLoading && !ui.working, vm::selectModel, Modifier.weight(1f),
                            )
                        }
                        val hint = when {
                            ui.initialLoading -> "正在同步项目和模型…"
                            ui.projects.isEmpty() -> "服务端还没有登记项目，请添加后刷新。"
                            ui.availableAgents.isEmpty() -> "该项目尚未启用 Claude Code 或 Codex，请在服务端配置。"
                            ui.availableModels.isEmpty() -> "该 Agent 暂无可用模型，请在服务端配置后刷新。"
                            else -> null
                        }
                        hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted) }
                    }
                }
                Spacer(Modifier.height(18.dp))
            }
            item(key = "recent-title") {
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("最近对话", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    Text("${ui.sessions.size} 段对话", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                    TextButton(
                        onClick = { confirmDeleteAll = true },
                        enabled = deletableCount > 0 && !ui.loading && !ui.working,
                        contentPadding = PaddingValues(horizontal = 8.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = TbColors.Danger),
                    ) {
                        if (ui.deletingAll) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(if (ui.deletingAll) "删除中…" else "一键删除", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            if (ui.sessions.isEmpty()) item(key = "empty") {
                AiCard {
                    Row(
                        Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        AiSmallIcon(Icons.Outlined.ChatBubbleOutline)
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("还没有对话", style = MaterialTheme.typography.titleSmall)
                            Text("选好项目和模型，开始第一段对话。", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                        }
                    }
                }
            }
            itemsIndexed(ui.sessions, key = { _, session -> session.id }) { index, session ->
                val projectName = ui.projects.find { it.path == session.projectPath }?.name
                    ?: session.projectPath.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
                Surface(
                    onClick = { vm.open(session.id) }, enabled = !ui.deletingAll, color = TbColors.Surface,
                    shape = RoundedCornerShape(
                        topStart = if (index == 0) 14.dp else 0.dp, topEnd = if (index == 0) 14.dp else 0.dp,
                        bottomStart = if (index == ui.sessions.lastIndex) 14.dp else 0.dp,
                        bottomEnd = if (index == ui.sessions.lastIndex) 14.dp else 0.dp,
                    ),
                    border = BorderStroke(1.dp, TbColors.Border),
                ) {
                    Column {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 10.dp, end = 2.dp, top = 8.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            AiAgentBadge(session.provider)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(
                                        session.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    )
                                    if (session.id in ui.unviewedIds) Text(
                                        "未查看", style = MaterialTheme.typography.labelSmall,
                                        color = TbColors.Accent, modifier = Modifier.semantics { stateDescription = "有尚未查看的结果" },
                                    )
                                    if (session.running || session.status == "error" || session.status == "interrupted") {
                                        Text(
                                            session.statusLabel, style = MaterialTheme.typography.labelSmall,
                                            color = if (session.status == "error") TbColors.Danger else TbColors.Accent,
                                        )
                                    }
                                }
                                Text(
                                    "$projectName · ${session.targetLabel}", style = MaterialTheme.typography.bodySmall,
                                    color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                            IconButton({ deleting = session }, enabled = !session.running && !ui.working) {
                                Icon(Icons.Outlined.DeleteOutline, "删除对话", Modifier.size(18.dp), tint = TbColors.TextMuted)
                            }
                        }
                        if (index != ui.sessions.lastIndex) AiDivider(Modifier.padding(start = 52.dp))
                    }
                }
            }
        }
    }
    deleting?.let { session -> AiDeleteDialog(session, { deleting = null }) { deleting = null; vm.delete(session) } }
    if (confirmDeleteAll) {
        AlertDialog(
            onDismissRequest = { confirmDeleteAll = false }, title = { Text("一键删除对话") },
            text = { Text("将删除 ${deletableCount} 段未运行对话及其消息。正在回复或等待确认的对话会保留，项目文件不会被删除。") },
            confirmButton = {
                TextButton(
                    onClick = { confirmDeleteAll = false; vm.deleteAll() },
                    enabled = deletableCount > 0 && !ui.loading && !ui.working,
                ) { Text("删除", color = TbColors.Danger) }
            },
            dismissButton = { TextButton({ confirmDeleteAll = false }) { Text("取消") } },
        )
    }
}

private data class AiChoice(val id: String, val title: String, val subtitle: String = "", val agent: String? = null)

/** 首页只显示当前值，完整名称、路径与选中状态放在二级选择面板。 */
@Composable
private fun AiChoiceField(
    label: String, icon: ImageVector, selectedId: String, placeholder: String, choices: List<AiChoice>,
    enabled: Boolean, select: (String) -> Unit, modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val selected = choices.find { it.id == selectedId }
    val available = enabled && choices.isNotEmpty()
    LaunchedEffect(available) { if (!available) expanded = false }
    Surface(
        onClick = { expanded = true }, modifier = modifier.fillMaxWidth().alpha(if (available) 1f else .5f),
        enabled = available, color = TbColors.SurfaceHover, shape = RoundedCornerShape(9.dp),
    ) {
        Row(
            Modifier.heightIn(min = 52.dp).padding(horizontal = 8.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val selectedAgent = selected?.agent
            if (selectedAgent != null) AiAgentLogo(selectedAgent, Modifier.size(20.dp))
            else Icon(icon, null, Modifier.size(16.dp), tint = TbColors.TextMuted)
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                Text(
                    selected?.title ?: placeholder, style = MaterialTheme.typography.labelLarge,
                    color = if (selected == null) TbColors.TextMuted else TbColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(14.dp), tint = TbColors.TextMuted)
        }
    }
    if (expanded && available) {
        AiSheet("选择$label", { expanded = false }) {
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f, fill = false),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            ) {
                items(choices, key = { it.id }) { choice ->
                    Surface(
                        onClick = { expanded = false; select(choice.id) },
                        color = if (choice.id == selectedId) TbColors.Accent.copy(alpha = .12f) else Color.Transparent,
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            choice.agent?.let { AiAgentLogo(it, Modifier.size(24.dp)) }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(choice.title, style = MaterialTheme.typography.bodyMedium)
                                if (choice.subtitle.isNotBlank()) Text(
                                    choice.subtitle, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                                )
                            }
                            if (choice.id == selectedId) Icon(Icons.Outlined.Check, "已选择", Modifier.size(20.dp), tint = TbColors.Accent)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AiSheet(title: String, dismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val maxHeight = LocalConfiguration.current.screenHeightDp.dp * .8f
    ModalBottomSheet(
        onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = TbColors.Surface,
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = maxHeight)) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton(dismiss) { Icon(Icons.Outlined.Close, "关闭$title", Modifier.size(20.dp), tint = TbColors.TextMuted) }
            }
            AiDivider()
            content()
        }
    }
}

@Composable
internal fun AiDeleteDialog(session: AiSession, dismiss: () -> Unit, confirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss, title = { Text("删除对话") },
        text = { Text("删除「${session.title}」在 AI 中保存的消息？项目文件不会被删除。") },
        confirmButton = { TextButton(confirm) { Text("删除", color = TbColors.Danger) } },
        dismissButton = { TextButton(dismiss) { Text("取消") } },
    )
}

/** 服务连接表单：品牌与登录内容整体居中，小屏和键盘弹出时仍可滚动。 */
@Composable
private fun AiConnection(ui: AiUiState, login: (String, String, String) -> Unit, back: (() -> Unit)?) {
    var server by rememberSaveable(ui.server) { mutableStateOf(ui.server) }
    var username by rememberSaveable(ui.username) { mutableStateOf(ui.username) }
    var password by remember { mutableStateOf("") }
    var visible by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Vertical)),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (back != null) {
                IconButton(back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回 AI 首页", Modifier.size(20.dp)) }
                Text("服务连接", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, color = TbColors.Text)
            } else {
                Spacer(Modifier.weight(1f))
            }
            ThemeToggleButton()
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(
                    Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Image(
                        painter = painterResource(R.drawable.terminal_buddy_logo),
                        contentDescription = "Terminal Buddy 标志", modifier = Modifier.size(88.dp),
                    )
                    Text(
                        "Terminal Buddy", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineMedium,
                        fontSize = 32.sp, lineHeight = 40.sp, color = TbColors.Text, textAlign = TextAlign.Center,
                    )
                    Text(
                        "继续服务器上的 Claude 与 Codex 对话", Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted, textAlign = TextAlign.Center,
                    )
                }
                AiCard {
                    Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedTextField(
                            server, { server = it }, Modifier.fillMaxWidth(), label = { Text("服务地址") },
                            placeholder = { Text("http://192.168.1.10:9600") }, singleLine = true, enabled = !ui.authenticating,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), shape = RoundedCornerShape(10.dp),
                            textStyle = MaterialTheme.typography.bodyMedium,
                        )
                        OutlinedTextField(
                            username, { username = it }, Modifier.fillMaxWidth(), label = { Text("服务账号") },
                            singleLine = true, enabled = !ui.authenticating, shape = RoundedCornerShape(10.dp),
                            textStyle = MaterialTheme.typography.bodyMedium,
                        )
                        OutlinedTextField(
                            password, { password = it }, Modifier.fillMaxWidth(), label = { Text("服务密码") },
                            singleLine = true, enabled = !ui.authenticating, textStyle = MaterialTheme.typography.bodyMedium,
                            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), shape = RoundedCornerShape(10.dp),
                            trailingIcon = {
                                IconButton({ visible = !visible }) {
                                    Icon(
                                        if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                        if (visible) "隐藏密码" else "显示密码", Modifier.size(20.dp),
                                    )
                                }
                            },
                        )
                        ui.error?.let { Text(it, color = TbColors.Danger, style = MaterialTheme.typography.bodySmall) }
                        Button(
                            { login(server, username, password) }, Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            enabled = !ui.authenticating, shape = RoundedCornerShape(10.dp),
                        ) {
                            if (ui.authenticating) {
                                CircularProgressIndicator(Modifier.size(16.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                            }
                            Text(if (ui.authenticating) "正在连接…" else "连接并登录")
                        }
                    }
                }
                Row(Modifier.padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Outlined.Lock, null, Modifier.padding(top = 2.dp).size(14.dp), tint = TbColors.TextMuted)
                    Text(
                        "使用 TerminalBuddy 服务账号。密码不会保存，登录令牌由设备加密保存。",
                        color = TbColors.TextMuted, style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}
