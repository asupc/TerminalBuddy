package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiUiState

/** 所有个人设置集中在这里，主题选择沿用 Activity 中的持久化状态。 */
@Composable
internal fun AiProfileScreen(
    ui: AiUiState, notifications: () -> Unit, sendMode: () -> Unit,
    accounts: () -> Unit, serviceInfo: () -> Unit, logout: () -> Unit,
) {
    var confirmLogout by remember(ui.activeAccountId) { mutableStateOf(false) }
    val enabled = !ui.working && !ui.authenticating
    val version = appVersion()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp)) {
        item(key = "identity") {
            AiCard(shape = RoundedCornerShape(24.dp)) {
                Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Surface(Modifier.size(58.dp), color = TbColors.Accent, shape = CircleShape) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(ui.username.take(1).uppercase().ifBlank { "我" }, style = MaterialTheme.typography.headlineSmall,
                                color = TbColors.AccentInk)
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(ui.username, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(ui.server, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("当前登录账号", style = MaterialTheme.typography.labelMedium, color = TbColors.TextSoft)
                    }
                }
            }
        }
        item(key = "preferences") {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AiSectionTitle("偏好设置")
                AiCard(shape = RoundedCornerShape(20.dp)) {
                    AiThemePreference()
                    AiDivider(Modifier.padding(horizontal = 16.dp))
                    AiSkinPreference()
                    AiDivider(Modifier.padding(start = 60.dp, end = 16.dp))
                    AiSettingsRow(Icons.Outlined.NotificationsNone, "通知", "任务进度、决策与完成提醒", click = notifications)
                    AiDivider(Modifier.padding(start = 60.dp, end = 16.dp))
                    AiSettingsRow(Icons.Outlined.Bolt, "发送方式",
                        if (ui.sendImmediate) "立即发送 · 优先处理新消息" else "排队发送 · 当前回复结束后继续", click = sendMode)
                }
            }
        }
        item(key = "accounts-service") {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AiSectionTitle("账号与服务")
                AiCard(shape = RoundedCornerShape(20.dp)) {
                    AiSettingsRow(Icons.Outlined.ManageAccounts, "账号切换", "${ui.accounts.size} 个已保存账号", enabled, accounts)
                    AiDivider(Modifier.padding(start = 60.dp, end = 16.dp))
                    AiSettingsRow(Icons.Outlined.Dns, "服务信息", "连接地址、服务状态与应用版本", enabled, serviceInfo)
                }
                AiNotificationPermission()
            }
        }
        item(key = "logout") {
            OutlinedButton({ confirmLogout = true }, Modifier.fillMaxWidth().heightIn(min = 52.dp),
                enabled = enabled, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, TbColors.Border),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = TbColors.TextSoft)) {
                Icon(Icons.AutoMirrored.Outlined.Logout, null, Modifier.size(19.dp))
                Spacer(Modifier.width(8.dp))
                Text("退出当前账号")
            }
        }
        item(key = "version") {
            Text("Terminal Buddy · 版本 $version", Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted, textAlign = TextAlign.Center)
        }
    }
    if (confirmLogout) AlertDialog(
        onDismissRequest = { confirmLogout = false }, title = { Text("退出当前账号？") },
        text = { Text("退出后可在账号列表重新登录，服务端会话和项目仍会保留。") },
        confirmButton = { TextButton({ confirmLogout = false; logout() }, enabled = enabled) { Text("退出登录", color = TbColors.Danger) } },
        dismissButton = { TextButton({ confirmLogout = false }) { Text("取消") } },
    )
}

@Composable
private fun AiThemePreference() {
    val controls = LocalThemeControls.current
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AiSmallIcon(Icons.Outlined.Contrast)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("外观", style = MaterialTheme.typography.titleSmall)
                Text("切换浅色与深色模式", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
        }
        Row(Modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(false, true).forEach { dark ->
                val selected = controls.darkTheme == dark
                Surface(
                    modifier = Modifier.weight(1f).selectable(selected, role = Role.RadioButton,
                        onClick = { controls.onDarkThemeChange(dark) }),
                    color = if (selected) TbColors.Accent else TbColors.Canvas,
                    shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, if (selected) TbColors.Accent else TbColors.Border),
                ) {
                    Row(Modifier.heightIn(min = 52.dp).padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                        val ink = if (selected) TbColors.AccentInk else TbColors.TextSoft
                        Icon(if (dark) Icons.Outlined.DarkMode else Icons.Outlined.LightMode, null, Modifier.size(20.dp), tint = ink)
                        Text(if (dark) "深色" else "浅色", style = MaterialTheme.typography.labelLarge, color = ink)
                        if (selected) Icon(Icons.Outlined.Check, "已选择", Modifier.size(17.dp), tint = ink)
                    }
                }
            }
        }
    }
}

/** 入口保持紧凑，完整配色预览放在可滚动的选择面板。 */
@Composable
private fun AiSkinPreference() {
    val controls = LocalThemeControls.current
    var selecting by rememberSaveable { mutableStateOf(false) }
    AiSettingsRow(Icons.Outlined.Palette, "皮肤选择", controls.skin.title, click = { selecting = true })
    if (selecting) AiSkinSelectionSheet { selecting = false }
}

