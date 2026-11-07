package com.terminalbuddy.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** 原生会话与终端会话共用页面、标题栏和系统边距。 */
@Composable
internal fun AiConversationLayout(
    title: String, reconnecting: Boolean, onBack: () -> Unit, onMenu: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(
        modifier = Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
        containerColor = TbColors.Surface,
        contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom),
        topBar = {
            Surface(color = TbColors.Surface) {
                Column {
                    Row(
                        Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 56.dp)
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onBack) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回 AI 首页", Modifier.size(20.dp), tint = TbColors.TextMuted)
                        }
                        Row(
                            Modifier.weight(1f).padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                title, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.titleMedium,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            AiReconnectingIndicator(reconnecting)
                        }
                        actions()
                        IconButton(onMenu) {
                            Icon(Icons.Outlined.MoreHoriz, "对话操作", Modifier.size(20.dp), tint = TbColors.TextMuted)
                        }
                    }
                    AiDivider()
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), content = content)
    }
}

@Composable
internal fun AiConversationEmptyState(
    provider: String, loading: Boolean, modifier: Modifier = Modifier, message: String? = null,
) {
    Column(
        modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AiAgentBadge(provider)
        Text(
            message ?: if (loading) "正在加载消息…" else "发送第一条消息，开始对话。",
            style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted,
        )
    }
}

@Composable
internal fun AiConversationJumpToLatest(visible: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = visible, modifier = modifier,
        enter = fadeIn(tween(180)) + slideInVertically(tween(220)) { it / 2 },
        exit = fadeOut(tween(120)) + slideOutVertically(tween(160)) { it / 2 },
    ) {
        FilledTonalButton(
            onClick, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            colors = primaryButtonColors(tonal = true), border = primaryControlBorder(),
            elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = 2.dp),
        ) {
            Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp))
            Text("回到最新")
        }
    }
}
