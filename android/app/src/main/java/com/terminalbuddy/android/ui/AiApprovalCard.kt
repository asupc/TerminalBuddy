package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.data.*
import kotlinx.serialization.json.*

private data class ApprovalQuestion(
    val id: String, val text: String, val header: String, val options: List<JsonObject>,
    val multiple: Boolean, val secret: Boolean,
)

/** 悬浮在上下文卡片上方：单选直接提交，多题逐题选择，多选与自由回答显式提交。 */
@Composable
internal fun AiApprovalCard(
    approval: AiApproval, working: Boolean, maxHeight: Dp, pendingCount: Int,
    answer: (AiApproval, String, JsonObject) -> Unit, modifier: Modifier = Modifier,
) {
    var selections by remember(approval.id) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var custom by remember(approval.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var activeIndex by remember(approval.id) { mutableIntStateOf(0) }
    var customQuestion by remember(approval.id) { mutableStateOf<String?>(null) }
    val questions = remember(approval.id, approval.details) {
        approval.details.rows("questions").mapIndexed { index, element ->
            val question = element.asObject()
            ApprovalQuestion(
                id = question.text("id").ifBlank { "question-$index" },
                text = question.text("question", "header"), header = question.text("header"),
                options = question.rows("options").map { it.asObject() }.filter { it.text("label").isNotBlank() },
                multiple = (question["multiSelect"] as? JsonPrimitive)?.booleanOrNull == true,
                secret = (question["isSecret"] as? JsonPrimitive)?.booleanOrNull == true,
            )
        }
    }
    val question = questions.getOrNull(activeIndex)
    fun responses(item: ApprovalQuestion, choices: Map<String, List<String>> = selections, texts: Map<String, String> = custom): List<String> =
        choices[item.id].orEmpty() + listOfNotNull(texts[item.id]?.trim()?.takeIf(String::isNotBlank))
    fun submitOrNext(choices: Map<String, List<String>> = selections, texts: Map<String, String> = custom) {
        val missing = questions.indexOfFirst { responses(it, choices, texts).isEmpty() }
        if (missing >= 0) {
            activeIndex = missing
            return
        }
        val values = buildJsonObject {
            questions.forEach { item ->
                put(item.id, buildJsonObject {
                    put("answers", buildJsonArray { responses(item, choices, texts).forEach { add(it) } })
                })
            }
        }
        answer(approval, "accept", values)
    }
    Surface(
        modifier.fillMaxWidth().heightIn(max = maxHeight),
        color = TbColors.SurfaceHover, shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, TbColors.Accent.copy(alpha = .5f)), shadowElevation = 10.dp,
    ) {
        Column(Modifier.padding(horizontal = 12.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Outlined.VerifiedUser, null, Modifier.size(17.dp), tint = TbColors.Accent)
                Text(if (questions.isEmpty()) "需要你确认" else "等待你的选择", Modifier.weight(1f),
                    style = MaterialTheme.typography.titleSmall)
                if (pendingCount > 1) Text("待处理 $pendingCount", color = TbColors.TextMuted,
                    style = MaterialTheme.typography.labelSmall)
            }
            key(approval.id, question?.id) {
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (question == null) SelectionContainer {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(approval.details.text("title").ifBlank {
                                approval.details.text("toolName", fallback = "是否允许本次文件修改或命令执行？")
                            }, style = MaterialTheme.typography.bodyMedium)
                            val reason = approval.details.text("reason")
                            if (reason.isNotBlank()) Text(reason, style = MaterialTheme.typography.bodySmall, color = TbColors.TextSoft)
                            val command = approval.details.text("command")
                            val input = approval.details["input"] as? JsonObject
                            val detail = command.ifBlank { input?.takeIf { it.isNotEmpty() }?.toString().orEmpty() }
                            if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace, color = TbColors.TextSoft)
                        }
                    } else {
                        if (questions.size > 1) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            IconButton({ activeIndex-- }, enabled = activeIndex > 0 && !working, modifier = Modifier.size(36.dp)) {
                                Icon(Icons.Outlined.ChevronLeft, "上一题", Modifier.size(18.dp))
                            }
                            Text("${activeIndex + 1}/${questions.size}" + question.header.takeIf(String::isNotBlank)?.let { " · $it" }.orEmpty(),
                                Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                            IconButton({ activeIndex++ }, enabled = activeIndex < questions.lastIndex && !working, modifier = Modifier.size(36.dp)) {
                                Icon(Icons.Outlined.ChevronRight, "下一题", Modifier.size(18.dp))
                            }
                        }
                        Text(question.text, style = MaterialTheme.typography.bodyMedium)
                        Text(when {
                            question.options.isEmpty() -> "填写回复后点击确认"
                            question.multiple -> "可多选，选好后点击确认"
                            else -> "点击选项即可继续"
                        }, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                        question.options.forEach { option ->
                            val label = option.text("label")
                            val selected = label in selections[question.id].orEmpty()
                            Surface(
                                color = if (selected) TbColors.Accent.copy(alpha = .1f) else TbColors.CanvasSoft,
                                shape = RoundedCornerShape(10.dp),
                                border = BorderStroke(1.dp, if (selected) TbColors.Accent else TbColors.Border),
                            ) {
                                Row(
                                    Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(
                                        value = selected, enabled = !working,
                                        role = if (question.multiple) Role.Checkbox else Role.RadioButton,
                                        onValueChange = { checked ->
                                            val choices = selections + (question.id to if (question.multiple) {
                                                val previous = selections[question.id].orEmpty()
                                                if (checked) previous + label else previous - label
                                            } else listOf(label))
                                            val texts = if (question.multiple) custom else custom - question.id
                                            selections = choices
                                            custom = texts
                                            if (!question.multiple) submitOrNext(choices, texts)
                                        },
                                    ).padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    if (question.multiple) Checkbox(selected, onCheckedChange = null, enabled = !working)
                                    else RadioButton(selected, onClick = null, enabled = !working)
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(label, style = MaterialTheme.typography.bodyMedium)
                                        val description = option.text("description")
                                        if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodySmall,
                                            color = TbColors.TextMuted)
                                    }
                                }
                            }
                        }
                        if (question.options.isEmpty() || customQuestion == question.id || custom[question.id]?.isNotBlank() == true) {
                            Column(
                                Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                // 标签放在框外，避免浮动标签截断输入框的上边框。
                                Text("你的回复", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                                OutlinedTextField(
                                    value = custom[question.id].orEmpty(),
                                    onValueChange = {
                                        custom = custom + (question.id to it)
                                        if (it.isNotBlank() && !question.multiple) selections = selections - question.id
                                    },
                                    modifier = Modifier.fillMaxWidth(), placeholder = { Text("请输入你的回复") },
                                    maxLines = 3, enabled = !working, shape = RoundedCornerShape(10.dp),
                                    textStyle = MaterialTheme.typography.bodyMedium,
                                    visualTransformation = if (question.secret) PasswordVisualTransformation() else VisualTransformation.None,
                                )
                            }
                        } else TextButton({ customQuestion = question.id }, enabled = !working) { Text("其他回答") }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                TextButton({ answer(approval, "decline", JsonObject(emptyMap())) }, enabled = !working) {
                    Text(if (questions.isEmpty()) "拒绝" else "暂不回答")
                }
                if (question == null || question.multiple || question.options.isEmpty() || customQuestion == question.id || custom[question.id]?.isNotBlank() == true) {
                    TextButton(
                        onClick = { submitOrNext() }, enabled = !working && (question == null || responses(question).isNotEmpty()),
                    ) { Text(if (question == null) "允许本次" else if (questions.any { responses(it).isEmpty() && it.id != question.id }) "下一题" else "确认选择") }
                }
            }
        }
    }
}
