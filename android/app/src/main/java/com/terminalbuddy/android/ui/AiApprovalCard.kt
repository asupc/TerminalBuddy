package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.data.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

private data class ApprovalQuestion(
    val id: String, val text: String, val header: String, val options: List<JsonObject>,
    val multiple: Boolean, val secret: Boolean,
)

/** 多题可自由切换；每题的选择独立保存，确认本项后自动继续。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AiApprovalCard(
    approval: AiApproval, working: Boolean, maxHeight: Dp, pendingCount: Int,
    answer: (AiApproval, String, JsonObject) -> Unit, modifier: Modifier = Modifier,
) {
    var selections by remember(approval.id) { mutableStateOf<Map<String, Set<String>>>(emptyMap()) }
    var custom by remember(approval.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var completed by remember(approval.id) { mutableStateOf<Set<String>>(emptySet()) }
    var customQuestions by remember(approval.id) { mutableStateOf<Set<String>>(emptySet()) }
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
    val pager = key(approval.id) { rememberPagerState(pageCount = { questions.size.coerceAtLeast(1) }) }
    val scope = rememberCoroutineScope()
    val activeIndex = pager.currentPage.coerceAtMost(questions.lastIndex.coerceAtLeast(0))
    val question = questions.getOrNull(activeIndex)
    // 翻页状态只负责页面位置，不能锁住选项、确认按钮或标签导航。
    val enabled = !working
    fun responses(item: ApprovalQuestion, choices: Map<String, Set<String>> = selections, texts: Map<String, String> = custom): List<String> =
        choices[item.id].orEmpty().toList() + listOfNotNull(texts[item.id]?.trim()?.takeIf(String::isNotBlank))
    fun completeQuestion(item: ApprovalQuestion, choices: Map<String, Set<String>> = selections, texts: Map<String, String> = custom) {
        if (!enabled || responses(item, choices, texts).isEmpty()) return
        val confirmed = completed + item.id
        completed = confirmed
        // 勾选只是草稿：多选和自由回答必须显式完成，滑到下一页不能提前提交。
        val missing = questions.indices.filter { questions[it].id !in confirmed || responses(questions[it], choices, texts).isEmpty() }
        val current = questions.indexOfFirst { it.id == item.id }
        val next = missing.firstOrNull { it > current } ?: missing.firstOrNull()
        if (next != null) {
            scope.launch { pager.animateScrollToPage(next) }
            return
        }
        val values = buildJsonObject {
            questions.forEach { entry ->
                put(entry.id, buildJsonObject {
                    put("answers", buildJsonArray { responses(entry, choices, texts).forEach { add(it) } })
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
                if (questions.size > 1) Text("已完成 ${completed.size}/${questions.size}", color = TbColors.TextMuted,
                    style = MaterialTheme.typography.labelSmall)
                if (pendingCount > 1) Text("待处理 $pendingCount", color = TbColors.TextMuted,
                    style = MaterialTheme.typography.labelSmall)
            }
            if (questions.size > 1) {
                ScrollableTabRow(
                    selectedTabIndex = activeIndex, modifier = Modifier.fillMaxWidth(), edgePadding = 0.dp,
                    containerColor = Color.Transparent, contentColor = TbColors.Accent, divider = {},
                ) {
                    questions.forEachIndexed { index, item ->
                        Tab(
                            selected = activeIndex == index, enabled = enabled,
                            onClick = { scope.launch { pager.animateScrollToPage(index) } },
                            selectedContentColor = TbColors.Accent, unselectedContentColor = TbColors.TextMuted,
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    if (item.id in completed) Icon(Icons.Outlined.Check, "已完成", Modifier.size(14.dp))
                                    Text(item.header.ifBlank { "第 ${index + 1} 项" }, Modifier.widthIn(max = 140.dp),
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            },
                        )
                    }
                }
            }
            if (questions.isEmpty()) {
                SelectionContainer(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
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
            } else {
                HorizontalPager(
                    state = pager, modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
                    key = { questions[it].id }, pageSpacing = 12.dp, verticalAlignment = Alignment.Top,
                    userScrollEnabled = !working && questions.size > 1,
                ) { index ->
                    val item = questions[index]
                    ApprovalQuestionPage(
                        question = item, selected = selections[item.id].orEmpty(), custom = custom[item.id].orEmpty(),
                        showCustom = item.id in customQuestions, enabled = enabled,
                        onOption = { label, checked ->
                            // 每次只更新当前题的当前选项；点选始终只存草稿，不自动跳题。
                            val previous = selections[item.id].orEmpty()
                            val choices = selections + (item.id to if (item.multiple) {
                                if (checked) previous + label else previous - label
                            } else setOf(label))
                            val texts = if (item.multiple) custom else custom - item.id
                            selections = choices
                            custom = texts
                            completed = completed - item.id
                        },
                        onCustom = { text ->
                            custom = custom + (item.id to text)
                            completed = completed - item.id
                            if (text.isNotBlank() && !item.multiple) selections = selections - item.id
                        },
                        onShowCustom = { customQuestions = customQuestions + item.id },
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                if (questions.size > 1) {
                    // 浏览与完成分开，未作答也能前后切换；答案保留在题目 ID 对应的草稿中。
                    IconButton(
                        onClick = { scope.launch { pager.animateScrollToPage((pager.currentPage - 1).coerceAtLeast(0)) } },
                        enabled = enabled && activeIndex > 0, modifier = Modifier.size(36.dp),
                    ) { Icon(Icons.Outlined.ChevronLeft, "上一项") }
                    IconButton(
                        onClick = { scope.launch { pager.animateScrollToPage((pager.currentPage + 1).coerceAtMost(questions.lastIndex)) } },
                        enabled = enabled && activeIndex < questions.lastIndex, modifier = Modifier.size(36.dp),
                    ) { Icon(Icons.Outlined.ChevronRight, "下一项，可稍后回答本项") }
                }
                Spacer(Modifier.weight(1f))
                TextButton({ answer(approval, "decline", JsonObject(emptyMap())) }, enabled = enabled) {
                    Text(if (questions.isEmpty()) "拒绝" else "暂不回答")
                }
                TextButton(
                    onClick = {
                        if (question == null) answer(approval, "accept", JsonObject(emptyMap()))
                        else completeQuestion(question)
                    },
                    enabled = enabled && (question == null || responses(question).isNotEmpty()),
                ) {
                    Text(when {
                        question == null -> "允许本次"
                        questions.size == 1 -> "确认选择"
                        questions.any { it.id != question.id && it.id !in completed } -> "完成本项"
                        else -> "提交全部"
                    })
                }
            }
        }
    }
}

@Composable
private fun ApprovalQuestionPage(
    question: ApprovalQuestion, selected: Set<String>, custom: String, showCustom: Boolean, enabled: Boolean,
    onOption: (String, Boolean) -> Unit, onCustom: (String) -> Unit, onShowCustom: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 8.dp, bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SelectionContainer { Text(question.text, style = MaterialTheme.typography.bodyMedium) }
        Text(when {
            question.options.isEmpty() -> "填写回复后点击下方按钮完成"
            question.multiple -> "可多选 · 已选 ${selected.size} 项，选好后点击下方按钮确认"
            else -> "单选，选好后点击下方按钮确认"
        }, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
        question.options.forEach { option ->
            val label = option.text("label")
            val checked = label in selected
            // 整行统一处理事件，复选框/单选框只展示状态，避免一次点击处理两次。
            val selectionModifier = if (question.multiple) {
                Modifier.toggleable(value = checked, enabled = enabled, role = Role.Checkbox,
                    onValueChange = { checked -> onOption(label, checked) })
            } else {
                Modifier.selectable(selected = checked, enabled = enabled, role = Role.RadioButton,
                    onClick = { onOption(label, true) })
            }
            Surface(
                color = if (checked) TbColors.Accent.copy(alpha = .1f) else TbColors.CanvasSoft,
                shape = RoundedCornerShape(10.dp),
                border = BorderStroke(1.dp, if (checked) TbColors.Accent else TbColors.Border),
            ) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).then(selectionModifier).padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (question.multiple) Checkbox(checked, onCheckedChange = null, enabled = enabled)
                    else RadioButton(checked, onClick = null, enabled = enabled)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                        val description = option.text("description")
                        if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
            }
        }
        if (question.options.isEmpty() || showCustom || custom.isNotBlank()) {
            Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                // 标签放在框外，避免浮动标签截断输入框的上边框。
                Text("你的回复", style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
                OutlinedTextField(
                    value = custom, onValueChange = onCustom,
                    modifier = Modifier.fillMaxWidth(), placeholder = { Text("请输入你的回复") },
                    maxLines = 3, enabled = enabled, shape = RoundedCornerShape(10.dp),
                    textStyle = MaterialTheme.typography.bodyMedium,
                    visualTransformation = if (question.secret) PasswordVisualTransformation() else VisualTransformation.None,
                )
            }
        } else TextButton(onShowCustom, enabled = enabled) { Text("其他回答") }
    }
}
