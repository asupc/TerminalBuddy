package com.terminalbuddy.android.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.*
import com.terminalbuddy.android.notifications.AiBackgroundCompatibility
import com.terminalbuddy.android.notifications.AiTaskNotifications

/**
 * 明确已经结束的原生 AI 会话状态：这些状态下没有进程可终止，
 * 「强制结束」不提供入口，避免对已完成的结果反复执行无意义的重置。
 */
private val TERMINAL_AI_STATUSES = setOf("idle", "forceStopped", "interrupted", "error")

/** 对话二级页：会话摘要、自然段回复与紧凑输入区。 */
@Composable
fun AiConversationScreen(ui: AiUiState, vm: AiViewModel) {
    val session = ui.selected ?: return
    val context = LocalContext.current
    var menu by rememberSaveable(session.id) { mutableStateOf(false) }
    var information by rememberSaveable(session.id) { mutableStateOf(false) }
    var usageInformation by rememberSaveable(session.id) { mutableStateOf(false) }
    var vivoBackgroundGuide by rememberSaveable(session.id) { mutableStateOf(false) }
    var deleting by rememberSaveable(session.id) { mutableStateOf(false) }
    var forceStopping by rememberSaveable(session.id) { mutableStateOf(false) }
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
                    }
                    AiDivider()
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            AiNotificationPermission()
            ui.error?.let { AiError(it, vm::clearError) }
            AiConversation(ui, vm, Modifier.weight(1f), ui.selectedModelLabel, ui.selectedEffortLabel) { usageInformation = true }
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
                AiConversationAction(Icons.Outlined.DataUsage, "上下文与 Token", { menu = false; usageInformation = true })
                AiConversationAction(Icons.Outlined.FolderOpen, "返回首页选择模型", { menu = false; vm.closeSession() })
                AiConversationAction(
                    Icons.Outlined.PowerSettingsNew, "强制结束会话", { menu = false; forceStopping = true },
                    // 服务端偶尔会残留「执行中」但进程已消失的状态，此时 running 为真而
                    // 进程早已退出；只要不是明确的终态就允许点，避免用户被卡死没有出口。
                    enabled = session.status !in TERMINAL_AI_STATUSES && !ui.working, color = TbColors.Danger,
                )
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
                    AiInfoField("消息数量", "${session.conversationMessages.size} 条")
                }
            }
        }
    }
    if (vivoBackgroundGuide) AiVivoBackgroundGuide { vivoBackgroundGuide = false }
    if (usageInformation) AiUsageSheet(session, ui.selectedModelLabel, ui.selectedEffortLabel) { usageInformation = false }
    if (deleting) AiDeleteDialog(session, { deleting = false }) { deleting = false; vm.delete(session) }
    if (forceStopping) AiForceStopDialog(session, { forceStopping = false }) { forceStopping = false; vm.forceStop() }
}

/** 强制结束不可像普通中断一样只请求 CLI 收尾，必须明确告知排队消息与待确认决定会被丢弃。 */
@Composable
private fun AiForceStopDialog(session: AiSession, dismiss: () -> Unit, confirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("强制结束会话") },
        text = {
            Text("将立即终止「${session.title}」的 Agent 进程，未完成的回复、待确认操作和 ${session.pendingCount} 条排队消息都会被丢弃。聊天记录与会话配置会保留，之后可以继续发送消息开启新回合。")
        },
        confirmButton = { TextButton(confirm) { Text("强制结束", color = TbColors.Danger) } },
        dismissButton = { TextButton(dismiss) { Text("取消") } },
    )
}

