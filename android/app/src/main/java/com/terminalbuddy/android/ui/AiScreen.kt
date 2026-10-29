package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiHistorySession
import com.terminalbuddy.android.data.AiSession
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

private enum class AiPage { Home, Accounts, Connection, ServiceInfo, AppUpdate }

/** 一级入口共用底部导航，账号、服务信息和对话保留独立的二级页面。 */
@Composable
fun AiScreen(ui: AiUiState, vm: AiViewModel) {
    val terminalVm: ServerTerminalViewModel = viewModel()
    val terminalUi by terminalVm.state.collectAsStateWithLifecycle()
    LaunchedEffect(ui.authenticated, ui.activeAccountId, ui.connectionRevision) { terminalVm.bindAccount() }
    var page by rememberSaveable { mutableStateOf(AiPage.Home) }
    var tab by rememberSaveable { mutableStateOf(AiHomeTab.QuickStart) }
    var recentSessionsRequest by rememberSaveable { mutableIntStateOf(0) }
    var unreadSessionRequest by remember(ui.activeAccountId) { mutableIntStateOf(0) }
    val tabState = rememberSaveableStateHolder()
    var loginAccountId by rememberSaveable { mutableStateOf<String?>(null) }
    var addingAccount by rememberSaveable { mutableStateOf(false) }
    var connectionReturnPage by rememberSaveable { mutableStateOf(AiPage.Home) }
    var handledConnectionRevision by rememberSaveable { mutableLongStateOf(ui.connectionRevision) }
    var deleting by remember(ui.activeAccountId) { mutableStateOf<AiSession?>(null) }
    var confirmDeleteAll by remember(ui.activeAccountId) { mutableStateOf(false) }
    var notificationSettings by rememberSaveable { mutableStateOf(false) }
    var sendModeSheet by rememberSaveable { mutableStateOf(false) }
    val deletableCount = ui.sessions.count { !it.running }
    val openConnection: (String?, Boolean, Boolean) -> Unit = { id, adding, fromAccounts ->
        loginAccountId = id
        addingAccount = adding
        connectionReturnPage = if (fromAccounts) AiPage.Accounts else if (page == AiPage.ServiceInfo) AiPage.ServiceInfo else AiPage.Home
        page = AiPage.Connection
        vm.clearError()
    }
    val openAccounts: () -> Unit = { page = AiPage.Accounts; vm.clearError() }
    val back: () -> Unit = {
        vm.cancelAuthentication()
        page = if (page == AiPage.Connection) connectionReturnPage else AiPage.Home
    }
    BackHandler(page != AiPage.Home || ui.authenticating || tab != AiHomeTab.QuickStart) {
        if (page != AiPage.Home || ui.authenticating) back() else tab = AiHomeTab.QuickStart
    }
    LaunchedEffect(ui.connectionRevision) {
        if (handledConnectionRevision != ui.connectionRevision) {
            handledConnectionRevision = ui.connectionRevision
            if (ui.authenticated) page = AiPage.Home
        }
    }
    LaunchedEffect(ui.notificationLoginAccountId) {
        ui.notificationLoginAccountId?.let { openConnection(it, false, true) }
    }
    if (page == AiPage.Connection || (!ui.authenticated && ui.accounts.isEmpty() && page != AiPage.Accounts)) {
        val account = ui.accounts.find { it.id == loginAccountId }
        AiConnection(ui, vm::login, if (page == AiPage.Connection) back else null,
            initialServer = account?.server ?: ui.server,
            initialUsername = account?.username ?: if (addingAccount) "" else ui.username,
            title = if (addingAccount) "添加账号" else if (account?.loggedIn == false) "重新登录" else "连接服务",
            adding = addingAccount)
        return
    }
    if (page == AiPage.Accounts || !ui.authenticated) {
        AiAccountsScreen(ui, if (ui.authenticated) back else null,
            add = { openConnection(null, true, true) },
            select = { account ->
                if (account.loggedIn) vm.switchAccount(account.id) else openConnection(account.id, false, true)
            }, remove = vm::removeAccount, clearError = vm::clearError)
        return
    }
    if (ui.history.selected != null) {
        AiCodexHistoryScreen(ui, vm)
        return
    }
    if (page == AiPage.AppUpdate) {
        AppUpdateScreen(back)
        return
    }
    if (page == AiPage.ServiceInfo) {
        AiServiceInfoScreen(ui, back) { openConnection(ui.activeAccountId, false, false) }
        return
    }
    if (ui.authenticated && terminalVm.isCurrentAccount() && terminalUi.selected != null) {
        ServerTerminalScreen(terminalUi, terminalVm)
        return
    }
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    Column(Modifier.fillMaxSize().imePadding()) {
        if (tab != AiHomeTab.Sessions) {
            PageHeader(tab.title, reconnecting = ui.reconnecting, subtitle = tab.subtitle)
            ui.error?.let { AiError(it, vm::clearError) }
        }
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
            Box(Modifier.widthIn(max = 680.dp).fillMaxSize()) {
                tabState.SaveableStateProvider("home:${ui.activeAccountId}:${tab.name}") {
                    when (tab) {
                        AiHomeTab.QuickStart -> AiHomeWorkspace(ui, vm, sessions = {
                            recentSessionsRequest++
                            tab = AiHomeTab.Sessions
                        }, more = terminalVm::showConfigurations)
                        AiHomeTab.Sessions -> AiSessionsScreen(ui, vm,
                            start = { tab = AiHomeTab.QuickStart }, delete = { deleting = it },
                            deleteAll = { confirmDeleteAll = true }, recentRequest = recentSessionsRequest,
                            unreadRequest = unreadSessionRequest,
                            unreadRequestHandled = { request ->
                                if (unreadSessionRequest == request) unreadSessionRequest = 0
                            },
                            terminalUi = terminalUi, terminalVm = terminalVm)
                        AiHomeTab.Profile -> AiProfileScreen(ui,
                            notifications = { notificationSettings = true },
                            sendMode = { sendModeSheet = true }, accounts = openAccounts,
                            serviceInfo = { page = AiPage.ServiceInfo },
                            onlineUpdate = { page = AiPage.AppUpdate }, logout = vm::logout)
                    }
                }
            }
        }
        if (!keyboardVisible) AiBottomNavigation(tab, ui.unviewedIds.size,
            select = { tab = it },
            locateUnread = {
                if (ui.sessions.any { it.id in ui.unviewedIds }) {
                    unreadSessionRequest++
                    tab = AiHomeTab.Sessions
                }
            })
    }
    if (terminalUi.dialogOpen && terminalVm.isCurrentAccount()) ServerProjectProfilesDialog(terminalUi, terminalVm)
    if (notificationSettings) AiNotificationSettings { notificationSettings = false }
    if (sendModeSheet) AiSendModeSheet(ui.sendImmediate, vm::setSendImmediate) { sendModeSheet = false }
    deleting?.let { session -> AiDeleteDialog(session, { deleting = null }) { deleting = null; vm.delete(session) } }
    if (confirmDeleteAll) {
        AlertDialog(
            onDismissRequest = { confirmDeleteAll = false }, title = { Text("清理空闲会话") },
            text = { Text("将删除当前账号全部 $deletableCount 段空闲会话及其消息。正在回复或等待确认的会话会保留，项目文件不会被删除。") },
            confirmButton = {
                TextButton(
                    onClick = { confirmDeleteAll = false; vm.deleteAll() },
                    enabled = deletableCount > 0 && !ui.loading && !ui.working,
                ) { Text("确认清理", color = TbColors.Danger) }
            },
            dismissButton = { TextButton({ confirmDeleteAll = false }) { Text("取消") } },
        )
    }
}

