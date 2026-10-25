package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
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

/** 决策固定显示在聊天区底部，正文可滚动，提交操作始终可见。 */
@Composable
internal fun AiApprovalCard(
    approval: AiApproval, working: Boolean, maxHeight: Dp, pendingCount: Int,
    answer: (AiApproval, String, JsonObject) -> Unit,
) {
    var selections by remember(approval.id) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var custom by remember(approval.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
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
    fun responses(question: ApprovalQuestion): List<String> =
        selections[question.id].orEmpty() + listOfNotNull(custom[question.id]?.trim()?.takeIf(String::isNotBlank))

    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp).heightIn(max = maxHeight),
        color = TbColors.SurfaceHover, shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, TbColors.Accent.copy(alpha = .5f)),
    ) {
        Column(Modifier.padding(horizontal = 10.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Outlined.VerifiedUser, null, Modifier.size(16.dp), tint = TbColors.Accent)
                Text(if (questions.isEmpty()) "需要你确认" else "请选择后继续对话", Modifier.weight(1f),
                    style = MaterialTheme.typography.titleSmall)
                if (pendingCount > 1) Text("待处理 $pendingCount", color = TbColors.TextMuted,
                    style = MaterialTheme.typography.labelSmall)
            }
            key(approval.id) {
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (questions.isEmpty()) SelectionContainer {
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
                    }
                    questions.forEachIndexed { index, question ->
                        if (questions.size > 1) Text(
                            "${index + 1}/${questions.size}" + question.header.takeIf(String::isNotBlank)?.let { " · $it" }.orEmpty(),
                            style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted,
                        )
                        Text(question.text, style = MaterialTheme.typography.bodyMedium)
                        if (question.multiple) Text("可选择多项", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                        question.options.forEach { option ->
                            val label = option.text("label")
                            val selected = label in selections[question.id].orEmpty()
                            Surface(
                                color = if (selected) TbColors.Accent.copy(alpha = .1f) else TbColors.CanvasSoft,
                                shape = RoundedCornerShape(8.dp),
                                border = BorderStroke(1.dp, if (selected) TbColors.Accent else TbColors.Border),
                            ) {
                                Row(
                                    Modifier.fillMaxWidth().toggleable(
                                        value = selected, enabled = !working,
                                        role = if (question.multiple) Role.Checkbox else Role.RadioButton,
                                        onValueChange = { checked ->
                                            selections = selections + (question.id to if (question.multiple) {
                                                val previous = selections[question.id].orEmpty()
                                                if (checked) previous + label else previous - label
                                            } else listOf(label))
                                            if (!question.multiple) custom = custom - question.id
                                        },
                                    ).padding(horizontal = 8.dp, vertical = 8.dp),
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
                        OutlinedTextField(
                            value = custom[question.id].orEmpty(),
                            onValueChange = {
                                custom = custom + (question.id to it)
                                if (it.isNotBlank() && !question.multiple) selections = selections - question.id
                            },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text(if (question.options.isEmpty()) "你的回复" else "其他回答") },
                            maxLines = 3, enabled = !working, shape = RoundedCornerShape(10.dp),
                            textStyle = MaterialTheme.typography.bodyMedium,
                            visualTransformation = if (question.secret) PasswordVisualTransformation() else VisualTransformation.None,
                        )
                    }
                }
            }
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                TextButton({ answer(approval, "decline", JsonObject(emptyMap())) }, enabled = !working) {
                    Text(if (questions.isEmpty()) "拒绝" else "暂不回答")
                }
                TextButton(
                    onClick = {
                        val values = buildJsonObject {
                            questions.forEach { question ->
                                put(question.id, buildJsonObject {
                                    put("answers", buildJsonArray { responses(question).forEach { add(it) } })
                                })
                            }
                        }
                        answer(approval, "accept", values)
                    },
                    enabled = !working && questions.all { responses(it).isNotEmpty() },
                ) { Text(if (questions.isEmpty()) "允许本次" else "提交选择") }
            }
        }
    }
}