@Composable
private fun AiSkinSelectionSheet(dismiss: () -> Unit) {
    val controls = LocalThemeControls.current
    AiSheet("选择皮肤", dismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f, fill = false).selectableGroup(),
            contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(key = "skin-hint") {
                Text("当前为${if (controls.darkTheme) "深色" else "浅色"}模式，点按皮肤即可立即应用并保存。",
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
            }
            items(AppSkin.entries.chunked(2), key = { it.first().id }) { skins ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    skins.forEach { skin ->
                        AiSkinChoice(skin, controls.darkTheme, controls.skin == skin,
                            select = { controls.onSkinChange(skin) }, modifier = Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun AiSkinChoice(
    skin: AppSkin, darkTheme: Boolean, selected: Boolean, select: () -> Unit, modifier: Modifier = Modifier,
) {
    val colors = skin.colorScheme(darkTheme)
    Surface(
        modifier = modifier.selectable(selected = selected, role = Role.RadioButton, onClick = select),
        color = colors.surface, shape = RoundedCornerShape(16.dp),
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) colors.primary else colors.outlineVariant),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            AiSkinPreview(colors)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(skin.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall,
                    color = colors.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (selected) Icon(Icons.Outlined.CheckCircle, null, Modifier.size(20.dp), tint = colors.primary)
                else Spacer(Modifier.size(20.dp))
            }
            Text(skin.description, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** 装饰性的缩略预览与真实页面使用同一份背景、卡片、字段和按钮色。 */
@Composable
private fun AiSkinPreview(colors: ColorScheme) {
    Column(
        Modifier.fillMaxWidth().height(76.dp).background(colors.background, RoundedCornerShape(12.dp)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(12.dp), tint = colors.primary)
            Box(Modifier.width(30.dp).height(3.dp).background(colors.onSurfaceVariant.copy(alpha = .5f), RoundedCornerShape(2.dp)))
        }
        Surface(Modifier.fillMaxWidth(), color = colors.surface, shape = RoundedCornerShape(8.dp)) {
            Column(Modifier.padding(7.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.fillMaxWidth(.65f).height(3.dp).background(colors.onSurfaceVariant.copy(alpha = .4f), RoundedCornerShape(2.dp)))
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.weight(1f).height(9.dp).background(colors.surfaceVariant, RoundedCornerShape(3.dp)))
                    Box(Modifier.width(25.dp).height(9.dp).background(colors.primary, RoundedCornerShape(3.dp)))
                }
            }
        }
    }
}

@Composable
private fun AiSettingsRow(icon: ImageVector, title: String, subtitle: String, enabled: Boolean = true, click: () -> Unit) {
    Surface(onClick = click, enabled = enabled, color = TbColors.Surface) {
        Row(Modifier.fillMaxWidth().heightIn(min = 80.dp).padding(horizontal = 16.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AiSmallIcon(icon)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = if (enabled) TbColors.Text else TbColors.TextMuted)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(20.dp), tint = TbColors.TextMuted)
        }
    }
}

/** 只展示已有连接与目录数据，不虚构服务端版本或网络延迟。 */
@Composable
internal fun AiServiceInfoScreen(ui: AiUiState, back: () -> Unit, connect: () -> Unit) {
    val version = appVersion()
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        AiSubpageHeader("服务信息", back)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(Modifier.widthIn(max = 680.dp).fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp)) {
                item(key = "connection") {
                    AiCard(shape = RoundedCornerShape(24.dp)) {
                        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                AiSmallIcon(Icons.Outlined.Dns)
                                Text("当前服务", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                                Text(if (ui.reconnecting) "重连中" else "已登录", style = MaterialTheme.typography.labelMedium, color = TbColors.TextSoft)
                            }
                            SelectionContainer {
                                Text(ui.server, style = MaterialTheme.typography.bodyLarge)
                            }
                            AiDivider()
                            AiInfoRow("登录账号", ui.username)
                            AiInfoRow("登录状态", if (ui.reconnecting) "正在重新连接服务" else "已登录当前服务")
                        }
                    }
                }
                item(key = "catalog") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        AiSectionTitle("工作空间")
                        AiCard(shape = RoundedCornerShape(20.dp)) {
                            Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                                AiInfoRow("已登记项目", "${ui.projects.size} 个")
                                AiInfoRow("模型供应商", "${ui.providers.size} 个")
                                AiInfoRow("可用模型", "${ui.providers.sumOf { it.models.size }} 个")
                                AiInfoRow("当前会话", "${ui.sessions.size} 段")
                            }
                        }
                        Text("项目与模型配置由服务端提供。", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
                item(key = "app") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        AiSectionTitle("应用信息")
                        AiCard(shape = RoundedCornerShape(20.dp)) {
                            Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                                AiInfoRow("应用名称", "Terminal Buddy")
                                AiInfoRow("当前版本", version)
                                AiInfoRow("凭证存储", "设备加密保存")
                            }
                        }
                    }
                }
                item(key = "reconnect") {
                    OutlinedButton(connect, Modifier.fillMaxWidth().heightIn(min = 52.dp),
                        enabled = !ui.working && !ui.authenticating, shape = RoundedCornerShape(16.dp)) {
                        Icon(Icons.Outlined.Login, null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("重新登录服务")
                    }
                }
            }
        }
    }
}

@Composable
private fun AiInfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
        Text(label, Modifier.width(88.dp), style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted)
        SelectionContainer(Modifier.weight(1f)) {
            Text(value, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End)
        }
    }
}

@Composable
private fun appVersion(): String {
    val context = LocalContext.current
    return remember(context) {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }
            .getOrNull().orEmpty().ifBlank { "未知" }
    }
}
