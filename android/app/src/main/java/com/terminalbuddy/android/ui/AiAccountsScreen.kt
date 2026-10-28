package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiUiState
import com.terminalbuddy.android.data.AiAccount

/** 本机保存的 AI 服务账号；切换与删除都以服务地址和用户名标识身份。 */
@Composable internal fun AiAccountsScreen(
    ui: AiUiState, back: (() -> Unit)?, add: () -> Unit, select: (AiAccount) -> Unit,
    remove: (String) -> Unit, clearError: () -> Unit,
) {
    var deleting by remember { mutableStateOf<AiAccount?>(null) }
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        if (back != null) {
            AiSubpageHeader("账号切换", back) {
                TextButton(add, enabled = !ui.authenticating) {
                    Icon(Icons.Outlined.Add, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("添加账号")
                }
            }
        } else {
            PageHeader("选择账号", subtitle = "连接你保存的工作空间") {
                IconButton(add, enabled = !ui.authenticating) { Icon(Icons.Outlined.Add, "添加账号", Modifier.size(24.dp)) }
            }
        }
        ui.error?.let { AiError(it, clearError) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Text("添加多个 TerminalBuddy 账号，点击即可切换。", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
            if (ui.accounts.isEmpty()) item {
                AiCard {
                    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        AiSmallIcon(Icons.Outlined.ManageAccounts)
                        Text("还没有保存的账号", style = MaterialTheme.typography.titleSmall)
                        Button(add, enabled = !ui.authenticating, shape = RoundedCornerShape(10.dp)) { Text("添加账号") }
                    }
                }
            }
            items(ui.accounts, key = { it.id }) { account ->
                val current = account.id == ui.activeAccountId
                val switching = account.id == ui.switchingAccountId
                Surface(onClick = { if (!current) select(account) }, enabled = !ui.authenticating,
                    color = if (current) TbColors.Accent.copy(alpha = .12f) else TbColors.Surface, shape = RoundedCornerShape(20.dp),
                    border = BorderStroke(1.dp, if (current) TbColors.Accent.copy(alpha = .25f) else TbColors.Border)) {
                    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 16.dp, bottom = 16.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AiSmallIcon(Icons.Outlined.PersonOutline)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(account.username, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(account.server, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                            Text(when {
                                current -> "当前账号"
                                switching -> "正在切换…"
                                !account.loggedIn -> "需要重新登录"
                                else -> "已登录 · 点击切换"
                            }, style = MaterialTheme.typography.labelSmall,
                                color = if (!account.loggedIn) TbColors.Danger else TbColors.Accent)
                        }
                        when {
                            switching -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            current -> Icon(Icons.Outlined.CheckCircle, "当前账号", Modifier.size(20.dp), tint = TbColors.Accent)
                            !account.loggedIn -> TextButton({ select(account) }, enabled = !ui.authenticating,
                                contentPadding = PaddingValues(horizontal = 8.dp)) { Text("登录") }
                            else -> Icon(Icons.Outlined.SwapHoriz, "切换账号", Modifier.size(20.dp), tint = TbColors.TextMuted)
                        }
                        IconButton({ deleting = account }, enabled = !ui.authenticating) {
                            Icon(Icons.Outlined.DeleteOutline, "删除账号 ${account.username}", Modifier.size(20.dp), tint = TbColors.TextMuted)
                        }
                    }
                }
            }
        }
    }
    deleting?.let { account ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除账号") },
            text = { Text("从此设备移除「${account.username}」和保存的登录信息？${if (account.id == ui.activeAccountId) "删除后将退出当前账号。" else ""}\n${account.server}\n服务端账号及对话不会删除。") },
            confirmButton = { TextButton({ deleting = null; remove(account.id) }, enabled = !ui.authenticating) {
                Text("删除", color = TbColors.Danger)
            } }, dismissButton = { TextButton({ deleting = null }) { Text("取消") } })
    }
}
