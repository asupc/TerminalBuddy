package com.terminalbuddy.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DataUsage
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.data.AiContextUsage
import com.terminalbuddy.android.data.AiSession
import com.terminalbuddy.android.data.AiTokenUsage
import java.text.NumberFormat
import java.util.Locale

private fun compactTokens(value: Long?): String {
    if (value == null || value < 0) return "—"
    val (amount, suffix) = when {
        value >= 1_000_000_000 -> value / 1_000_000_000.0 to "B"
        value >= 1_000_000 -> value / 1_000_000.0 to "M"
        value >= 1_000 -> value / 1_000.0 to "k"
        else -> return value.toString()
    }
    return String.format(Locale.ROOT, "%.1f", amount).removeSuffix(".0") + suffix
}

private fun preciseTokens(value: Long?): String = value?.takeIf { it >= 0 }
    ?.let { NumberFormat.getIntegerInstance(Locale.SIMPLIFIED_CHINESE).format(it) } ?: "—"

private fun contextLabel(context: AiContextUsage?): String {
    if (context?.updating == true) return "上下文待更新"
    val percentage = context?.percentage
    if (percentage != null) {
        val prefix = if (context?.estimated == true) "≈" else ""
        return "上下文 $prefix${String.format(Locale.ROOT, "%.0f", percentage)}%"
    }
    return context?.usedTokens?.let { "上下文 ${compactTokens(it)}" } ?: "上下文 —"
}

/** 随键盘与输入框显示，点击整行打开统计；窄屏及大字体自动分行。 */
@Composable
internal fun AiUsageBar(session: AiSession, details: () -> Unit) {
    val context = session.usage?.context
    val total = session.usage?.sessionTotal
    val percentage = context?.percentage
    val tint = when {
        percentage == null -> TbColors.TextMuted
        percentage >= 90 -> TbColors.Danger
        percentage >= 70 -> TbColors.Warning
        else -> TbColors.Accent
    }
    val label = contextLabel(context)
    val totalLabel = if (total?.coverage == "complete") "累计" else "已统计"
    val totals = if (session.usage == null) "用量待返回" else "$totalLabel ↑${compactTokens(total?.inputTokens)} ↓${compactTokens(total?.outputTokens)}"
    val description = "$label，${if (total?.coverage == "complete") "累计" else "已统计"}输入 ${preciseTokens(total?.inputTokens)} token，" +
        "输出 ${preciseTokens(total?.outputTokens)} token，点击查看用量详情"
    AiDivider(Modifier.padding(horizontal = 12.dp))
    BoxWithConstraints(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "查看用量详情", onClick = details)
            .semantics(mergeDescendants = true) { contentDescription = description }
            .heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        val narrow = maxWidth < 300.dp || LocalDensity.current.fontScale > 1.2f
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            if (percentage != null) {
                CircularProgressIndicator(
                    progress = { (percentage / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.size(14.dp),
                    color = tint, trackColor = TbColors.Border, strokeWidth = 2.dp,
                )
            } else Icon(Icons.Outlined.DataUsage, null, Modifier.size(14.dp), tint = tint)
            if (narrow) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(label, style = MaterialTheme.typography.labelMedium, color = tint)
                    Text(totals, style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                }
            } else {
                Text(label, style = MaterialTheme.typography.labelMedium, color = tint, maxLines = 1)
                Spacer(Modifier.weight(1f))
                Text(totals, style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(16.dp), tint = TbColors.TextMuted)
        }
    }
}

@Composable
internal fun AiUsageSheet(session: AiSession, dismiss: () -> Unit) {
    val usage = session.usage
    AiSheet("上下文与 Token", dismiss) {
        SelectionContainer(
            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(16.dp),
        ) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (usage == null) {
                    Text("当前会话暂无用量统计。收到模型用量后会自动显示。", color = TbColors.TextMuted)
                } else {
                    val context = usage.context
                    UsageSection("当前上下文") {
                        val contextValue = when {
                            context?.updating == true -> "等待下一次模型调用更新"
                            context?.percentage != null -> contextLabel(context).removePrefix("上下文 ")
                            else -> "占用率未知"
                        }
                        UsageRow("占用", contextValue)
                        UsageRow("已用 / 容量", "${preciseTokens(context?.usedTokens)} / ${preciseTokens(context?.windowTokens)} token")
                        UsageRow("容量来源", when (context?.windowSource) {
                            "cli" -> "模型报告"
                            "configuration" -> "会话配置"
                            else -> "尚未提供"
                        })
                        Text(
                            if (context?.basis == "inputAndOutput") "根据最近一次调用的输入与输出估算，可能与模型自身的上下文显示有差异。"
                            else "采用最近一次模型调用的输入量，包含缓存读取和写入；草稿和此后新增内容尚未计入。",
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                        )
                    }
                    UsageSection("本轮用量") {
                        UsageRow("统计状态", when (usage.lastTurn?.state) {
                            "final" -> "统计已完成"
                            "partial" -> "部分统计"
                            "provisional" -> if (session.running) "统计中" else "部分统计"
                            else -> "尚未开始"
                        })
                        TokenRows(usage.lastTurn)
                    }
                    UsageSection("本会话累计") {
                        TokenRows(usage.sessionTotal)
                        when (usage.sessionTotal?.coverage) {
                            "sinceUpgrade" -> Text(
                                "从功能升级后开始统计，之前的会话用量未包含在内。",
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                            )
                            "partial" -> Text(
                                "包含未完整结算的回合，当前数值可能小于实际消耗。",
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                            )
                        }
                    }
                    Text(
                        "缓存与推理明细已包含在对应输入、输出中。多轮对话会重复发送上下文，因此累计消耗可以超过上下文容量。",
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    )
                }
            }
        }
    }
}

@Composable
private fun UsageSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = TbColors.CanvasSoft, shape = RoundedCornerShape(12.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun UsageRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(.4f), style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted)
        Text(value, Modifier.weight(.6f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun TokenRows(tokens: AiTokenUsage?) {
    UsageRow("输入", "${preciseTokens(tokens?.inputTokens)} token")
    UsageRow("输出", "${preciseTokens(tokens?.outputTokens)} token")
    tokens?.cacheReadInputTokens?.let { UsageRow("其中缓存读取", "${preciseTokens(it)} token") }
    tokens?.cacheCreationInputTokens?.let { UsageRow("其中缓存写入", "${preciseTokens(it)} token") }
    tokens?.reasoningOutputTokens?.let { UsageRow("其中推理输出", "${preciseTokens(it)} token") }
}
