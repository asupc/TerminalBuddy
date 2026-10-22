package com.terminalbuddy.android.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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

/** 右上角主题开关：48dp 点击区域，读屏同时播报当前模式和切换动作。 */
@Composable
internal fun ThemeToggleButton() {
    val controls = LocalThemeControls.current
    IconToggleButton(
        checked = controls.darkTheme,
        onCheckedChange = controls.onDarkThemeChange,
        modifier = Modifier.size(48.dp).semantics {
            stateDescription = if (controls.darkTheme) "深色模式" else "浅色模式"
        },
        colors = IconButtonDefaults.iconToggleButtonColors(
            contentColor = TbColors.TextSoft,
            checkedContainerColor = TbColors.Accent.copy(alpha = .12f),
            checkedContentColor = TbColors.Accent,
        ),
    ) {
        Icon(
            if (controls.darkTheme) Icons.Outlined.LightMode else Icons.Outlined.DarkMode,
            contentDescription = if (controls.darkTheme) "切换为浅色模式" else "切换为深色模式",
            modifier = Modifier.size(20.dp),
        )
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
                fontSize = 24.sp, lineHeight = 32.sp, fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.Terminal, null, Modifier.size(11.dp), tint = TbColors.TextMuted)
                Text(
                    "AI 对话功能由终端 AI 提供", Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        action()
        ThemeToggleButton()
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

/** 根界面中的固定悬浮提示，不参与页面内容的测量和排版。 */
@Composable
internal fun AiConnectingOverlay(modifier: Modifier = Modifier) {
    Surface(
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        shape = RoundedCornerShape(24.dp), color = TbColors.Surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, TbColors.Border),
        shadowElevation = 6.dp,
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AiConnectionSpinner(TbColors.Accent, Modifier.size(16.dp))
            Text("连接中", color = TbColors.Text, fontSize = 13.sp, lineHeight = 18.sp, maxLines = 1)
        }
    }
}

/** 复用葫芦娃 Android 的十二瓣画法，逐瓣轮转亮度形成菊花旋转效果。 */
@Composable
private fun AiConnectionSpinner(color: Color, modifier: Modifier) {
    val transition = rememberInfiniteTransition(label = "服务器连接")
    val phase by transition.animateFloat(
        initialValue = 0f, targetValue = 12f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 960, easing = LinearEasing)),
        label = "连接轮转",
    )
    Canvas(modifier) {
        val radius = size.minDimension * .42f
        repeat(12) { index ->
            val age = (phase.toInt() - index + 12) % 12
            rotate(degrees = index * 30f) {
                drawLine(
                    color = color.copy(alpha = 1f - age * .065f),
                    start = Offset(center.x, center.y - radius),
                    end = Offset(center.x, center.y - radius * .55f),
                    strokeWidth = size.minDimension * .08f,
                    cap = StrokeCap.Round,
                )
            }
        }
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
