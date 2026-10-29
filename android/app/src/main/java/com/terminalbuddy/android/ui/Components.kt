package com.terminalbuddy.android.ui

import android.os.SystemClock
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

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
fun PageHeader(
    title: String, reconnecting: Boolean = false, subtitle: String = "",
    action: @Composable RowScope.() -> Unit = {},
) {
    val compact = LocalConfiguration.current.screenHeightDp < 480
    Box(Modifier.fillMaxWidth().statusBarsPadding(), contentAlignment = Alignment.TopCenter) {
        Row(
            Modifier.widthIn(max = 680.dp).fillMaxWidth()
                .padding(start = 24.dp, end = 16.dp, top = if (compact) 8.dp else 24.dp, bottom = if (compact) 8.dp else 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f, fill = false), color = TbColors.Text,
                        style = if (compact) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.headlineMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    AiReconnectingIndicator(reconnecting, Modifier.padding(start = 8.dp))
                }
                if (!compact && subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted)
            }
            action()
        }
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

/** 标题后的重连菊花与文字：默认隐藏，一次展示至少持续一秒。 */
@Composable
internal fun AiReconnectingIndicator(reconnecting: Boolean, modifier: Modifier = Modifier) {
    var showing by remember { mutableStateOf(reconnecting) }
    var shownAt by remember { mutableLongStateOf(if (reconnecting) SystemClock.elapsedRealtime() else 0L) }
    LaunchedEffect(reconnecting) {
        if (reconnecting) {
            if (!showing) {
                shownAt = SystemClock.elapsedRealtime()
                showing = true
            }
        } else if (showing) {
            delay((1_000L - (SystemClock.elapsedRealtime() - shownAt)).coerceAtLeast(0L))
            showing = false
        }
    }
    if (showing || reconnecting) {
        Row(modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            stateDescription = "正在重新连接"
        }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            AiConnectionSpinner(TbColors.Accent, Modifier.size(16.dp))
            Text("重连中", style = MaterialTheme.typography.labelMedium, color = TbColors.Accent, maxLines = 1)
        }
    }
}

/** 复用葫芦娃 Android 的十二瓣画法，逐瓣轮转亮度形成菊花旋转效果。 */
@Composable
internal fun AiConnectionSpinner(color: Color, modifier: Modifier) {
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

/** 状态小圆点：强调色表示在线/执行中或未读，灰色表示空闲。尺寸由调用方按所在行的字号决定。 */
@Composable
internal fun AiStatusDot(color: Color, modifier: Modifier = Modifier, size: Dp = 5.dp) {
    Box(modifier.size(size).background(color, CircleShape))
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

/**
 * 折叠项目卡：标题行给出名称、路径与数量，展开后由调用方铺开缩进的明细行。
 * 服务端历史与终端配置共用同一套层级，不再各自实现一份「项目 → 明细」。
 * icon 传 null 时按展开状态显示文件夹 / 打开的文件夹。
 */
@Composable
internal fun AiProjectAccordion(
    name: String,
    path: String,
    expanded: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    count: String? = null,
    icon: ImageVector? = null,
    iconTint: Color = TbColors.Accent,
    toggle: () -> Unit,
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val rotation by animateFloatAsState(
        if (expanded) 180f else 0f,
        animationSpec = tween(240, easing = FastOutSlowInEasing), label = "项目展开箭头",
    )
    AiCard(
        modifier = modifier.fillMaxWidth().semantics {
            stateDescription = if (expanded) "已展开" else "已折叠"
        },
        shape = RoundedCornerShape(16.dp),
    ) {
        Surface(
            onClick = toggle, enabled = enabled, color = Color.Transparent,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 12.dp, end = 8.dp, top = 11.dp, bottom = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier.size(34.dp).background(TbColors.SurfaceHover, RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        icon ?: if (expanded) Icons.Outlined.FolderOpen else Icons.Outlined.Folder,
                        null, Modifier.size(19.dp), tint = iconTint,
                    )
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (path.isNotBlank()) Text(
                        path, style = MaterialTheme.typography.labelSmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                        color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                count?.let { AiCountBadge(it) }
                Icon(
                    Icons.Outlined.ExpandMore, if (expanded) "收起" else "展开",
                    Modifier.size(20.dp).graphicsLayer { rotationZ = rotation }, tint = TbColors.TextSoft,
                )
            }
        }
        AiAccordionContent(expanded) {
            AiDivider()
            Column(
                Modifier.fillMaxWidth().background(TbColors.CanvasSoft)
                    .padding(start = 18.dp, end = 12.dp, top = 2.dp, bottom = 6.dp),
                content = content,
            )
        }
    }
}

/** 项目明细从顶部平滑伸缩并淡入淡出，收起动画结束后再移除内容。 */
@Composable
internal fun AiAccordionContent(expanded: Boolean, content: @Composable ColumnScope.() -> Unit) {
    AnimatedVisibility(
        visible = expanded,
        enter = expandVertically(tween(240, easing = FastOutSlowInEasing), expandFrom = Alignment.Top) +
            fadeIn(tween(180)),
        exit = shrinkVertically(tween(240, easing = FastOutSlowInEasing), shrinkTowards = Alignment.Top) +
            fadeOut(tween(120)),
    ) {
        Column(
            // 异步历史加载完成时，明细高度变化也保持连续。
            Modifier.fillMaxWidth().animateContentSize(tween(240, easing = FastOutSlowInEasing)),
            content = content,
        )
    }
}

/** 项目卡标题行右侧的数量角标；数字与单位分开排，避免和标题抢宽度。 */
@Composable
internal fun AiCountBadge(text: String) {
    Surface(color = TbColors.SurfaceHover, shape = RoundedCornerShape(6.dp)) {
        Text(
            text, Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
            style = MaterialTheme.typography.labelSmall, color = TbColors.TextSoft, maxLines = 1,
        )
    }
}

/** 展开卡内部的明细行：右侧保留动作图标，行间用细线分隔，不重复画卡片描边。 */
@Composable
internal fun AiAccordionRow(
    enabled: Boolean,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    iconColor: Color = TbColors.TextMuted,
    showDivider: Boolean = true,
    trailing: @Composable () -> Unit = {},
    onClick: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        onClick = onClick, enabled = enabled, color = Color.Transparent,
        modifier = modifier.fillMaxWidth().alpha(if (enabled) 1f else .55f),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                icon?.let { Icon(it, null, Modifier.size(17.dp), tint = iconColor) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp), content = content)
                trailing()
            }
            if (showDivider) AiDivider()
        }
    }
}

/** 板块内的小标题，例如「已打开」「项目配置」；外边距由调用方按所在列表的间距补。 */
@Composable
internal fun AiListLabel(text: String, modifier: Modifier = Modifier, trailing: String? = null) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text, Modifier.weight(1f), maxLines = 1,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color = TbColors.TextSoft,
        )
        trailing?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted) }
    }
}

/** 板块标题行：左侧标题与说明，右侧操作入口。 */
@Composable
internal fun AiSectionRow(
    title: String, subtitle: String, modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(subtitle, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted, maxLines = 2)
        }
        trailing()
    }
}