internal data class AiChoice(val id: String, val title: String, val subtitle: String = "", val agent: String? = null)

/** 历史区最多直接渲染的条数：CLI 转录可能有几百条，超出部分提示到服务端查看。 */
private const val HISTORY_SECTION_LIMIT = 50

/** 历史会话区：默认收起，展开后列出当前项目 + Agent 的 CLI 转录历史，点击恢复继续对话。 */
@Composable
internal fun AiHistorySection(ui: AiUiState, toggle: () -> Unit, resume: (AiHistorySession) -> Unit) {
    val agent = ui.launchProvider?.agent ?: return
    val agentLabel = when (agent) {
        "codex" -> "Codex"
        "pi" -> "Pi"
        else -> "Claude Code"
    }
    Column {
        Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Surface(onClick = toggle, color = TbColors.SurfaceHover, shape = RoundedCornerShape(10.dp)) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Outlined.History, null, Modifier.size(18.dp), tint = TbColors.TextMuted)
                    Text(
                        "历史会话（$agentLabel）", Modifier.weight(1f),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    if (ui.historyLoading) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = TbColors.TextMuted)
                    } else if (ui.historySessions.isNotEmpty()) {
                        Text("${ui.historySessions.size} 条", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                    }
                    Icon(
                        Icons.Outlined.ExpandMore, if (ui.historyExpanded) "收起历史会话" else "展开历史会话",
                        Modifier.size(20.dp).rotate(if (ui.historyExpanded) 180f else 0f), tint = TbColors.TextMuted,
                    )
                }
            }
            if (ui.historyExpanded) {
                when {
                    ui.historyLoading && ui.historySessions.isEmpty() -> Text(
                        "正在同步${agentLabel}历史会话…",
                        Modifier.padding(horizontal = 8.dp, vertical = 10.dp),
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    )
                    ui.historySessions.isEmpty() -> Text(
                        "该项目暂无${agentLabel}历史会话。在电脑端用该 Agent 对话后会出现在这里。",
                        Modifier.padding(horizontal = 8.dp, vertical = 10.dp),
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    )
                    else -> Column(Modifier.padding(top = 4.dp)) {
                        ui.historySessions.take(HISTORY_SECTION_LIMIT).forEachIndexed { index, item ->
                            if (index > 0) AiDivider(Modifier.padding(start = 52.dp))
                            Surface(
                                onClick = { resume(item) }, enabled = !ui.working,
                                color = TbColors.Surface, shape = RoundedCornerShape(10.dp),
                            ) {
                                Row(
                                    Modifier.fillMaxWidth().padding(start = 2.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    AiAgentBadge(agent)
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                        Text(
                                            item.displayTitle, style = MaterialTheme.typography.titleSmall,
                                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        )
                                        Text(
                                            buildString {
                                                if (item.messageCount > 0) append("${item.messageCount} 条消息")
                                                item.model?.takeIf(String::isNotBlank)?.let { model ->
                                                    if (isNotEmpty()) append(" · ")
                                                    append(model)
                                                }
                                                val time = formatHistoryTime(item.updatedAt)
                                                if (time.isNotEmpty()) {
                                                    if (isNotEmpty()) append(" · ")
                                                    append(time)
                                                }
                                            },
                                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                    if (ui.working) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = TbColors.TextMuted)
                                    else Icon(Icons.Outlined.Replay, "恢复对话", Modifier.size(18.dp), tint = TbColors.TextMuted)
                                }
                            }
                        }
                        if (ui.historySessions.size > HISTORY_SECTION_LIMIT) {
                            Text(
                                "仅显示最近 $HISTORY_SECTION_LIMIT 条，共 ${ui.historySessions.size} 条",
                                Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun formatHistoryTime(timestamp: Long): String {
    if (timestamp <= 0) return ""
    val now = Calendar.getInstance()
    val time = Calendar.getInstance().apply { timeInMillis = timestamp }
    return when {
        now.get(Calendar.YEAR) == time.get(Calendar.YEAR) && now.get(Calendar.DAY_OF_YEAR) == time.get(Calendar.DAY_OF_YEAR) ->
            SimpleDateFormat("今天 HH:mm", Locale.getDefault()).format(Date(timestamp))
        now.get(Calendar.YEAR) == time.get(Calendar.YEAR) ->
            SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(timestamp))
        else -> SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(timestamp))
    }
}

/** 连续发送方式：服务端保存队列并自动续发，立即发送则中断当前回复优先处理。 */
@Composable
private fun AiSendModeSheet(sendImmediate: Boolean, select: (Boolean) -> Unit, dismiss: () -> Unit) {
    AiSheet("发送方式", dismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AiSendModeOption(
                Icons.Outlined.Schedule, "排队发送", "AI 回复期间发送的消息在服务端排队（App 关闭或被杀也不丢失），当前回复结束后自动按序发送；排队消息可删除，不想等待可点最右侧的发送箭头立即发送。",
                selected = !sendImmediate,
            ) { select(false); dismiss() }
            AiSendModeOption(
                Icons.Outlined.Bolt, "立即发送", "AI 回复期间发送新消息会中断当前回复，优先处理这条新消息。",
                selected = sendImmediate,
            ) { select(true); dismiss() }
            Text(
                "默认排队发送，仅影响本机 App 的连续发送行为，电脑端与 Web 端不受影响。",
                Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
            )
        }
    }
}

@Composable
private fun AiSendModeOption(
    icon: ImageVector, title: String, description: String, selected: Boolean, onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        color = if (selected) TbColors.Accent.copy(alpha = .12f) else TbColors.SurfaceHover,
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(icon, null, Modifier.size(22.dp), tint = if (selected) TbColors.Accent else TbColors.TextMuted)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(description, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
            if (selected) Icon(Icons.Outlined.Check, "已选择", Modifier.size(20.dp), tint = TbColors.Accent)
        }
    }
}

/** 首页只显示当前值，完整名称、路径与选中状态放在二级选择面板。 */
@Composable
internal fun AiChoiceField(
    label: String, icon: ImageVector, selectedId: String, placeholder: String, choices: List<AiChoice>,
    enabled: Boolean, select: (String) -> Unit, modifier: Modifier = Modifier, compact: Boolean = false,
    inlineLabel: Boolean = false,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val selected = choices.find { it.id == selectedId }
    val available = enabled && choices.isNotEmpty()
    LaunchedEffect(available) { if (!available) expanded = false }
    val verticalPadding = if (compact) 6.dp else 10.dp
    // 左右排列少了一行文字，用与原上下两行完全一致的高度兜底，保证卡片总高不随排布变化。
    val stackedLineHeight = if (compact) 29.sp else 38.sp
    val minHeight = if (inlineLabel) maxOf(
        if (compact) 45.dp else 60.dp,
        with(LocalDensity.current) { stackedLineHeight.toDp() } + verticalPadding * 2,
    ) else if (compact) 45.dp else 60.dp
    Surface(
        onClick = { expanded = true }, modifier = modifier.fillMaxWidth().alpha(if (available) 1f else .5f),
        enabled = available, color = TbColors.SurfaceHover, shape = RoundedCornerShape(if (compact) 11.dp else 14.dp),
    ) {
        Row(
            Modifier.heightIn(min = minHeight)
                .padding(horizontal = 14.dp, vertical = verticalPadding),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val selectedAgent = selected?.agent
            if (selectedAgent != null) AiAgentLogo(selectedAgent, Modifier.size(if (compact) 16.dp else 20.dp))
            else Icon(icon, null, Modifier.size(if (compact) 16.dp else 20.dp), tint = TbColors.TextMuted)
            if (inlineLabel) {
                // 标签与当前值紧挨着：内层 Row 占满图标与箭头之间的全部宽度，
                // 标签按内容宽度，值吃掉剩余空间（不能和占位 Spacer 平分权重，否则会被提前截断）。
                Row(
                    Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(label, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 13.sp else 18.sp),
                        color = TbColors.TextMuted, maxLines = 1)
                    Text(
                        selected?.title ?: placeholder,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.labelLarge.copy(lineHeight = if (compact) 16.sp else 20.sp),
                        color = if (selected == null) TbColors.TextMuted else TbColors.Text,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            } else {
                Column(Modifier.weight(1f)) {
                    Text(label, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 13.sp else 18.sp),
                        color = TbColors.TextMuted)
                    Text(
                        selected?.title ?: placeholder,
                        style = MaterialTheme.typography.labelLarge.copy(lineHeight = if (compact) 16.sp else 20.sp),
                        color = if (selected == null) TbColors.TextMuted else TbColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(if (compact) 15.dp else 18.dp), tint = TbColors.TextMuted)
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
internal fun AiSheet(
    title: String, dismiss: () -> Unit, heightFraction: Float? = null,
    action: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.() -> Unit,
) {
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    ModalBottomSheet(
        onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = TbColors.Surface,
    ) {
        // 高度限制放在内容区，让弹层按完整窗口高度计算底部停靠位置。
        Column(if (heightFraction != null) Modifier.fillMaxWidth().fillMaxHeight(heightFraction)
            else Modifier.fillMaxWidth().heightIn(max = screenHeight * .8f)) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                action()
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
