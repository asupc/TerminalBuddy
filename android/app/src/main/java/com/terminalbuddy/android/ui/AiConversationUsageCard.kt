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

/** 共用同一套布局和动画进度，收起后保留右侧箭头入口。 */
@Composable internal fun AiConversationUsageCard(
    session: AiSession, modelLabel: String, effortLabel: String, details: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable(session.id) { mutableStateOf(true) }
    val expansion = animateFloatAsState(
        targetValue = if (expanded) 1f else 0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 400f, visibilityThreshold = .001f),
        label = "模型与用量收展",
    )
    val usage = session.usage
    val contextUsage = usage?.context
    val used = contextUsage?.usedTokens?.takeIf { it >= 0 }
    val capacity = contextUsage?.windowTokens?.takeIf { it > 0 }
    val ratio = contextUsage?.percentage?.div(100)
    val percent = ratio?.let { (it * 100).roundToInt().toString() } ?: "—"
    val context = if (contextUsage?.updating == true) "更新中(${formatAiTokensK(used)}/${formatAiTokensK(capacity)})"
        else "$percent%(${formatAiTokensK(used)}/${formatAiTokensK(capacity)})"
    val tokens = usage?.lastTurn ?: usage?.sessionTotal
    val fontScale = LocalDensity.current.fontScale
    Box(modifier.clip(RoundedCornerShape(15.dp))) {
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
                    Surface(
                        Modifier.matchParentSize().graphicsLayer { alpha = 1f - expansion.value.coerceIn(0f, 1f) },
                        color = TbColors.SurfaceHover, shape = RoundedCornerShape(24.dp), border = BorderStroke(1.dp, TbColors.Border),
                    ) {}
                    IconButton(
                        onClick = { expanded = !expanded },
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
            Column(Modifier.fillMaxWidth().aiUsageReveal(expansion)
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
                                AiTokenAmount("输入", tokens?.inputTokens, Icons.Outlined.SouthWest)
                                AiTokenAmount("输出", tokens?.outputTokens, Icons.Outlined.NorthEast)
                            }
                        } else {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                AiTokenAmount("输入", tokens?.inputTokens, Icons.Outlined.SouthWest)
                                AiTokenAmount("输出", tokens?.outputTokens, Icons.Outlined.NorthEast)
                            }
                        }
                    }
                }
            }
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

/** 统一使用十进制 K；小于 1K 时保留到单个 Token，避免非零用量被显示为零。 */
private fun formatAiTokensK(tokens: Long?): String {
    if (tokens == null || tokens < 0) return "—K"
    if (tokens == 0L) return "0K"
    val precision = if (tokens < 1_000) 3 else 1
    return String.format(Locale.ROOT, "%.${precision}f", tokens / 1_000.0).trimEnd('0').trimEnd('.') + "K"
}
