package com.terminalbuddy.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.TerminalAgentUiState
import com.terminalbuddy.android.TerminalAgentViewModel
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.TerminalAgentSession
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

/** 会话页使用文字标签和随滑动移动的指示线，底部一级导航保持独立。 */
@Composable
internal fun AiSessionsScreen(
    ui: AiUiState, vm: AiViewModel, start: () -> Unit,
    delete: (AiSession) -> Unit, deleteAll: () -> Unit, recentRequest: Int,
    unreadRequest: Int, unreadRequestHandled: (Int) -> Unit,
    terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
    agentUi: TerminalAgentUiState, agentVm: TerminalAgentViewModel,
    openAgent: (TerminalAgentSession) -> Unit,
) {
    key(ui.activeAccountId) {
        val pager = rememberPagerState { 3 }
        var handledRecentRequest by rememberSaveable { mutableIntStateOf(recentRequest) }
        LaunchedEffect(recentRequest, unreadRequest) {
            if (handledRecentRequest != recentRequest || unreadRequest > 0) {
                pager.scrollToPage(0)
                handledRecentRequest = recentRequest
            }
        }
        val scope = rememberCoroutineScope()
        val currentTerminalUi = if (terminalVm.isCurrentAccount() && terminalUi.connection == terminalVm.state.value.connection) {
            terminalUi
        } else ServerTerminalUiState()
        val currentAgentUi = if (agentVm.isCurrentAccount() && agentUi.connection == agentVm.state.value.connection) {
            agentUi
        } else TerminalAgentUiState()
        LaunchedEffect(ui.activeAccountId, ui.connectionRevision, pager.currentPage) {
            terminalVm.bindAccount()
            agentVm.bindAccount()
            if (!terminalVm.state.value.loaded || pager.currentPage == 2) terminalVm.refresh()
            // 最近页在可见期间持续同步，终端页沿用进入时刷新；普通终端失败不影响 Agent 列表。
            if (pager.currentPage != 0 && (!agentVm.state.value.listLoaded || pager.currentPage == 2)) agentVm.refresh()
        }
        LifecycleStartEffect(ui.activeAccountId, ui.connectionRevision, pager.currentPage) {
            // 创建终端时 Agent 可能尚未完成绑定，定期补拉以发现随后启动的会话并更新任务阶段。
            val refreshJob = if (pager.currentPage == 0) scope.launch {
                agentVm.bindAccount()
                while (isActive) {
                    agentVm.refresh()
                    delay(5_000)
                }
            } else null
            onStopOrDispose { refreshJob?.cancel() }
        }
        Column(Modifier.fillMaxSize()) {
            AiSessionTabs(
                pager = pager,
                counts = listOf(
                    (ui.sessions.size + currentAgentUi.sessions.size).takeIf {
                        ui.homeLoaded && (currentAgentUi.listLoaded || currentAgentUi.listError != null)
                    },
                    ui.projects.distinctBy { it.path }.size.takeIf { ui.homeLoaded },
                    currentTerminalUi.terminals.size.takeIf { currentTerminalUi.loaded },
                ),
                select = { index -> scope.launch { pager.animateScrollToPage(index) } },
            )
            ui.error?.let { AiError(it, vm::clearError) }
            HorizontalPager(
                state = pager, modifier = Modifier.fillMaxWidth().weight(1f),
                verticalAlignment = Alignment.Top,
            ) { page ->
                when (page) {
                    0 -> AiRecentSessions(ui, vm, start, delete, deleteAll,
                        unreadRequest = if (pager.settledPage == 0) unreadRequest else 0,
                        unreadRequestHandled = unreadRequestHandled,
                        agentUi = currentAgentUi, refreshAgents = agentVm::refresh, openAgent = openAgent)
                    1 -> AiServerSessionsScreen(ui, vm)
                    2 -> AiTerminalSessionsScreen(currentTerminalUi, terminalVm, currentAgentUi, agentVm, openAgent)
                }
            }
        }
    }
}

