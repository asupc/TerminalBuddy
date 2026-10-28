package com.terminalbuddy.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal enum class AiHomeTab(val title: String, val subtitle: String, val icon: ImageVector) {
    QuickStart("快速开始", "从一个新想法开始", Icons.Outlined.Bolt),
    Sessions("会话", "让每一次思考，都能继续", Icons.Outlined.ChatBubbleOutline),
    Profile("我的", "你的空间，你的习惯", Icons.Outlined.PersonOutline),
}

/** 三个一级入口始终位于底部；二级页面由根导航接管。 */
@Composable
internal fun AiBottomNavigation(selected: AiHomeTab, unread: Int, select: (AiHomeTab) -> Unit) {
    Surface(color = TbColors.Surface) {
        Column {
            AiDivider()
            NavigationBar(containerColor = TbColors.Surface, tonalElevation = 0.dp) {
                AiHomeTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = selected == tab,
                        onClick = { select(tab) },
                        icon = {
                            BadgedBox(badge = {
                                if (tab == AiHomeTab.Sessions && unread > 0) {
                                    Badge(containerColor = TbColors.Accent, contentColor = TbColors.AccentInk) {
                                        Text(if (unread > 99) "99+" else unread.toString())
                                    }
                                }
                            }) { Icon(tab.icon, null, Modifier.size(23.dp)) }
                        },
                        label = { Text(tab.title, maxLines = 1) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = TbColors.Text, selectedTextColor = TbColors.Text,
                            unselectedIconColor = TbColors.TextMuted, unselectedTextColor = TbColors.TextMuted,
                            indicatorColor = TbColors.SurfaceHover,
                        ),
                    )
                }
            }
        }
    }
}

/** 助手选择使用相同的名称与标识，黑白主题下都明确显示选中态。stacked 为卡片样式：上方图标、下方文字。 */
@Composable
internal fun AiAgentTabs(
    agents: List<String>, selected: String, select: (String) -> Unit,
    modifier: Modifier = Modifier, enabledAgents: List<String> = agents, stacked: Boolean = false,
) {
    Row(
        modifier.fillMaxWidth().selectableGroup()
            .background(TbColors.ButtonTrack, RoundedCornerShape(16.dp)).padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        agents.forEach { agent ->
            val active = selected == agent
            val enabled = agent in enabledAgents
            val ink = if (active) TbColors.ButtonForeground else if (enabled) TbColors.TextSoft else TbColors.TextMuted
            Surface(
                modifier = Modifier.weight(1f).alpha(if (enabled) 1f else .45f).selectable(
                    selected = active, enabled = enabled, role = Role.Tab, onClick = { select(agent) },
                ),
                color = if (active) TbColors.ButtonBackground else TbColors.ButtonTrack,
                shape = RoundedCornerShape(12.dp),
                border = if (active) primaryControlBorder() else null,
            ) {
                if (stacked || agents.size > 2) {
                    Column(
                        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 4.dp, vertical = 10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        AiAgentLogo(agent, Modifier.size(18.dp), tint = ink)
                        Text(if (agent == "claude") "Claude" else agentTitle(agent),
                            style = MaterialTheme.typography.labelMedium, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                } else {
                    Row(
                        Modifier.heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
                    ) {
                        AiAgentLogo(agent, Modifier.size(18.dp), tint = ink)
                        Text(if (agent == "claude") "Claude" else agentTitle(agent),
                            style = MaterialTheme.typography.labelLarge, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

@Composable
internal fun AiSectionTitle(
    title: String, subtitle: String? = null, modifier: Modifier = Modifier,
    compact: Boolean = false, action: @Composable () -> Unit = {},
) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (compact) 1.dp else 3.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium.copy(lineHeight = if (compact) 20.sp else 24.sp))
            subtitle?.let {
                Text(it, style = MaterialTheme.typography.bodySmall.copy(lineHeight = if (compact) 15.sp else 20.sp),
                    color = TbColors.TextMuted)
            }
        }
        action()
    }
}

/** 二级页面统一保留系统安全区和明确的返回入口。 */
@Composable
internal fun AiSubpageHeader(title: String, back: () -> Unit, action: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(start = 8.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回", Modifier.size(22.dp)) }
        Text(title, Modifier.weight(1f).padding(start = 4.dp), style = MaterialTheme.typography.titleMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        action()
    }
}

@Composable
internal fun AiEmptyState(icon: ImageVector, title: String, description: String, action: @Composable () -> Unit = {}) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Surface(Modifier.size(48.dp), color = TbColors.SurfaceHover, shape = RoundedCornerShape(16.dp)) {
            Box(contentAlignment = Alignment.Center) { Icon(icon, null, Modifier.size(24.dp), tint = TbColors.TextMuted) }
        }
        Text(title, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
        Text(description, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted, textAlign = TextAlign.Center)
        action()
    }
}
