package com.terminalbuddy.android.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.progressSemantics
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NorthEast
import androidx.compose.material.icons.outlined.SouthWest
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.terminalbuddy.android.data.AiSession
import java.util.Locale
import kotlin.math.roundToInt

/** 展开时占据布局高度，收起时整张卡片及上下间距一起归零。 */
@Composable internal fun AiConversationUsageCard(
    session: AiSession, modelLabel: String, effortLabel: String, details: () -> Unit,
    expanded: Boolean, onExpandedChange: (Boolean) -> Unit, modifier: Modifier = Modifier,
) {
    val expansion = animateFloatAsState(
        targetValue = if (expanded) 1f else 0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 400f, visibilityThreshold = .001f),
        label = "模型与用量收展",
    )
    val usage = session.usage
    val contextUsage = usage?.context
    // 已用量记忆：刷新缺失时保留上一次；拿到过正值之后，0 不再覆盖，
    // 避免回合切换 / 上下文压缩期间显示从 250K 掉成 0K 再跳回去。
    val used = rememberKnownUsageValue(session.id,
        contextUsage?.takeUnless { it.updating }?.usedTokens?.takeIf { it >= 0 },
        rejectZeroAfterPositive = true)
    val capacity = rememberKnownUsageValue(session.id, contextUsage?.windowTokens?.takeIf { it > 0 })
    val rawRatio = if (used != null && used > 0 && capacity != null && capacity > 0)
        used.toDouble() / capacity else null
    // -1 表示本会话还没拿到过有效比例；Float 可被 rememberSaveable 直接保存。
    val knownRatio = rememberSaveable(session.id) { mutableStateOf(-1f) }
    // 没拿到值、刷新中或比例为 0 时都不推进进度条，沿用上一次有效比例，
    // 否则进度条会被打回零点再随下一份快照回弹，看起来一直在动。
    val ratio = retainContextProgress(knownRatio.value.takeIf { it >= 0f }?.toDouble(), rawRatio)
    SideEffect { ratio?.let { if (it.toFloat() != knownRatio.value) knownRatio.value = it.toFloat() } }
    val percent = when {
        ratio != null -> (ratio * 100).roundToInt().toString()
        used != null -> "0"
        else -> "—"
    }
    val context = if (contextUsage?.updating == true && used == null) "更新中(${formatAiTokensK(used)}/${formatAiTokensK(capacity)})"
        else "$percent%(${formatAiTokensK(used)}/${formatAiTokensK(capacity)})"
    val tokens = usage?.lastTurn ?: usage?.sessionTotal
    val inputTokens = rememberKnownUsageValue(session.id, tokens?.inputTokens?.takeIf { it >= 0 })
    val outputTokens = rememberKnownUsageValue(session.id, tokens?.outputTokens?.takeIf { it >= 0 })
    val fontScale = LocalDensity.current.fontScale
    Box(modifier.aiUsageReveal(expansion).padding(top = 8.dp, bottom = 2.dp).clip(RoundedCornerShape(15.dp))
        .then(if (expanded) Modifier else Modifier.clearAndSetSemantics {})) {
        Surface(
            Modifier.matchParentSize().graphicsLayer { alpha = expansion.value.coerceIn(0f, 1f) },
            color = TbColors.CanvasSoft, shape = RoundedCornerShape(15.dp), border = BorderStroke(1.dp, TbColors.Border),
        ) {}
        Column {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).graphicsLayer { alpha = expansion.value.coerceIn(0f, 1f) }
                    .clickable(enabled = expanded, role = Role.Button, onClickLabel = "查看模型与用量详情", onClick = details)
                    .then(if (expanded) Modifier else Modifier.clearAndSetSemantics {})
                    .heightIn(min = 48.dp).padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                    AiAgentLogo(session.provider, Modifier.size(22.dp))
                    Text("${session.providerLabel} · $modelLabel", Modifier.weight(1f),
                        style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp),
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Surface(color = TbColors.SurfaceHover, shape = RoundedCornerShape(7.dp)) {
                        Text("思考 $effortLabel", Modifier.padding(horizontal = 8.dp, vertical = 5.dp), color = TbColors.Accent,
                            style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp, fontWeight = FontWeight.Normal))
                    }
                }
                Box(Modifier.width(1.dp).height(18.dp).graphicsLayer { alpha = expansion.value.coerceIn(0f, 1f) }.background(TbColors.Border))
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    IconButton(
                        onClick = { onExpandedChange(!expanded) },
                        modifier = Modifier.fillMaxSize().semantics {
                            stateDescription = if (expanded) "已展开模型与用量" else "已收起模型与用量"
                        },
                    ) {
                        Icon(Icons.Outlined.KeyboardArrowDown, if (expanded) "收起模型与用量" else "展开模型与用量",
                            Modifier.size(20.dp).graphicsLayer { rotationZ = 180f * (1f - expansion.value.coerceIn(0f, 1f)) },
                            tint = TbColors.Accent)
                    }
                }
            }
            Column(Modifier.fillMaxWidth()
                .then(if (expanded) Modifier else Modifier.clearAndSetSemantics {})) {
                AiDivider()
                BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                    val stackedContext = maxWidth < 280.dp || fontScale > 1.15f
                    val stackedAmounts = maxWidth < 220.dp || fontScale > 1.4f
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (stackedContext) {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                                AiContextLabel()
                                AiContextValue(context)
                            }
                            AiContextProgress(ratio?.toFloat(), context, Modifier.fillMaxWidth())
                        } else {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                AiContextLabel()
                                AiContextProgress(ratio?.toFloat(), context, Modifier.weight(1f))
                                AiContextValue(context)
                            }
                        }
                        if (stackedAmounts) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                AiTokenAmount("输入", inputTokens, Icons.Outlined.SouthWest)
                                AiTokenAmount("输出", outputTokens, Icons.Outlined.NorthEast)
                            }
                        } else {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                AiTokenAmount("输入", inputTokens, Icons.Outlined.SouthWest)
                                AiTokenAmount("输出", outputTokens, Icons.Outlined.NorthEast)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 收起时悬浮在消息区右下角，不参与输入区域的高度分配。 */
@Composable internal fun AiUsageExpandButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        modifier.size(48.dp), color = Color(0xFFF8FAF9), shape = RoundedCornerShape(24.dp),
        border = BorderStroke(1.dp, Color(0xFFE3EAE0)), shadowElevation = 2.dp,
    ) {
        IconButton(onClick = onClick, modifier = Modifier.fillMaxSize().semantics { stateDescription = "已收起模型与用量" }) {
            Icon(Icons.Outlined.KeyboardArrowDown, "展开模型与用量",
                Modifier.size(20.dp).graphicsLayer { rotationZ = 180f }, tint = Color(0xFF206C54))
        }
    }
}