/** 主导航保持透明底，数量作为辅助信息，指示线与分页手势同步。 */
@Composable
private fun AiSessionTabs(pager: PagerState, counts: List<Int?>, select: (Int) -> Unit) {
    val titles = listOf("最近", "服务端", "终端")
    BoxWithConstraints(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 20.dp).padding(top = 4.dp),
    ) {
        val tabWidth = maxWidth / titles.size
        Row(Modifier.fillMaxWidth().selectableGroup()) {
            titles.forEachIndexed { index, title ->
                val selected = pager.currentPage == index
                Tab(
                    selected = selected,
                    onClick = { select(index) },
                    modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    selectedContentColor = TbColors.Text,
                    unselectedContentColor = TbColors.TextSoft,
                ) {
                    Row(
                        Modifier.padding(horizontal = 4.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                    ) {
                        Text(
                            title, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelLarge.copy(
                                fontSize = 15.sp,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                            ),
                        )
                        counts[index]?.let { count ->
                            Box(
                                Modifier.defaultMinSize(minWidth = 20.dp, minHeight = 20.dp)
                                    .background(if (selected) TbColors.SurfaceHover else Color.Transparent, RoundedCornerShape(6.dp))
                                    .padding(horizontal = 5.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    if (count > 99) "99+" else count.toString(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (selected) TbColors.TextSoft else TbColors.TextMuted,
                                )
                            }
                        }
                    }
                }
            }
        }
        HorizontalDivider(Modifier.align(Alignment.BottomCenter), color = TbColors.BorderSoft)
        val pagePosition = (pager.currentPage + pager.currentPageOffsetFraction).coerceIn(0f, titles.lastIndex.toFloat())
        Box(
            Modifier.align(Alignment.BottomStart)
                .offset(x = tabWidth * (pagePosition + .5f) - 12.dp)
                .size(width = 24.dp, height = 3.dp)
                .background(TbColors.Accent, RoundedCornerShape(2.dp)),
        )
    }
}

/** 最近列表同时展示原生 AI 会话与服务端终端会话，标识分开以保持滚动和未读定位稳定。 */
private sealed interface AiRecentEntry {
    val key: String
    val updatedAt: Long
    val running: Boolean

    data class Native(val session: AiSession) : AiRecentEntry {
        override val key get() = "session-${session.id}"
        override val updatedAt get() = session.updatedAt
        override val running get() = session.running
    }

    data class Remote(val session: TerminalAgentSession) : AiRecentEntry {
        override val key get() = "remote-${session.terminalId}"
        override val updatedAt get() = session.lastActivityAt ?: session.phaseAt ?: 0L
        override val running get() = session.pendingDecisionCount > 0 ||
            session.phase in setOf("running", "attention", "unknown")
    }
}

private data class AiRecentSessionGroup(
    val key: String, val title: String, val sessions: List<AiRecentEntry>,
)

@Composable
private fun AiRecentSessions(
    ui: AiUiState, vm: AiViewModel, start: () -> Unit,
    delete: (AiSession) -> Unit, deleteAll: () -> Unit,
    unreadRequest: Int, unreadRequestHandled: (Int) -> Unit,
    agentUi: TerminalAgentUiState, refreshAgents: () -> Unit,
    openAgent: (TerminalAgentSession) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    var lastLocatedSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    var highlightedSessionId by remember { mutableStateOf<String?>(null) }
    var highlightRequest by remember { mutableIntStateOf(0) }
    val highlightAlpha = remember { Animatable(0f) }
    val sessions = remember(ui.sessions, agentUi.sessions) {
        (ui.sessions.map { AiRecentEntry.Native(it) } + agentUi.sessions.map { AiRecentEntry.Remote(it) })
            .sortedByDescending { it.updatedAt }
    }
    val today = LocalDate.now()
    val zone = ZoneId.systemDefault()
    val groups = remember(sessions, ui.unviewedIds, today, zone) {
        // 状态优先于日期：运行中置顶，其次未读；各组沿用更新时间倒序。
        val (runningSessions, idleSessions) = sessions.partition { it.running }
        val (unreadSessions, viewedSessions) = idleSessions.partition {
            it is AiRecentEntry.Native && it.session.id in ui.unviewedIds
        }
        buildList {
            if (runningSessions.isNotEmpty()) add(AiRecentSessionGroup("running", "运行中", runningSessions))
            if (unreadSessions.isNotEmpty()) add(AiRecentSessionGroup("unread", "未读", unreadSessions))
            viewedSessions.groupBy { session ->
                session.updatedAt.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
            }.forEach { (date, daySessions) ->
                add(AiRecentSessionGroup("day:$date", sessionDateLabel(date, today), daySessions))
            }
        }
    }
    LaunchedEffect(unreadRequest) {
        if (unreadRequest == 0) return@LaunchedEffect
        val unreadSessions = groups.flatMap { it.sessions }.filterIsInstance<AiRecentEntry.Native>()
            .filter { it.session.id in ui.unviewedIds }
        if (unreadSessions.isNotEmpty()) {
            val next = (unreadSessions.indexOfFirst { it.session.id == lastLocatedSessionId } + 1) % unreadSessions.size
            val target = unreadSessions[next]
            // LazyColumn 首项为汇总行，每个分组还各有一个标题，不能直接使用会话下标。
            var itemIndex = 1
            for (group in groups) {
                itemIndex++
                val indexInGroup = group.sessions.indexOfFirst { it.key == target.key }
                if (indexInGroup >= 0) {
                    listState.animateScrollToItem(itemIndex + indexInGroup)
                    lastLocatedSessionId = target.session.id
                    highlightedSessionId = target.session.id
                    highlightRequest++
                    break
                }
                itemIndex += group.sessions.size
            }
        }
        unreadRequestHandled(unreadRequest)
    }
    LaunchedEffect(highlightRequest) {
        if (highlightedSessionId == null) return@LaunchedEffect
        highlightAlpha.snapTo(1f)
        highlightAlpha.animateTo(0f, keyframes {
            durationMillis = 2000
            1f at 1600
            0f at 2000
        })
        highlightedSessionId = null
    }
    LazyColumn(
        Modifier.fillMaxSize(), state = listState,
        contentPadding = PaddingValues(start = 20.dp, top = 8.dp, end = 20.dp, bottom = 28.dp),
    ) {
        item(key = "summary") {
            Column {
                Row(
                    Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "全部会话", Modifier.weight(1f),
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Box {
                        IconButton({ menu = true }, modifier = Modifier.size(32.dp)) {
                            Icon(Icons.Outlined.MoreHoriz, "更多会话操作", tint = TbColors.TextMuted)
                        }
                        DropdownMenu(menu, { menu = false }) {
                            DropdownMenuItem(text = { Text(if (ui.deletingAll) "正在清理…" else "清理全部空闲会话") },
                                leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(20.dp)) },
                                enabled = ui.sessions.any { !it.running } && !ui.loading && !ui.working && !ui.deletingAll,
                                onClick = { menu = false; deleteAll() })
                        }
                    }
                }
                agentUi.listError?.let { error ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(error, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                            color = TbColors.Danger, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        TextButton(refreshAgents, enabled = !agentUi.listLoading) { Text("重新同步") }
                    }
                }
            }
        }
        if (sessions.isEmpty() && (ui.initialLoading || (!agentUi.listLoaded && agentUi.listError == null))) item(key = "loading") {
            Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("正在同步会话…", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
        } else if (sessions.isEmpty()) item(key = "empty") {
            AiCard(shape = RoundedCornerShape(16.dp)) {
                AiEmptyState(Icons.Outlined.ChatBubbleOutline, "还没有最近会话",
                    "在快速开始或服务端开启助手对话后，会话会同步显示在这里。") {
                    TextButton(start) { Text("开启新会话") }
                }
            }
        }
        groups.forEach { group ->
            item(key = group.key) {
                // 状态与日期分组共用标题和分隔线，让置顶顺序与分组边界保持清晰。
                Column(Modifier.padding(top = 20.dp, bottom = 2.dp)) {
                    AiListLabel(
                        group.title,
                        trailing = "${group.sessions.size} 段",
                    )
                    HorizontalDivider(Modifier.padding(top = 8.dp), color = TbColors.Border)
                }
            }
            items(group.sessions, key = { it.key }) { entry ->
                when (entry) {
                    is AiRecentEntry.Native -> AiRecentSessionRow(
                        ui, entry.session, { vm.open(entry.session.id) }, { delete(entry.session) },
                        highlightAlpha = if (highlightedSessionId == entry.session.id) highlightAlpha.value else 0f,
                    )
                    is AiRecentEntry.Remote -> AiRemoteSessionRow(ui, entry.session, entry.running) {
                        openAgent(entry.session)
                    }
                }
            }
        }
        if (sessions.isNotEmpty()) item(key = "end") {
            Text("已显示全部 ${sessions.size} 段会话", Modifier.fillMaxWidth().padding(top = 20.dp),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
        }
    }
}

private fun sessionDateLabel(date: LocalDate?, today: LocalDate): String = when (date) {
    null -> "更早"
    today -> "今天"
    today.minusDays(1) -> "昨天"
    else -> date.format(DateTimeFormatter.ofPattern(if (date.year == today.year) "M月d日" else "yyyy年M月d日", Locale.CHINA))
}

/** 远程条目直接进入原终端的气泡镜像与回复通道，列表操作不会新建或恢复另一份会话。 */
@Composable
private fun AiRemoteSessionRow(
    ui: AiUiState, session: TerminalAgentSession, active: Boolean, open: () -> Unit,
) {
    val directory = session.directory.orEmpty()
    val project = ui.projects.find { it.path == directory }?.name
        ?: directory.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
    val accentColor = TbColors.Accent
    Column(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().clickable(onClick = open)
                .drawBehind {
                    if (active) drawRect(accentColor, size = Size(4.dp.toPx(), size.height))
                }
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AiAgentBadge(session.provider, size = 23.dp)
                Text(
                    session.displayTitle, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleSmall.copy(lineHeight = 17.sp),
                )
                Surface(color = TbColors.Accent.copy(alpha = .14f), shape = RoundedCornerShape(4.dp)) {
                    Text(
                        "远程", Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        color = TbColors.Accent, maxLines = 1,
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, lineHeight = 12.sp),
                    )
                }
                Icon(Icons.Outlined.ChevronRight, "接管远程会话", Modifier.size(15.dp), tint = TbColors.TextMuted)
            }
            Row(
                Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AgentPhaseTag(session)
                Text(
                    buildList {
                        add(project.ifBlank { "未命名项目" })
                        session.model?.takeIf(String::isNotBlank)?.let(::add)
                    }.joinToString(" · "),
                    Modifier.weight(1f), color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall.copy(lineHeight = 15.sp),
                )
                Text(
                    sessionTime(session.lastActivityAt ?: session.phaseAt ?: 0L), maxLines = 1,
                    style = MaterialTheme.typography.labelSmall.copy(lineHeight = 13.sp),
                    color = TbColors.TextMuted,
                )
            }
        }
        HorizontalDivider(color = TbColors.BorderSoft)
    }
}