@Composable
internal fun AiConversationAction(
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
internal fun AiInfoField(label: String, value: String, monospace: Boolean = false) {
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
    val tabletLandscape = isTabletLandscape()
    var usageExpanded by rememberSaveable(session.id) { mutableStateOf(true) }
    val approvals = session.approvals.filterNot { it.id in ui.answeringApprovalIds }
    val activeApproval = approvals.firstOrNull()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(activeApproval?.id) {
        if (activeApproval != null) { focus.clearFocus(); keyboard?.hide() }
    }
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
    val latestMessage = session.conversationMessages.lastOrNull()
    val assistantOutput = latestMessage?.let { it.role == "assistant" && it.text.isNotBlank() } == true
    val showReplyIndicator = !ui.loadingSession && session.running &&
        (session.status == "approval" || session.status == "background" || session.status == "stopping" || (!assistantOutput && !renderedAssistantOutput && !revealing))
    Box(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxSize()) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    (if (tabletLandscape) Modifier.fillMaxSize() else Modifier.widthIn(max = 760.dp).fillMaxSize())
                        .align(Alignment.TopCenter).nestedScroll(scroll.gestures),
                    state = scroll.list,
                    contentPadding = PaddingValues(horizontal = if (tabletLandscape) 24.dp else 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // 流式内容使用实际布局位置，逐字显示与底部跟随负责平滑过渡。
                    items(entries, key = { it.id }) { entry ->
                        when (entry) {
                            is AiConversationEntry.Message -> AiMessageBubble(entry.message, session.providerLabel,
                                sending = ui.sending && entry.message.id.startsWith("local-"), imageUrl = vm::imageUrl)
                            is AiConversationEntry.Tools -> AiToolGroup(entry.messages, Modifier) { scroll.following = false }
                        }
                    }
                    if (showReplyIndicator) item(key = "ai-status") {
                        val elapsedSeconds = rememberAiReplyElapsedSeconds(session, replying)
                        val statusLabel = when (session.status) { "approval" -> "等待确认"; "background" -> "后台任务执行中"; "stopping" -> "正在中断"; "forceStopped" -> "已强制结束"; else -> "思考中" }
                        AiReplyIndicator(
                            session.providerLabel,
                            if (session.pendingCount > 0) "$statusLabel · ${session.pendingCount} 条排队中" else statusLabel,
                            elapsedSeconds,
                            thinking = session.thinking,
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
                    visible = activeApproval == null && !scroll.following && scroll.list.canScrollForward && motion.messages.isNotEmpty(),
                    modifier = Modifier.align(Alignment.BottomCenter).padding(
                        start = 8.dp, end = if (usageExpanded) 8.dp else 64.dp, bottom = 8.dp),
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
                // 决策覆盖在消息区底部，不随消息滚动也不挤占正文布局。
                val approvalMaxHeight = (maxHeight * .8f).coerceAtMost(400.dp)
                Column(
                    Modifier.align(Alignment.BottomCenter)
                        .then(if (tabletLandscape) Modifier.fillMaxWidth() else Modifier.widthIn(max = 760.dp).fillMaxWidth())
                        .padding(horizontal = if (tabletLandscape) 24.dp else 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    activeApproval?.let {
                        AiApprovalCard(it, ui.working, approvalMaxHeight, approvals.size, vm::answer)
                    }
                    if (!usageExpanded) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.BottomEnd) {
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
            AiQueuedMessages(ui, session, vm::sendQueuedNow, vm::deleteQueuedMessage)
            Box(
                Modifier.fillMaxWidth().padding(horizontal = if (tabletLandscape) 24.dp else 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                AiUsageCard(session, modelLabel, effortLabel, usageDetails,
                    expanded = usageExpanded, onExpandedChange = { usageExpanded = it },
                    modifier = if (tabletLandscape) Modifier.fillMaxWidth() else Modifier.widthIn(max = 760.dp).fillMaxWidth())
            }
            AiComposer(ui, session, vm, { scroll.following = true; vm.send() }, vm::stop, vm::draft)
        }
    }
}

/** 服务端排队消息：单行预览，右侧依次为删除和插话。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiQueuedMessages(
    ui: AiUiState, session: AiSession, sendNow: (String) -> Unit, delete: (String) -> Unit,
) {
    if (session.pendingInputs.isEmpty()) return
    // 中断进行中或动作在途时禁用，避免与停止请求竞争；等待中的排队仍可查看。
    val enabled = !ui.working && !ui.loadingSession && session.status != "stopping"
    val tabletLandscape = isTabletLandscape()
    Box(
        Modifier.fillMaxWidth().padding(horizontal = if (tabletLandscape) 24.dp else 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            (if (tabletLandscape) Modifier else Modifier.widthIn(max = 760.dp)).fillMaxWidth().heightIn(max = 140.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                "排队中 · 当前回合任务完成后自动发送", Modifier.padding(start = 12.dp),
                style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 32.dp) {
                session.pendingInputs.forEach { item ->
                    val submitting = item.requestId.startsWith("local-")
                    val actionEnabled = enabled && !submitting
                    Surface(
                        color = TbColors.CanvasSoft, shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(1.dp, TbColors.Border),
                    ) {
                        // 原有约 56.dp 的消息行压缩到 44.dp，高度减少约五分之一。
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(start = 12.dp, end = 4.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(Icons.Outlined.Schedule, null, Modifier.size(16.dp), tint = TbColors.TextMuted)
                            Text(
                                item.text.replace('\n', ' ').replace('\r', ' '), Modifier.weight(1f),
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextSoft,
                                maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis,
                            )
                            IconButton(
                                { delete(item.requestId) }, modifier = Modifier.size(32.dp), enabled = actionEnabled,
                                colors = IconButtonDefaults.iconButtonColors(contentColor = TbColors.Danger),
                            ) { Icon(Icons.Outlined.DeleteOutline, "删除排队消息", Modifier.size(18.dp)) }
                            IconButton(
                                { sendNow(item.requestId) }, modifier = Modifier.size(32.dp), enabled = actionEnabled,
                                colors = IconButtonDefaults.iconButtonColors(contentColor = TbColors.Accent),
                            ) {
                                if (submitting) CircularProgressIndicator(
                                    Modifier.size(14.dp).semantics { contentDescription = "正在排队" },
                                    color = TbColors.TextMuted, strokeWidth = 1.5.dp,
                                ) else Icon(Icons.Outlined.ArrowUpward, "插话这条消息", Modifier.size(18.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 发送后仍可编辑下一条消息，发送进度随待确认的消息展示。 */
@Composable
private fun AiComposer(
    ui: AiUiState, session: AiSession, vm: AiViewModel, send: () -> Unit, stop: () -> Unit, draft: (String) -> Unit,
) {
    // 回复中输入了草稿或图片就显示发送（按发送方式排队等待或原生插话）；两者都空才显示中断。
    val hasInput = ui.draft.isNotBlank() || ui.attachments.isNotEmpty()
    val showStop = session.running && !hasInput
    val actionEnabled = if (showStop) !ui.working && session.status != "stopping"
        else session.canSend && hasInput && !ui.sending && !ui.loadingSession
    // `/` 补全：候选由服务端 system/init 清单驱动，移动端不硬编码命令名。
    val slashItems = remember(ui.draft, session.slashCatalog, ui.slashCatalogFallback, session.provider) { vm.slashItems(ui.draft) }
    val pickImages = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        vm.addImages(uris)
    }
    AiMessageComposer(
        value = ui.draft, onValueChange = draft,
        placeholder = "给 ${session.providerLabel} 发消息…", enabled = !ui.loadingSession,
        actionEnabled = actionEnabled, onAction = if (showStop) stop else send,
        actionLabel = when {
            showStop -> "中断回复"
            ui.sending -> "正在发送"
            session.running && ui.sendSteer -> "原生插话"
            session.running -> "发送排队消息"
            else -> "发送消息"
        },
        showStop = showStop,
        slashItems = slashItems, onPickSlash = { draft("/$it ") },
        attachments = ui.attachments,
        onPickImages = {
            pickImages.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        },
        onRemoveImage = vm::removeAttachment,
    )
}

/**
 * 斜杠命令候选条：紧贴输入框上方，点击即补全为 `/<命令> `。
 * 横向排列是因为手机上候选较多，单行列表不会把输入区顶出屏幕。
 */
@Composable
private fun AiSlashSuggestions(items: List<AiSlashItem>, onPick: (String) -> Unit) {
    if (items.isEmpty()) return
    val tabletLandscape = isTabletLandscape()
    Box(
        Modifier.fillMaxWidth().padding(horizontal = if (tabletLandscape) 24.dp else 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            (if (tabletLandscape) Modifier else Modifier.widthIn(max = 760.dp)).fillMaxWidth(), color = TbColors.CanvasSoft,
            border = BorderStroke(1.dp, TbColors.Border), shape = RoundedCornerShape(12.dp),
        ) {
            androidx.compose.foundation.lazy.LazyRow(
                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.semantics { contentDescription = "斜杠命令候选" },
            ) {
                items(items, key = { it.name }) { item ->
                    Surface(
                        color = TbColors.SurfaceHover, shape = RoundedCornerShape(9.dp),
                        modifier = Modifier
                            .clickable(role = Role.Button) { onPick(item.name) }
                            .heightIn(min = 36.dp),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                if (item.isSkill) "Skill" else "命令",
                                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                            )
                            Text(
                                "/${item.name}",
                                style = MaterialTheme.typography.labelLarge.copy(fontFamily = FontFamily.Monospace),
                                color = TbColors.Accent, maxLines = 1,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 原生对话与远程终端共用输入框外观，各自提供发送能力与状态。 */
@Composable
internal fun AiMessageComposer(
    value: String, onValueChange: (String) -> Unit, placeholder: String,
    enabled: Boolean, actionEnabled: Boolean, onAction: () -> Unit, actionLabel: String,
    showStop: Boolean = false,
    slashItems: List<AiSlashItem> = emptyList(), onPickSlash: (String) -> Unit = {},
    attachments: List<AiDraftImage> = emptyList(),
    onPickImages: (() -> Unit)? = null, onRemoveImage: (String) -> Unit = {},
) {
    val tabletLandscape = isTabletLandscape()
    Surface(color = TbColors.Surface) {
        Box(
            Modifier.fillMaxWidth().padding(horizontal = if (tabletLandscape) 24.dp else 10.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                (if (tabletLandscape) Modifier else Modifier.widthIn(max = 760.dp)).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                AiSlashSuggestions(slashItems, onPickSlash)
                // 与 ZCode 一致的附件区：选择后的图片缩略图排在输入框上方，可逐张移除。
                if (attachments.isNotEmpty()) {
                    androidx.compose.foundation.lazy.LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.semantics { contentDescription = "待发送图片" },
                    ) {
                        items(attachments, key = { it.id }) { image ->
                            val previewSource = remember(image.id, image.mediaType, image.data) { image.dataUrl }
                            Box(Modifier.size(64.dp)) {
                                AiImageThumb(previewSource, Modifier.fillMaxSize())
                                IconButton(
                                    { onRemoveImage(image.id) },
                                    modifier = Modifier.align(Alignment.TopEnd).size(24.dp),
                                ) {
                                    Surface(Modifier.size(18.dp), color = Color.Black.copy(alpha = .55f), shape = CircleShape) {
                                        Icon(Icons.Outlined.Close, "移除图片", Modifier.size(12.dp), tint = Color.White)
                                    }
                                }
                            }
                        }
                    }
                }
                Surface(
                    Modifier.fillMaxWidth(), color = TbColors.CanvasSoft,
                    border = BorderStroke(1.dp, TbColors.Border), shape = RoundedCornerShape(14.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                        BasicTextField(
                            value = value, onValueChange = onValueChange,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                .padding(start = 12.dp, end = 4.dp, top = 12.dp, bottom = 12.dp)
                                .semantics { contentDescription = "消息输入框" },
                            enabled = enabled, minLines = 1, maxLines = 4,
                            textStyle = MaterialTheme.typography.bodyMedium.copy(color = TbColors.Text, fontSize = 14.sp, lineHeight = 20.sp),
                            cursorBrush = SolidColor(TbColors.Accent),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                            decorationBox = { innerTextField ->
                                Box(contentAlignment = Alignment.CenterStart) {
                                    if (value.isEmpty()) Text(
                                        placeholder, color = TbColors.TextMuted,
                                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
                                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    )
                                    innerTextField()
                                }
                            },
                        )
                        // 图片按钮紧贴发送按钮，点开系统相册多选；图片随消息以 base64 提交。
                        onPickImages?.let { pick ->
                            IconButton(pick, enabled = enabled, modifier = Modifier.size(40.dp)) {
                                Icon(
                                    Icons.Outlined.Image, "添加图片", Modifier.size(20.dp),
                                    tint = if (enabled) TbColors.TextMuted else TbColors.TextMuted.copy(alpha = .4f),
                                )
                            }
                        }
                        IconButton(
                            onAction, enabled = actionEnabled, modifier = Modifier.size(48.dp)
                                .semantics { contentDescription = actionLabel },
                        ) {
                            Surface(
                                Modifier.size(32.dp),
                                color = TbColors.ButtonBackground.copy(alpha = if (actionEnabled) 1f else .35f),
                                shape = RoundedCornerShape(10.dp), border = primaryControlBorder(),
                            ) {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Icon(
                                        if (showStop) Icons.Outlined.Stop else Icons.Outlined.ArrowUpward, null,
                                        Modifier.size(18.dp), tint = TbColors.ButtonForeground,
                                    )
                                }
                            }
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
internal fun AiMessageBubble(
    message: AiAnimatedMessage, provider: String, modifier: Modifier = Modifier, sending: Boolean = false,
    imageUrl: (String) -> String = { it },
) {
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
        Row(animated, horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            // 保留气泡左侧的状态位置，确认后隐藏菊花，避免挤动气泡正文。
            Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
                if (sending) CircularProgressIndicator(
                    Modifier.size(16.dp).semantics { contentDescription = "消息发送中" },
                    color = TbColors.Accent, strokeWidth = 2.dp)
            }
            Surface(
                Modifier.weight(1f, fill = false).widthIn(max = 600.dp).animateContentSize(tween(160, easing = LinearOutSlowInEasing)),
                color = TbColors.Accent.copy(alpha = .14f),
                shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp, bottomEnd = 3.dp, bottomStart = 12.dp),
            ) {
                Column(
                    Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    // 图片在文字上方：本地占位是 data: URL，服务端确认后换成落盘路径。
                    if (message.images.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            message.images.forEach { image ->
                                AiImageThumb(imageUrl(image.path), Modifier.size(160.dp))
                            }
                        }
                    }
                    if (message.text.isNotEmpty()) SelectionContainer {
                        Text(
                            message.text,
                            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
                        )
                    }
                }
            }
        }
    } else {
        val tabletLandscape = isTabletLandscape()
        val textStyle = MaterialTheme.typography.bodyMedium.copy(
            fontSize = 14.sp, lineHeight = 20.sp,
            lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
        )
        // 头像和实际首行共用对齐线，Markdown 留白、标题字号和字体缩放均参与排版。
        Row(animated, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            AiAvatar(provider, Modifier.alignBy { it.measuredHeight / 2 })
            // 横屏满宽时只放宽消息区，正文仍限制单条宽度，避免一行铺满整块屏幕。
            val body = if (tabletLandscape) Modifier.weight(1f, fill = false).widthIn(max = 680.dp) else Modifier.weight(1f)
            if (message.role == "assistant") {
                AiMarkdownContent(message, textStyle, body.alignBy(AiMessageFirstLineCenter))
            } else {
                SelectionContainer(body.alignBy(AiMessageFirstLineCenter).aiMessageFirstLine(textStyle)) {
                    Text(message.text, style = textStyle)
                }
            }
        }
    }
}

/** 相邻工具调用合并成一组，默认只露出最新记录，展开后按原始顺序查看历史。 */
@Composable
internal fun AiToolGroup(messages: List<AiAnimatedMessage>, modifier: Modifier, onInspect: () -> Unit) {
    var expanded by rememberSaveable(messages.first().id) { mutableStateOf(false) }
    val latest = messages.last()
    val hasHistory = messages.size > 1
    val tabletLandscape = isTabletLandscape()
    Column(
        modifier.fillMaxWidth().padding(start = 38.dp)
            .then(if (tabletLandscape) Modifier.widthIn(max = 680.dp) else Modifier)
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

private val THINKING_PREFIX_REGEX = Regex("^[#>*\\-\\s]+")
private val THINKING_SPACE_REGEX = Regex("\\s+")

private fun cleanThinkingLine(value: String): String =
    value.replace(THINKING_PREFIX_REGEX, "").replace(THINKING_SPACE_REGEX, " ").trim()

/** 思考面板折叠态展示的最新一句：从末尾反向扫描至多两条非空句，避免每帧全量 Regex。 */
internal fun aiThinkingPeek(text: String): String {
    val trimmed = text.trimEnd()
    if (trimmed.isBlank()) return ""
    var latest: String? = null
    var previous: String? = null
    var end = trimmed.length
    while (end > 0) {
        val nl = trimmed.lastIndexOf('\n', end - 1)
        val raw = trimmed.substring(nl + 1, end)
        val cleaned = cleanThinkingLine(raw)
        if (cleaned.isNotEmpty()) {
            if (latest == null) {
                latest = cleaned
                if (latest.length >= 4) return latest
            } else {
                previous = cleaned
                break
            }
        }
        end = if (nl < 0) 0 else nl
    }
    return previous ?: latest ?: cleanThinkingLine(trimmed)
}

@Composable
internal fun AiReplyIndicator(
    provider: String, label: String, elapsedSeconds: Long,
    thinking: AiThinking? = null, modifier: Modifier = Modifier,
) {
    // 思考内容默认折叠成一行（跟随最新一句），点开可看服务端保留的尾部全文。
    val peek = remember(thinking?.text) { thinking?.let { aiThinkingPeek(it.text) } ?: "" }
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
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
        if (peek.isNotBlank()) {
            Column(
                Modifier.padding(start = 30.dp).fillMaxWidth()
                    .border(BorderStroke(1.dp, TbColors.Border), RoundedCornerShape(8.dp)).padding(8.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth().clickable { expanded = !expanded }
                        .semantics { stateDescription = if (expanded) "思考内容已展开" else "思考内容已折叠" },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    val counter = when {
                        thinking == null || thinking.totalChars <= 0 -> ""
                        thinking.totalChars >= 10000 -> " · ${thinking.totalChars / 1000} 千字"
                        else -> " · ${thinking.totalChars} 字"
                    }
                    Text(
                        if (thinking != null && thinking.blocks > 1) "第 ${thinking.blocks} 段思考$counter" else "思考$counter",
                        color = TbColors.TextMuted, style = MaterialTheme.typography.labelSmall,
                    )
                    if (!expanded) Text(
                        peek, color = TbColors.TextSoft, style = MaterialTheme.typography.bodySmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                }
                if (expanded && thinking != null) {
                    Text(
                        thinking.text, color = TbColors.TextSoft,
                        style = MaterialTheme.typography.bodySmall.copy(lineHeight = 18.sp),
                        modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
    }
}