/** 内容始终按完整尺寸测量，只在布局和图层阶段读取动画，避免逐帧重组和文本重新换行。 */
private fun Modifier.aiUsageReveal(expansion: State<Float>): Modifier = clipToBounds().layout { measurable, constraints ->
    val content = measurable.measure(constraints.copy(minHeight = 0))
    val fraction = expansion.value.coerceIn(0f, 1f)
    val height = (content.height * fraction).roundToInt().coerceIn(constraints.minHeight, constraints.maxHeight)
    layout(content.width, height) {
        if (height > 0) content.placeRelativeWithLayer(0, 0) { alpha = fraction * fraction }
    }
}

@Composable private fun AiContextLabel() {
    Text("上下文", color = TbColors.TextMuted,
        style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp, fontWeight = FontWeight.Normal))
}

@Composable private fun AiContextValue(value: String) {
    Text(value, style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp, fontWeight = FontWeight.Normal, fontFeatureSettings = "tnum"))
}

@Composable private fun AiContextProgress(ratio: Float?, description: String, modifier: Modifier = Modifier) {
    // 调用方已经保证 ratio 只在拿到有效值时才变化，这里不做额外归零处理。
    val progress = animateFloatAsState(targetValue = ratio?.coerceIn(0f, 1f) ?: 0f, animationSpec = tween(240), label = "上下文占比")
    // TbColors 是 Composable 读取，需在进入非 Composable 的 draw 块之前取值。
    val low = TbColors.Accent
    val mid = TbColors.Warning
    val high = TbColors.Danger
    Canvas(modifier.height(6.dp).clip(RoundedCornerShape(3.dp)).background(TbColors.Border)
        .then(if (ratio != null) Modifier.progressSemantics(ratio.coerceIn(0f, 1f)) else Modifier)
        .semantics {
            contentDescription = "上下文占用"
            stateDescription = if (ratio == null) "暂无完整上下文统计，$description" else description
        }) {
        val fraction = progress.value.coerceIn(0f, 1f)
        if (ratio != null && fraction > 0f) {
            val color = when {
                fraction < .5f -> low
                fraction < .75f -> lerp(low, mid, (fraction - .5f) / .25f)
                else -> lerp(mid, high, ((fraction - .75f) / .15f).coerceIn(0f, 1f))
            }
            drawRoundRect(color, size = Size(size.width * fraction, size.height), cornerRadius = CornerRadius(size.height / 2))
        }
    }
}