/** 参考首页最近任务的两层信息布局，使用平面列表和分隔线，不添加卡片外观。 */
@Composable
internal fun AiRecentSessionRow(
    ui: AiUiState, session: AiSession, open: () -> Unit, delete: () -> Unit, highlightAlpha: Float = 0f,
) {
    val project = ui.projects.find { it.path == session.projectPath }?.name
        ?: session.projectPath.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
    val unread = session.id in ui.unviewedIds
    val enabled = !ui.working && !ui.deletingAll
    val active = session.running
    val accentColor = TbColors.Accent
    val failed = session.status == "error" || session.status == "interrupted"
    val status = when {
        active -> session.statusLabel
        unread -> "有新进展"
        failed -> session.statusLabel
        else -> session.providerLabel
    }
    val statusInk = when {
        active -> TbColors.AccentInk
        unread -> TbColors.Accent
        else -> TbColors.TextSoft
    }
    val statusFill = when {
        active -> TbColors.Accent
        unread -> TbColors.Accent.copy(alpha = .14f)
        else -> TbColors.SurfaceHover
    }
    Column(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth()
                .combinedClickable(
                    enabled = enabled, onClick = open,
                    onLongClickLabel = "删除会话", onLongClick = if (active) null else delete,
                )
                .drawBehind {
                    if (active) drawRect(accentColor, size = Size(4.dp.toPx(), size.height))
                }
                .then(if (highlightAlpha > 0f) Modifier.border(
                    2.dp, accentColor.copy(alpha = highlightAlpha), RoundedCornerShape(10.dp),
                ) else Modifier)
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box {
                    AiAgentBadge(session.provider, size = 23.dp)
                    if (active || unread) Box(
                        Modifier.align(Alignment.BottomEnd).size(9.dp)
                            .background(TbColors.Canvas, CircleShape)
                            .padding(2.dp)
                            .background(TbColors.Accent, CircleShape),
                    )
                }
                Text(
                    session.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleSmall.copy(lineHeight = 17.sp),
                )
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(15.dp), tint = TbColors.TextMuted)
            }
            Row(
                Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (active || unread || failed) {
                        Surface(color = statusFill, contentColor = statusInk, shape = RoundedCornerShape(4.dp)) {
                            Text(
                                status, Modifier.padding(horizontal = 6.dp, vertical = 2.dp), maxLines = 1,
                                style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, lineHeight = 12.sp),
                            )
                        }
                    } else {
                        Text(status, color = TbColors.TextMuted, maxLines = 1,
                            style = MaterialTheme.typography.labelMedium.copy(lineHeight = 14.sp))
                    }
                    Text("·", color = TbColors.TextMuted,
                        style = MaterialTheme.typography.labelMedium.copy(lineHeight = 14.sp))
                    Text(
                        project.ifBlank { "未命名项目" }, Modifier.weight(1f, fill = false),
                        color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall.copy(lineHeight = 15.sp),
                    )
                    Text("·", color = TbColors.TextMuted,
                        style = MaterialTheme.typography.labelMedium.copy(lineHeight = 14.sp))
                    Text(
                        session.modelLabel, Modifier.weight(1f), color = TbColors.TextMuted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall.copy(lineHeight = 15.sp),
                    )
                }
                Text(
                    sessionTime(session.updatedAt), maxLines = 1,
                    style = MaterialTheme.typography.labelSmall.copy(lineHeight = 13.sp),
                    color = TbColors.TextMuted,
                )
            }
        }
        HorizontalDivider(color = TbColors.BorderSoft)
    }
}

