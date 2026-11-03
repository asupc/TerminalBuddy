package com.terminalbuddy.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.terminalbuddy.android.ServerDecisionViewModel
import com.terminalbuddy.android.data.ServerDecisionOption
import com.terminalbuddy.android.data.ServerDecisionQuestion
import com.terminalbuddy.android.notifications.ServerDecisionNotice
import com.terminalbuddy.android.notifications.ServerNotificationTarget
import kotlinx.coroutines.delay

/**
 * 服务端任务通知的 App 内入口（全局唯一 Host）：有待决策时显示悬浮按钮，
 * 点击通知或终端 Agent 对话页的「待决策」按钮可受控打开决策面板。
 * 面板浮在任意一级页面之上，不依赖 AI 会话或当前选中的终端；
 * 对话页不另行实例化本 Host，避免双悬浮按钮 / 双面板。
 */
@Composable
internal fun ServerDecisionHost(
    vm: ServerDecisionViewModel,
    openRequest: ServerNotificationTarget?,
    onRequestConsumed: () -> Unit,
    activeAccountId: String? = null,
) {
    val decisions by vm.decisions.collectAsStateWithLifecycle()
    val answering by vm.answering.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    var open by rememberSaveable { mutableStateOf(false) }
    var focusedDecision by remember { mutableStateOf<String?>(null) }
    // 经请求打开的面板记录账号归属；切换账号立即关闭旧账号面板。
    var panelAccount by remember { mutableStateOf<String?>(null) }
    var handledNotice by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(openRequest) {
        if (openRequest != null) {
            // 完成通知只把 App 带到前台；只有决策通知才自动展开面板。
            focusedDecision = openRequest.decisionId
            panelAccount = openRequest.accountId ?: activeAccountId
            onRequestConsumed()
        }
    }
    LaunchedEffect(focusedDecision, decisions) {
        val target = focusedDecision ?: return@LaunchedEffect
        if (decisions.any { it.decisionId == target }) {
            open = true
            focusedDecision = null
        } else {
            // 决策列表尚不含目标：给通知流一小段到达时间（冷启动决策可能还没同步到），
            // 超时只提示未能打开，不断言已被处理，也不永久等待。
            delay(2500)
            if (focusedDecision == target && decisions.none { it.decisionId == target }) {
                handledNotice = "未能打开该决策，可能已被处理"
                focusedDecision = null
            }
        }
    }
    LaunchedEffect(activeAccountId, open) {
        if (open && panelAccount != null && activeAccountId != null && panelAccount != activeAccountId) {
            open = false
            panelAccount = null
        }
    }
    LaunchedEffect(handledNotice) {
        if (handledNotice != null) {
            delay(4000)
            handledNotice = null
        }
    }
    Box(Modifier.fillMaxSize()) {
        if (decisions.isNotEmpty() && !open) {
            Box(
                Modifier.align(Alignment.TopEnd).statusBarsPadding()
                    .padding(top = 58.dp, end = 16.dp),
            ) {
                BadgedBox(badge = {
                    Badge(containerColor = TbColors.Accent, contentColor = TbColors.AccentInk) {
                        Text(if (decisions.size > 99) "99+" else decisions.size.toString())
                    }
                }) {
                    FloatingActionButton(
                        onClick = { open = true; panelAccount = activeAccountId },
                        containerColor = TbColors.Accent, contentColor = TbColors.AccentInk,
                    ) {
                        Icon(Icons.Outlined.PendingActions, "服务端待决策")
                    }
                }
            }
        }
        handledNotice?.let { notice ->
            Surface(
                Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 12.dp),
                color = TbColors.SurfaceRaised, shape = RoundedCornerShape(12.dp),
            ) {
                Text(
                    notice, Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodySmall, color = TbColors.Text,
                )
            }
        }
    }
    if (open) {
        ServerDecisionSheet(
            decisions = decisions, answering = answering, error = error,
            clearError = vm::clearError, dismiss = { open = false },
            answer = vm::answer,
        )
    }
}

