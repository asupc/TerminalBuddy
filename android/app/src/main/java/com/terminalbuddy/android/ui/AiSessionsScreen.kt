package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.AiSession
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 顶部标题栏直接切换最近会话与服务端历史；服务端筛选独立于快速开始配置。 */
@Composable
internal fun AiSessionsScreen(
    ui: AiUiState, vm: AiViewModel, start: () -> Unit,
    delete: (AiSession) -> Unit, deleteAll: () -> Unit, recentRequest: Int,
) {
    key(ui.activeAccountId) {
        val pager = rememberPagerState { 2 }
        var handledRecentRequest by rememberSaveable { mutableIntStateOf(recentRequest) }
        LaunchedEffect(recentRequest) {
            if (handledRecentRequest != recentRequest) {
                pager.scrollToPage(0)
                handledRecentRequest = recentRequest
            }
        }
        val scope = rememberCoroutineScope()
        val compact = LocalConfiguration.current.screenHeightDp < 480
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 20.dp)
                    .padding(top = if (compact) 8.dp else 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TabRow(
                    selectedTabIndex = pager.currentPage,
                    modifier = Modifier.weight(1f),
                    containerColor = Color.Transparent, contentColor = TbColors.Accent,
                    divider = { AiDivider() },
                ) {
                    listOf("最近会话", "服务端会话").forEachIndexed { index, title ->
                        Tab(
                            selected = pager.currentPage == index,
                            onClick = { scope.launch { pager.animateScrollToPage(index) } },
                            selectedContentColor = TbColors.Text, unselectedContentColor = TbColors.TextMuted,
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                    Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                                    if (index == 0 && ui.sessions.isNotEmpty()) {
                                        Surface(color = TbColors.SurfaceHover, shape = RoundedCornerShape(6.dp)) {
                                            Text(if (ui.sessions.size > 99) "99+" else ui.sessions.size.toString(), Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                                style = MaterialTheme.typography.labelSmall, color = TbColors.TextSoft)
                                        }
                                    }
                                }
                            },
                        )
                    }
                }
                AiReconnectingIndicator(ui.reconnecting, Modifier.padding(start = 12.dp))
            }
            ui.error?.let { AiError(it, vm::clearError) }
            HorizontalPager(
                state = pager, modifier = Modifier.fillMaxWidth().weight(1f),
                verticalAlignment = Alignment.Top,
            ) { page ->
                when (page) {
                    0 -> AiRecentSessions(ui, vm, start, delete, deleteAll)
                    1 -> AiServerSessionsScreen(ui, vm)
                }
            }
        }
    }
}

@Composable
private fun AiRecentSessions(
    ui: AiUiState, vm: AiViewModel, start: () -> Unit,
    delete: (AiSession) -> Unit, deleteAll: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val sessions = ui.sessions.sortedByDescending { it.updatedAt }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item(key = "summary") {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                val unread = sessions.count { it.id in ui.unviewedIds }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("全部会话", style = MaterialTheme.typography.titleSmall)
                    Text("${sessions.size} 段会话${if (unread > 0) " · $unread 段有更新" else " · 最近更新优先"}",
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                }
                Box {
                    IconButton({ menu = true }) { Icon(Icons.Outlined.MoreHoriz, "更多会话操作", tint = TbColors.TextMuted) }
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
            AiCard(shape = RoundedCornerShape(20.dp)) {
                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("正在同步会话…", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                }
            }
        } else if (sessions.isEmpty()) item(key = "empty") {
            AiCard(shape = RoundedCornerShape(20.dp)) {
                AiEmptyState(Icons.Outlined.ChatBubbleOutline, "还没有最近会话",
                    "在快速开始中开启对话，所有助手的会话都会汇总在这里。") {
                    TextButton(start) { Text("开启新会话") }
                }
            }
        }
        items(sessions, key = { "session-${it.id}" }) { session ->
            AiSessionCard(ui, session, { vm.open(session.id) }, { delete(session) })
        }
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
