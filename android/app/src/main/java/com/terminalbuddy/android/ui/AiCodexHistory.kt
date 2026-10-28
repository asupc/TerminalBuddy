package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.AiViewModel
import com.terminalbuddy.android.data.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private fun historyTime(time: Long): String = if (time <= 0) "时间未知"
    else SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(Date(time))

@Composable
internal fun AiHistorySessionRow(session: AiHistorySession, open: () -> Unit) {
    Surface(onClick = open, color = TbColors.Surface) {
        Row(Modifier.fillMaxWidth().padding(vertical = 13.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            AiAgentBadge("codex")
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(session.customTitle?.takeIf(String::isNotBlank) ?: session.title,
                    style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(session.projectDir, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${historyTime(session.updatedAt)} · ${session.messageCount} 条记录",
                    style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted)
            }
            Icon(Icons.Outlined.ChevronRight, "查看历史会话", Modifier.size(19.dp), tint = TbColors.TextMuted)
        }
    }
    AiDivider(Modifier.padding(start = 40.dp))
}

/** 历史回放不占用原生会话 selected，继续时才建立同账号下的可发送会话。 */
@Composable
internal fun AiCodexHistoryScreen(ui: AiUiState, vm: AiViewModel) {
    val history = ui.history
    val source = history.selected ?: return
    val replay = history.replay
    val project = historyProject(ui.projects, replay?.projectDir ?: source.projectDir)
    val models = project?.let { ui.projectModels(it, "codex") }.orEmpty()
    var chosenModel by rememberSaveable(ui.activeAccountId, source.sessionId) { mutableStateOf("") }
    val target = models.find { it.key == chosenModel }
        ?: models.firstOrNull { it.model.id == (replay?.model ?: source.model) }
        ?: models.firstOrNull { it.provider.isDefault } ?: models.firstOrNull()
    BackHandler { vm.closeCodexHistory() }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(vm::closeCodexHistory, enabled = !ui.working) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回工作台")
            }
            Text("Codex 历史会话", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            IconButton({ vm.loadCodexReplay() }, enabled = !history.loadingReplay && !ui.working) {
                Icon(Icons.Outlined.Refresh, "刷新历史内容", Modifier.size(20.dp))
            }
        }
        ui.error?.let { AiError(it, vm::clearError) }
        AiDivider()
        LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item(key = "history-summary") {
                Text(replay?.title ?: source.title, style = MaterialTheme.typography.titleLarge)
                SelectionContainer {
                    Text(replay?.projectDir ?: source.projectDir, Modifier.padding(top = 7.dp),
                        style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                }
                Text("${replay?.model ?: source.model ?: "服务端默认模型"} · ${historyTime(replay?.updatedAt ?: source.updatedAt)}",
                    Modifier.padding(top = 5.dp), style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                replay?.let { Text("共 ${it.total} 条记录，已加载 ${it.messages.size} 条", Modifier.padding(top = 5.dp),
                    style = MaterialTheme.typography.labelMedium, color = TbColors.TextMuted) }
            }
            if (history.loadingReplay && replay == null) item(key = "history-loading") {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
            items(replay?.messages.orEmpty(), key = { "replay-${source.sessionId}-${it.seq}" }) { message ->
                AiHistoryMessageBlock(source.sessionId, message)
            }
            if (replay != null && replay.messages.isEmpty() && !history.loadingReplay) item(key = "history-empty") {
                Text("该会话暂时没有可回放的消息。", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
            history.replayError?.let { error -> item(key = "history-error") {
                Column {
                    Text(error, style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
                    TextButton({ vm.loadCodexReplay(more = replay != null) }, enabled = !history.loadingReplay) { Text("重新加载") }
                }
            } }
            if (replay != null && replay.messages.size.toLong() < replay.total) item(key = "history-next") {
                OutlinedButton({ vm.loadCodexReplay(more = true) }, Modifier.fillMaxWidth(), enabled = !history.loadingReplay) {
                    if (history.loadingReplay) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(7.dp))
                    }
                    Text(if (history.loadingReplay) "正在加载…" else "加载更多记录")
                }
            }
        }
        Surface(color = TbColors.Surface) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 12.dp, bottom = 14.dp),
                verticalArrangement = Arrangement.spacedBy(9.dp)) {
                val unavailable = when {
                    project == null -> "该历史项目尚未在服务端登记，可查看记录，登记后才能继续对话。"
                    !project.enabledAgents.codex -> "该项目尚未启用 Codex，请先在服务端启用。"
                    models.isEmpty() -> "服务端暂无可用 Codex 模型，请配置后刷新工作台。"
                    else -> null
                }
                if (unavailable != null) Text(unavailable, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                else AiChoiceField("继续对话使用的模型", Icons.Outlined.Tune, target?.key.orEmpty(), "选择模型",
                    modelChoices(models), !ui.working, { chosenModel = it })
                Button({ target?.let { vm.resumeCodexHistory(it.key) } }, Modifier.fillMaxWidth(),
                    enabled = target != null && replay != null && !ui.working && !history.loadingReplay) {
                    if (ui.working) CircularProgressIndicator(Modifier.size(16.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
                    else Icon(Icons.Outlined.ChatBubbleOutline, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(7.dp)); Text(if (ui.working) "正在恢复…" else "继续此 Codex 对话")
                }
            }
        }
    }
}

@Composable
private fun AiHistoryMessageBlock(sessionId: String, message: AiHistoryMessage) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        val label = when (message.role) { "user" -> "你"; "tool" -> message.toolName ?: "工具记录"; else -> "Codex" }
        Text(label, style = MaterialTheme.typography.labelLarge,
            color = if (message.role == "user") TbColors.Accent else TbColors.TextMuted)
        if (message.text.isNotBlank()) {
            if (message.role == "assistant") {
                val animated = remember(sessionId, message.seq, message.text) {
                    AiAnimatedMessage(AiMessage("history-$sessionId-${message.seq}", "assistant", message.text, message.timestamp ?: 0), animate = false)
                }
                AiMarkdownContent(animated, MaterialTheme.typography.bodyMedium, Modifier.fillMaxWidth())
            } else SelectionContainer {
                Text(message.text, style = MaterialTheme.typography.bodyMedium,
                    fontFamily = if (message.role == "tool") FontFamily.Monospace else FontFamily.Default)
            }
        }
        message.tools.forEach { tool ->
            SelectionContainer {
                Text(listOf(tool.name, tool.summary).filter(String::isNotBlank).joinToString("\n"),
                    style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = TbColors.TextMuted)
            }
        }
        AiDivider(Modifier.padding(top = 5.dp))
    }
}