@Composable
private fun ServerDecisionSheet(
    decisions: List<ServerDecisionNotice>,
    answering: Set<String>, error: String?, clearError: () -> Unit,
    dismiss: () -> Unit,
    answer: (ServerDecisionNotice, Map<String, String>) -> Unit,
) {
    AiSheet("服务端决策", dismiss, heightFraction = .88f) {
        error?.let { AiError(it, clearError) }
        if (decisions.isEmpty()) {
            AiEmptyState(Icons.Outlined.TaskAlt, "暂无待处理的决策",
                "服务端终端或 AI 任务需要你选择、回答或授权时会显示在这里。")
        } else {
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(decisions, key = { it.decisionId }) { notice ->
                    ServerDecisionCard(
                        notice = notice,
                        answering = notice.decisionId in answering,
                        answer = answer,
                    )
                }
            }
        }
    }
}

@Composable
private fun ServerDecisionCard(
    notice: ServerDecisionNotice, answering: Boolean,
    answer: (ServerDecisionNotice, Map<String, String>) -> Unit,
) {
    val selections = remember(notice.decisionId) { mutableStateMapOf<String, Set<String>>() }
    val custom = remember(notice.decisionId) { mutableStateMapOf<String, String>() }
    val answers = notice.questions.associate { question ->
        val typed = custom[question.question].orEmpty().trim()
        question.question to if (typed.isNotEmpty()) typed
        else selections[question.question].orEmpty().joinToString(", ")
    }
    val complete = notice.questions.isNotEmpty() && answers.values.all { it.isNotBlank() }
    AiCard(shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.fillMaxWidth().padding(13.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                AiAgentBadge(notice.provider.orEmpty().ifBlank { "claude" }, size = 27.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(notice.terminalName, style = MaterialTheme.typography.titleSmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${providerLabel(notice.provider)} · 服务端任务",
                        style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                }
                if (answering) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
            if (notice.summary.isNotBlank()) {
                Text(notice.summary, style = MaterialTheme.typography.bodySmall,
                    color = TbColors.TextSoft, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            notice.questions.forEach { question ->
                ServerQuestionBlock(
                    question = question,
                    selected = selections[question.question].orEmpty(),
                    custom = custom[question.question].orEmpty(),
                    onSelect = { labels -> selections[question.question] = labels },
                    onCustom = { custom[question.question] = it },
                )
            }
            Button(
                onClick = { answer(notice, answers) },
                enabled = complete && !answering,
                modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp),
                shape = RoundedCornerShape(11.dp),
                colors = primaryButtonColors(), border = primaryControlBorder(),
            ) {
                Text("提交决策", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun ServerQuestionBlock(
    question: ServerDecisionQuestion,
    selected: Set<String>, custom: String,
    onSelect: (Set<String>) -> Unit, onCustom: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (question.header.isNotBlank()) {
            Text(question.header, style = MaterialTheme.typography.labelMedium,
                color = TbColors.Accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(question.question, style = MaterialTheme.typography.bodyMedium)
        question.options.forEach { option ->
            ServerOptionRow(
                option = option,
                selected = option.label in selected,
                multiSelect = question.multiSelect,
                onClick = {
                    onSelect(
                        if (!question.multiSelect) setOf(option.label)
                        else if (option.label in selected) selected - option.label
                        else selected + option.label,
                    )
                },
            )
        }
        OutlinedTextField(
            value = custom,
            onValueChange = onCustom,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("或输入自定义回答", style = MaterialTheme.typography.bodySmall) },
            textStyle = MaterialTheme.typography.bodySmall.copy(lineHeight = 17.sp),
            minLines = 1, maxLines = 4,
            shape = RoundedCornerShape(10.dp),
        )
    }
}

@Composable
private fun ServerOptionRow(
    option: ServerDecisionOption, selected: Boolean, multiSelect: Boolean, onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        color = if (selected) TbColors.Accent.copy(alpha = .12f) else TbColors.SurfaceHover,
        shape = RoundedCornerShape(9.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                if (selected) Icons.Outlined.CheckCircle
                else if (multiSelect) Icons.Outlined.CheckBoxOutlineBlank
                else Icons.Outlined.RadioButtonUnchecked,
                null, Modifier.size(17.dp),
                tint = if (selected) TbColors.Accent else TbColors.TextMuted,
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(option.label, style = MaterialTheme.typography.labelLarge,
                    color = if (selected) TbColors.Accent else TbColors.Text)
                option.description?.takeIf(String::isNotBlank)?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                }
            }
        }
    }
}

private fun providerLabel(provider: String?): String = when (provider) {
    "codex" -> "Codex"
    else -> "Claude Code"
}
