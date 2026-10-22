package com.terminalbuddy.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 小尺寸方角图标（30dp），用于首页会话行和对话里的助手标记。 */
@Composable
internal fun AiSmallIcon(icon: ImageVector, modifier: Modifier = Modifier) {
    Box(
        modifier.background(TbColors.SurfaceHover, RoundedCornerShape(9.dp)).size(30.dp),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(16.dp), tint = TbColors.Accent)
    }
}

/** 页面标题栏：左对齐大标题，右侧操作区。 */
@Composable
fun PageHeader(title: String, action: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding()
            .heightIn(min = 64.dp).padding(start = 20.dp, end = 8.dp, top = 14.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title, color = TbColors.Text,
                fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.Bold, maxLines = 1,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.Terminal, null, Modifier.size(11.dp), tint = TbColors.TextMuted)
                Text("AI 对话功能由终端 AI 提供", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
            }
        }
        action()
    }
}

/**
 * 页面级错误条：左侧图标 + 可滚动的错误文本 + 关闭按钮。
 * 错误可能很长（服务端返回的原始异常），限高避免把整页顶出屏幕。
 */
@Composable
internal fun AiError(message: String, dismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(TbColors.Danger.copy(alpha = .08f)).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(16.dp), tint = TbColors.Danger)
        Text(
            message, Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 8.dp).heightIn(max = 80.dp),
            color = TbColors.Danger, style = MaterialTheme.typography.bodySmall,
        )
        IconButton(dismiss) { Icon(Icons.Outlined.Close, "关闭提示", Modifier.size(18.dp), tint = TbColors.Danger) }
    }
}

/** 细分割线，颜色统一走终端底色体系。 */
@Composable
internal fun AiDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier, color = TbColors.BorderSoft)
}

/** 状态小圆点：绿色表示在线/执行中，红色表示失败，灰色表示空闲。 */
@Composable
internal fun AiStatusDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.size(5.dp).background(color, CircleShape))
}

/** 带描边的卡片容器，AI 首页和会话页的卡片都复用它。 */
@Composable
internal fun AiCard(
    modifier: Modifier = Modifier,
    shape: RoundedCornerShape = RoundedCornerShape(14.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier, color = TbColors.Surface, shape = shape,
        border = androidx.compose.foundation.BorderStroke(1.dp, TbColors.Border),
    ) {
        Column(content = content)
    }
}
