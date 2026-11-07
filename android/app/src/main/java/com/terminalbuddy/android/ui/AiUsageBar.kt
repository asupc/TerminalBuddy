package com.terminalbuddy.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
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

/** 保留统一入口，界面使用一体化轻卡片，详情沿用完整的用量数据。 */
@Composable
internal fun AiUsageCard(
    session: AiSession, modelLabel: String, effortLabel: String, details: () -> Unit,
    expanded: Boolean, onExpandedChange: (Boolean) -> Unit, modifier: Modifier = Modifier,
) {
    AiConversationUsageCard(session, modelLabel, effortLabel, details, expanded, onExpandedChange, modifier)
}

@Composable
internal fun AiUsageSheet(session: AiSession, modelLabel: String, effortLabel: String, dismiss: () -> Unit) {
    val usage = session.usage
    AiSheet("上下文与 Token", dismiss) {
        SelectionContainer(
            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(16.dp),
        ) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                UsageSection("模型与思考强度") {
                    UsageRow("模型", modelLabel)
                    UsageRow("思考强度", effortLabel)
                    Text(
                        "思考强度按当前供应商模型配置显示，未提供时跟随服务端。",
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    )
                }
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
                            else -> Unit
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
