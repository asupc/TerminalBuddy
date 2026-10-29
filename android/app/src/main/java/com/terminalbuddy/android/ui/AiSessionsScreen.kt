package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.selection.selectableGroup
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.data.AiSession
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
    terminalUi: ServerTerminalUiState, terminalVm: ServerTerminalViewModel,
) {
    key(ui.activeAccountId) {
        val pager = rememberPagerState { 3 }
        var handledRecentRequest by rememberSaveable { mutableIntStateOf(recentRequest) }
        LaunchedEffect(recentRequest) {
            if (handledRecentRequest != recentRequest) {
                pager.scrollToPage(0)
                handledRecentRequest = recentRequest
            }
        }
        val scope = rememberCoroutineScope()
        val currentTerminalUi = if (terminalVm.isCurrentAccount() && terminalUi.connection == terminalVm.state.value.connection) {
            terminalUi
        } else ServerTerminalUiState()
        LaunchedEffect(ui.activeAccountId, ui.connectionRevision, pager.currentPage) {
            terminalVm.bindAccount()
            if (!terminalVm.state.value.loaded || pager.currentPage == 2) terminalVm.refresh()
        }
        Column(Modifier.fillMaxSize()) {
            AiSessionTabs(
                pager = pager,
                counts = listOf(
                    ui.sessions.size.takeIf { ui.homeLoaded },
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
                    0 -> AiRecentSessions(ui, vm, start, delete, deleteAll)
                    1 -> AiServerSessionsScreen(ui, vm)
                    2 -> AiTerminalSessionsScreen(currentTerminalUi, terminalVm)
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

@Composable
private fun AiRecentSessions(
    ui: AiUiState, vm: AiViewModel, start: () -> Unit,
    delete: (AiSession) -> Unit, deleteAll: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val sessions = remember(ui.sessions) { ui.sessions.sortedByDescending { it.updatedAt } }
    val today = LocalDate.now()
    val zone = ZoneId.systemDefault()
    val groups = remember(sessions, today, zone) {
        sessions.groupBy { session ->
            session.updatedAt.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
        }
    }
    val unread = sessions.count { it.id in ui.unviewedIds }
    val running = sessions.count { it.running }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 28.dp),
    ) {
        item(key = "summary") {
            AiSectionRow(
                title = "全部会话",
                subtitle = buildList {
                    if (sessions.isNotEmpty()) add("${sessions.size} 段会话")
                    if (running > 0) add("$running 段运行中")
                    if (unread > 0) add("$unread 段有更新")
                }.joinToString(" · ").ifBlank { "最近更新优先" },
            ) {
                Box {
                    IconButton({ menu = true }, modifier = Modifier.size(40.dp)) {
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
        }
        if (ui.initialLoading && sessions.isEmpty()) item(key = "loading") {
            Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("正在同步会话…", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
        } else if (sessions.isEmpty()) item(key = "empty") {
            AiCard(shape = RoundedCornerShape(16.dp)) {
                AiEmptyState(Icons.Outlined.ChatBubbleOutline, "还没有最近会话",
                    "在快速开始中开启对话，所有助手的会话都会汇总在这里。") {
                    TextButton(start) { Text("开启新会话") }
                }
            }
        }
        groups.forEach { (date, daySessions) ->
            item(key = "day:$date") {
                // 日期分组：今天 / 昨天 / 具体日期，数量跟在后面作为辅助信息。
                AiListLabel(
                    sessionDateLabel(date, today), Modifier.padding(top = 18.dp, bottom = 6.dp),
                    trailing = "${daySessions.size} 段",
                )
            }
            items(daySessions, key = { "session-${it.id}" }) { session ->
                AiRecentSessionRow(ui, session, { vm.open(session.id) }, { delete(session) })
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

/**
 * 会话页专用轻列表：左侧助手标识 + 标题/项目与模型 + 右下时间与状态胶囊。
 * 运行中的会话整行带浅色底和左侧强调条，一眼能区分「在跑」与「空闲」。
 */
@Composable
private fun AiRecentSessionRow(ui: AiUiState, session: AiSession, open: () -> Unit, delete: () -> Unit) {
    var menu by remember(session.id) { mutableStateOf(false) }
    val project = ui.projects.find { it.path == session.projectPath }?.name
        ?: session.projectPath.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
    val unread = session.id in ui.unviewedIds
    val enabled = !ui.working && !ui.deletingAll
    val highlighted = session.running || unread || session.status == "error"
    val status = when {
        session.running || session.status in listOf("error", "interrupted") -> session.statusLabel
        unread -> "有新进展"
        else -> null
    }
    val statusColor = when {
        session.status == "error" -> TbColors.Danger
        session.running || unread -> TbColors.Accent
        else -> TbColors.TextMuted
    }
    Column(Modifier.fillMaxWidth()) {
        Surface(
            onClick = open, enabled = enabled, color = Color.Transparent,
            modifier = Modifier.fillMaxWidth().then(
                // 运行中的行铺一层极浅的强调底色，左侧补一条 3dp 实线，与空闲行区分开。
                if (highlighted) Modifier.background(
                    Brush.horizontalGradient(
                        listOf(TbColors.Accent.copy(alpha = .08f), TbColors.Accent.copy(alpha = 0f)),
                    ),
                ) else Modifier,
            ),
        ) {
            Row(
                Modifier.fillMaxWidth()
                    .drawBehind {
                        if (highlighted) drawRect(statusColor, size = Size(3.dp.toPx(), size.height))
                    }
                    .padding(start = 12.dp, end = 4.dp, top = 11.dp, bottom = 11.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp),
            ) {
                AiAgentBadge(session.provider, size = 32.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleSmall)
                    Text(
                        "${project.ifBlank { "未命名项目" }} · ${session.providerLabel} / ${session.modelLabel}",
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    )
                }
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(sessionTime(session.updatedAt), style = MaterialTheme.typography.labelSmall,
                        color = TbColors.TextMuted, maxLines = 1)
                    status?.let {
                        Surface(color = statusColor.copy(alpha = .1f), shape = RoundedCornerShape(6.dp)) {
                            Text(it, Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                style = MaterialTheme.typography.labelSmall, color = statusColor, maxLines = 1)
                        }
                    }
                }
                Box {
                    IconButton({ menu = true }, enabled = enabled, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Outlined.MoreHoriz, "会话操作", Modifier.size(17.dp), tint = TbColors.TextMuted)
                    }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("删除会话") }, enabled = !session.running && enabled,
                            leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(20.dp)) },
                            onClick = { menu = false; delete() })
                    }
                }
            }
        }
        AiDivider(Modifier.padding(start = 12.dp))
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
                    color = if (session.status == "error") TbColors.Danger else if (unread || session.running) TbColors.Text else TbColors.TextMuted)
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
