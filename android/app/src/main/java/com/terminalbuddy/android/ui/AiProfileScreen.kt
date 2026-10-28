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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiUiState

/** 所有个人设置集中在这里，主题选择沿用 Activity 中的持久化状态。 */
@Composable
internal fun AiProfileScreen(
    ui: AiUiState, notifications: () -> Unit, sendMode: () -> Unit,
    accounts: () -> Unit, serviceInfo: () -> Unit, onlineUpdate: () -> Unit, logout: () -> Unit,
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
                    AiDivider(Modifier.padding(start = 60.dp, end = 16.dp))
                    AiSettingsRow(Icons.Outlined.SystemUpdate, "在线更新", "免登录连接更新服务，编译、下载并安装", click = onlineUpdate)
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
    val fixedMode = controls.skin.fixedDarkTheme
    val effectiveDarkTheme = controls.skin.isDark(controls.darkTheme)
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AiSmallIcon(Icons.Outlined.Contrast)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("外观", style = MaterialTheme.typography.titleSmall)
                Text(
                    if (fixedMode != null) "当前皮肤固定${if (fixedMode) "深色" else "浅色"}，切换其他皮肤后可调整"
                    else "切换浅色与深色模式",
                    style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted,
                )
            }
        }
        Row(Modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(false, true).forEach { dark ->
                val selected = effectiveDarkTheme == dark
                Surface(
                    modifier = Modifier.weight(1f).selectable(selected, enabled = fixedMode == null, role = Role.RadioButton,
                        onClick = { controls.onDarkThemeChange(dark) }),
                    color = if (selected) TbColors.ButtonBackground else TbColors.Canvas,
                    shape = RoundedCornerShape(14.dp),
                    border = if (selected && fixedMode != null) primaryControlBorder()
                        else BorderStroke(1.dp, if (selected) TbColors.Accent else TbColors.Border),
                ) {
                    Row(Modifier.heightIn(min = 52.dp).padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                        val ink = if (selected) TbColors.ButtonForeground else TbColors.TextSoft
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
    val largeFont = LocalDensity.current.fontScale >= 1.3f
    AiSheet("选择你的配色", dismiss) {
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f, fill = false)) {
            val columns = if (maxWidth < 360.dp || largeFont) 1 else 2
            val fixedSkins = AppSkin.entries.filter { it.fixedDarkTheme != null }
            val diffuseSkins = AppSkin.entries.filter { it.diffuseBackground }
            val classicSkins = AppSkin.entries.filter { it != AppSkin.Pine && !it.diffuseBackground && it.fixedDarkTheme == null }
            LazyColumn(
                Modifier.fillMaxWidth().selectableGroup(),
                contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "skin-hint") {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("当前使用 · ${controls.skin.title}", style = MaterialTheme.typography.titleSmall, color = TbColors.Text)
                        Text("${if (controls.skin.isDark(controls.darkTheme)) "深色" else "浅色"}模式 · 点击即刻应用，自动记住选择。",
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
                item(key = "fixed-heading") {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("纯色外观", style = MaterialTheme.typography.titleMedium)
                        Text("纯黑固定深色，纯白固定浅色，均采用黑色系按钮。",
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
                items(fixedSkins.chunked(columns), key = { "fixed-${it.first().id}" }) { skins ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        skins.forEach { skin ->
                            AiSkinChoice(skin, controls.darkTheme, controls.skin == skin,
                                select = { controls.onSkinChange(skin) }, modifier = Modifier.weight(1f))
                        }
                        if (skins.size < columns) Spacer(Modifier.weight(1f))
                    }
                }
                item(key = "default-skin") {
                    AiSkinChoice(AppSkin.Pine, controls.darkTheme, controls.skin == AppSkin.Pine,
                        select = { controls.onSkinChange(AppSkin.Pine) }, compact = true)
                }
                item(key = "diffuse-heading") {
                    Text("弥散灵感", style = MaterialTheme.typography.titleMedium)
                }
                items(diffuseSkins.chunked(columns), key = { "diffuse-${it.first().id}" }) { skins ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        skins.forEach { skin ->
                            AiSkinChoice(skin, controls.darkTheme, controls.skin == skin,
                                select = { controls.onSkinChange(skin) }, modifier = Modifier.weight(1f))
                        }
                        if (skins.size < columns) Spacer(Modifier.weight(1f))
                    }
                }
                item(key = "classic-heading") {
                    Text("经典配色", style = MaterialTheme.typography.titleMedium)
                }
                items(classicSkins.chunked(columns), key = { "classic-${it.first().id}" }) { skins ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        skins.forEach { skin ->
                            AiSkinChoice(skin, controls.darkTheme, controls.skin == skin,
                                select = { controls.onSkinChange(skin) }, modifier = Modifier.weight(1f))
                        }
                        if (skins.size < columns) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun AiSkinChoice(
    skin: AppSkin, darkTheme: Boolean, selected: Boolean, select: () -> Unit,
    modifier: Modifier = Modifier, compact: Boolean = false,
) {
    val colors = skin.colorScheme(darkTheme)
    Surface(
        modifier = modifier.fillMaxWidth().selectable(selected = selected, role = Role.RadioButton, onClick = select)
            .semantics(mergeDescendants = true) { stateDescription = if (selected) "正在使用" else "未选择" },
        color = colors.surface, shape = RoundedCornerShape(20.dp),
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) colors.primary else colors.outlineVariant),
    ) {
        if (compact) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AiSkinPreview(skin, darkTheme, Modifier.size(width = 84.dp, height = 76.dp))
                AiSkinLabel(skin, darkTheme, selected, Modifier.weight(1f))
            }
        } else {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                AiSkinPreview(skin, darkTheme, Modifier.fillMaxWidth().height(100.dp))
                AiSkinLabel(skin, darkTheme, selected)
            }
        }
    }
}

@Composable
private fun AiSkinLabel(skin: AppSkin, darkTheme: Boolean, selected: Boolean, modifier: Modifier = Modifier) {
    val colors = skin.colorScheme(darkTheme)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(skin.title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                color = colors.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (selected) Icon(Icons.Outlined.CheckCircle, null, Modifier.size(20.dp), tint = colors.primary)
            else Spacer(Modifier.size(20.dp))
        }
        Text(skin.description, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
            maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

/** 弥散缩略图沿用参考色组，深色模式降低亮度；图形仅作装饰。 */
@Composable
private fun AiSkinPreview(skin: AppSkin, darkTheme: Boolean, modifier: Modifier = Modifier) {
    val colors = skin.colorScheme(darkTheme)
    val previewColors = skin.previewColors.map { if (darkTheme) lerp(colors.background, it, .55f) else it }
    val swatches = skin.previewColors.ifEmpty { listOf(colors.primary, colors.secondaryContainer, colors.surfaceVariant) }
    Box(
        modifier.clearAndSetSemantics { }.clip(RoundedCornerShape(12.dp)).background(colors.background).drawWithCache {
            val gradient = previewColors.takeIf { it.size >= 2 }?.let { Brush.linearGradient(it.map { color -> color.copy(alpha = .65f) }) }
            val upperGlow = previewColors.firstOrNull()?.let { color ->
                Brush.radialGradient(
                    listOf(color.copy(alpha = .55f), Color.Transparent),
                    center = Offset(size.width * .12f, size.height * .1f), radius = size.maxDimension.coerceAtLeast(1f),
                )
            }
            val lowerGlow = previewColors.getOrNull(1)?.let { color ->
                Brush.radialGradient(
                    listOf(color.copy(alpha = .5f), Color.Transparent),
                    center = Offset(size.width * .58f, size.height * .95f), radius = size.maxDimension.coerceAtLeast(1f) * .85f,
                )
            }
            onDrawBehind {
                gradient?.let { drawRect(it) }
                upperGlow?.let { drawRect(it) }
                lowerGlow?.let { drawRect(it) }
            }
        },
    ) {
        Column(Modifier.fillMaxSize().padding(8.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val previewIcon = when (skin.fixedDarkTheme) {
                    true -> Icons.Outlined.DarkMode
                    false -> Icons.Outlined.LightMode
                    null -> Icons.Outlined.Palette
                }
                Icon(previewIcon, null, Modifier.size(14.dp), tint = colors.primary)
                Box(Modifier.width(28.dp).height(4.dp).background(colors.primary.copy(alpha = .5f), RoundedCornerShape(3.dp)))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Box(Modifier.size(width = 56.dp, height = 23.dp).background(colors.surface.copy(alpha = .72f), RoundedCornerShape(9.dp)),
                    contentAlignment = Alignment.Center) {
                    Box(Modifier.width(28.dp).height(4.dp).background(colors.primary.copy(alpha = .65f), RoundedCornerShape(3.dp)))
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                swatches.forEach { color ->
                    Surface(Modifier.size(14.dp), color = color, shape = CircleShape,
                        border = BorderStroke(1.dp, colors.surface.copy(alpha = .8f))) { }
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
internal fun appVersion(): String {
    val context = LocalContext.current
    return remember(context) {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }
            .getOrNull().orEmpty().ifBlank { "未知" }
    }
}