/** 同一会话卡片用于首页预览和完整列表，状态、未读和时间保持一致；compact 为首页的四分之三高度版本。 */
@Composable
internal fun AiSessionCard(
    ui: AiUiState, session: AiSession, open: () -> Unit, delete: (() -> Unit)? = null, compact: Boolean = false,
) {
    var menu by remember(session.id) { mutableStateOf(false) }
    val projectName = ui.projects.find { it.path == session.projectPath }?.name
        ?: session.projectPath.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
    val unread = session.id in ui.unviewedIds
    Surface(onClick = open, enabled = !ui.working && !ui.deletingAll, color = TbColors.Surface,
        shape = RoundedCornerShape(if (compact) 15.dp else 20.dp), border = BorderStroke(1.dp, TbColors.Border)) {
        Column(
            Modifier.fillMaxWidth().padding(if (compact) 12.dp else 16.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 9.dp else 12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 10.dp)) {
                AiAgentBadge(session.provider, size = if (compact) 23.dp else 30.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 3.dp)) {
                    Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleSmall.copy(lineHeight = if (compact) 17.sp else 22.sp))
                    Text(projectName.ifBlank { "未命名项目" }, color = TbColors.TextMuted, maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall.copy(lineHeight = if (compact) 15.sp else 20.sp))
                }
                if (delete == null) Icon(Icons.Outlined.ChevronRight, null,
                    Modifier.size(if (compact) 15.dp else 20.dp), tint = TbColors.TextMuted)
                else Box {
                    IconButton({ menu = true }, enabled = !ui.working && !ui.deletingAll) {
                        Icon(Icons.Outlined.MoreHoriz, "会话操作", Modifier.size(if (compact) 15.dp else 20.dp), tint = TbColors.TextMuted)
                    }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("删除会话") }, enabled = !session.running && !ui.working && !ui.deletingAll,
                            leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(20.dp)) },
                            onClick = { menu = false; delete() })
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val status = when {
                    session.running || session.status in listOf("error", "interrupted") -> session.statusLabel
                    unread -> "有新进展"
                    else -> session.providerLabel
                }
                Text(status, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 14.sp else 18.sp),
                    // 失败与中断同样不用报警色，运行中与未读用正文色强调。
                    color = if (unread || session.running) TbColors.Text else TbColors.TextMuted)
                Text("·", color = TbColors.TextMuted, style = MaterialTheme.typography.labelMedium.copy(lineHeight = if (compact) 14.sp else 18.sp))
                Text(session.modelLabel, Modifier.weight(1f), color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall.copy(lineHeight = if (compact) 15.sp else 20.sp))
                Text(sessionTime(session.updatedAt),
                    style = MaterialTheme.typography.labelSmall.copy(lineHeight = if (compact) 13.sp else 16.sp),
                    color = TbColors.TextMuted)
            }
        }
    }
}

private fun sessionTime(timestamp: Long): String {
    if (timestamp <= 0) return ""
    val minutes = ((System.currentTimeMillis() - timestamp).coerceAtLeast(0) / 60_000)
    return when {
        minutes == 0L -> "刚刚"
        minutes < 60 -> "${minutes} 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        else -> SimpleDateFormat("MM-dd", Locale.CHINA).format(Date(timestamp))
    }
}