@Composable private fun AiTokenAmount(label: String, tokens: Long?, icon: ImageVector) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(12.dp), tint = TbColors.TextMuted)
        Text(label, color = TbColors.TextMuted,
            style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp, fontWeight = FontWeight.Normal))
        Text(formatAiTokensK(tokens), style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp, fontFeatureSettings = "tnum"))
    }
}

/**
 * 按会话记住已知用量；刷新缺失时保持显示，新值到达后直接替换。
 * `rejectZeroAfterPositive` 用于上下文已用量：一旦拿到过正值，之后的 0 视为统计缺失，
 * 不再覆盖已知值，否则已用会显示成 `0K`，等下一份快照才跳回真实数值。
 */
@Composable private fun rememberKnownUsageValue(
    sessionId: String, value: Long?, rejectZeroAfterPositive: Boolean = false,
): Long? {
    var previous by rememberSaveable(sessionId) { mutableStateOf(value) }
    val accepted = acceptKnownUsage(previous, value, rejectZeroAfterPositive)
    SideEffect { if (accepted != null) previous = accepted }
    return accepted ?: previous
}

/** 返回本帧应当展示的用量：缺失返回 null 表示沿用上一次；reject 模式下 0 不算有效新值。 */
internal fun acceptKnownUsage(previous: Long?, value: Long?, rejectZeroAfterPositive: Boolean = false): Long? {
    if (value == null) return null
    if (rejectZeroAfterPositive && value <= 0L && (previous ?: 0L) > 0L) return null
    return value
}

/**
 * 进度条的取值规则：只有大于 0 且有限的新比例才替换上一次已显示的进度；
 * 缺失、刷新中或 0 值一律沿用旧值，首次仍无有效值时返回 null（不画进度）。
 */
internal fun retainContextProgress(previous: Double?, incoming: Double?): Double? {
    if (incoming == null || !incoming.isFinite() || incoming <= 0.0) return previous
    return incoming
}

/** 统一使用十进制 K；小于 1K 时保留到单个 Token，避免非零用量被显示为零。 */
private fun formatAiTokensK(tokens: Long?): String {
    if (tokens == null || tokens < 0) return "—K"
    if (tokens == 0L) return "0K"
    val precision = if (tokens < 1_000) 3 else 1
    return String.format(Locale.ROOT, "%.${precision}f", tokens / 1_000.0).trimEnd('0').trimEnd('.') + "K"
}
