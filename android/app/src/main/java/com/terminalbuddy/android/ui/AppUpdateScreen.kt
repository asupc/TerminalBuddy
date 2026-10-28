package com.terminalbuddy.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.terminalbuddy.android.AppUpdateUiState
import com.terminalbuddy.android.AppUpdateViewModel
import com.terminalbuddy.android.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** 仅用服务地址连接独立更新接口，保留原生主题和完整构建工作台。 */
@Composable
internal fun AppUpdateScreen(back: () -> Unit, vm: AppUpdateViewModel = viewModel()) {
    val ui by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val version = appVersion()
    val owner = LocalLifecycleOwner.current
    var history by rememberSaveable { mutableStateOf(false) }
    var details by rememberSaveable { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf<AndroidBuildTask?>(null) }
    var continueInstallation by rememberSaveable { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (vm.canInstallPackages()) continueInstallation = true
        else vm.installationError("尚未允许安装应用。授权后点击「安装」即可。")
    }
    LaunchedEffect(continueInstallation) {
        if (!continueInstallation) return@LaunchedEffect
        try { context.startActivity(vm.installerIntent()) }
        catch (error: Exception) { vm.installationError(error.message ?: "无法打开系统安装器，请稍后重试") }
        finally { continueInstallation = false }
    }
    fun install() {
        if (vm.canInstallPackages()) continueInstallation = true
        else runCatching {
            permission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
        }.onFailure { vm.installationError("无法打开授权页面，请在系统设置中允许 TerminalBuddy 安装应用") }
    }
    // 仅页面可见时轮询。构建由服务器执行，离开页面不会取消；下载交给系统后台继续。
    LaunchedEffect(vm, owner) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                vm.refresh()
                vm.pollDownload()
                val current = vm.state.value.build
                delay(if (current.status.activeTask != null || !current.logComplete && current.selectedId != null || current.download.active) 1000 else 5000)
            }
        }
    }
    Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
        AiSubpageHeader("在线更新", back) {
            if (!ui.editing) {
                IconButton({ history = true }, enabled = ui.build.tasks.isNotEmpty()) { Icon(Icons.Outlined.History, "构建历史") }
                IconButton({ details = true }) { Icon(Icons.Outlined.Info, "构建详情") }
                IconButton(vm::editConnection, enabled = !ui.working) { Icon(Icons.Outlined.Dns, "更换服务地址") }
            }
        }
        ui.error?.let { AiError(it, vm::clearError) }
        if (ui.editing) {
            BuildConnection(ui, vm)
        } else {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                val controlsMaxHeight = maxHeight * .55f
                if (maxWidth >= 600.dp && maxHeight < 520.dp) {
                    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        BuildControls(ui, vm, { cancelling = it }, Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()))
                        BuildOutput(ui, vm, ::install, { history = true }, Modifier.weight(1f).fillMaxHeight())
                    }
                } else {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        BuildControls(ui, vm, { cancelling = it }, Modifier.heightIn(max = controlsMaxHeight)
                            .verticalScroll(rememberScrollState()))
                        BuildOutput(ui, vm, ::install, { history = true }, Modifier.weight(1f).fillMaxWidth())
                    }
                }
            }
        }
    }
    if (history && !ui.editing) AlertDialog(
        onDismissRequest = { history = false }, title = { Text("构建历史") },
        text = {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(ui.build.tasks, key = { it.id }) { task ->
                    Surface(onClick = { vm.selectTask(task.id); history = false },
                        color = if (task.id == ui.build.selectedId) TbColors.SurfaceHover else TbColors.Surface,
                        shape = RoundedCornerShape(12.dp)) {
                        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("#${task.id} · ${task.typeLabel} · ${task.statusLabel}", style = MaterialTheme.typography.titleSmall)
                            Text("${task.versionName.ifBlank { "未分配版本" }} · ${task.startedLabel}",
                                style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                            Text(task.commitSubject.ifBlank { task.stageLabel }, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }, confirmButton = { TextButton({ history = false }) { Text("关闭") } },
    )
    if (details && !ui.editing) AlertDialog(
        onDismissRequest = { details = false }, title = { Text("构建详情") },
        text = { SelectionContainer {
            val status = ui.build.status
            Text(buildString {
                appendLine("当前应用：$version")
                appendLine("服务地址：${ui.server}")
                appendLine("节点：${status.servers.firstOrNull { it.id == status.serverId }?.name.orEmpty()}")
                appendLine("分支：${status.branch}")
                appendLine("源码提交：${status.source.commit.ifBlank { "尚未更新" }}")
                appendLine(status.source.commitSubject)
                appendLine("Release 签名：${if (status.signingReady) "已配置" else "未配置"}")
                status.latestApk?.let { appendLine("最新安装包：${it.versionName}（${it.versionCode}）") }
                ui.build.selectedTask?.let {
                    appendLine("\n当前任务：#${it.id} · ${it.statusLabel}")
                    appendLine("提交：${it.commit}")
                    appendLine("发起人：${it.requestedBy}")
                    if (it.error.isNotBlank()) appendLine("错误：${it.error}")
                }
            }, Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()))
        } }, confirmButton = { TextButton({ details = false }) { Text("关闭") } },
    )
    cancelling?.let { task -> AlertDialog(
        onDismissRequest = { cancelling = null }, title = { Text("取消构建任务？") },
        text = { Text("将停止任务 #${task.id}，未完成的安装包会被清理。") },
        confirmButton = { TextButton({ cancelling = null; vm.cancelTask(task.id) }) { Text("取消任务", color = TbColors.Danger) } },
        dismissButton = { TextButton({ cancelling = null }) { Text("继续构建") } },
    ) }
}

@Composable
private fun BuildConnection(ui: AppUpdateUiState, vm: AppUpdateViewModel) {
    var server by rememberSaveable(ui.server) { mutableStateOf(ui.server) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("连接打包服务", style = MaterialTheme.typography.headlineSmall)
        Text("输入 TerminalBuddy 更新服务地址，即可编译、下载和安装最新版本，无需账号和密码。",
            style = MaterialTheme.typography.bodyMedium, color = TbColors.TextMuted)
        OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), enabled = !ui.working,
            label = { Text("服务地址") }, placeholder = { Text("http://taihe.678120.cn:8086") },
            supportingText = { Text("支持服务地址或完整的独立更新接口地址") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true)
        Button({ vm.connect(server) }, Modifier.fillMaxWidth().heightIn(min = 48.dp),
            enabled = !ui.working && server.isNotBlank(), shape = RoundedCornerShape(14.dp)) {
            if (ui.working) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                Spacer(Modifier.width(8.dp))
            }
            Text(if (ui.working) "正在连接…" else "连接并进入")
        }
        if (vm.canKeepConnection) TextButton(vm::keepConnection, Modifier.fillMaxWidth(), enabled = !ui.working) { Text("返回当前打包服务") }
    }
}

@Composable
private fun BuildControls(ui: AppUpdateUiState, vm: AppUpdateViewModel, cancel: (AndroidBuildTask) -> Unit, modifier: Modifier = Modifier) {
    val build = ui.build
    val status = build.status
    var expanded by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.fillMaxWidth()) {
            OutlinedButton({ expanded = true }, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !ui.working && status.servers.isNotEmpty(),
                shape = RoundedCornerShape(14.dp)) {
                Icon(Icons.Outlined.Dns, null, Modifier.size(18.dp))
                Text(status.servers.firstOrNull { it.id == build.serverId }?.name ?: "正在获取构建节点…",
                    Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (status.workerOnline) "在线" else "离线", style = MaterialTheme.typography.labelSmall)
                Icon(Icons.Outlined.ExpandMore, null)
            }
            DropdownMenu(expanded, { expanded = false }) {
                status.servers.forEach { node ->
                    DropdownMenuItem(text = { Text("${node.name} · ${if (node.online) "在线" else "离线"}") },
                        leadingIcon = { if (node.id == build.serverId) Icon(Icons.Outlined.Check, null) },
                        onClick = { expanded = false; vm.selectServer(node.id) })
                }
            }
        }
        AiCard(shape = RoundedCornerShape(16.dp)) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("当前源码", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                    Text(status.source.commit.take(8).ifBlank { "尚未更新" }, fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.titleMedium, maxLines = 1)
                    Text(if (status.signingReady) "Release 签名已配置" else "签名未配置", style = MaterialTheme.typography.labelSmall,
                        color = TbColors.TextMuted)
                }
                VerticalDivider(Modifier.height(48.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("最新安装包", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                    Text(status.latestApk?.let { "v${it.versionName}" } ?: "暂无安装包", style = MaterialTheme.typography.titleMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(status.latestApk?.let { formatBytes(it.apkSize.toDouble()) } ?: "当前 v${appVersion()}",
                        style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                }
                IconButton({ status.latestApk?.let { vm.download(it) } },
                    enabled = status.canDownload && !build.download.active && !ui.working) { Icon(Icons.Outlined.Download, "下载最新 APK") }
            }
        }
        Button(vm::build, Modifier.fillMaxWidth().heightIn(min = 48.dp),
            enabled = status.canBuild && build.loaded && !build.connectionError && !ui.working, shape = RoundedCornerShape(14.dp)) {
            if (ui.working) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            else Icon(Icons.Outlined.Build, null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("编译 APK")
        }
        val notice = when {
            build.error != null -> "${build.error} · 正在重连，服务端任务继续执行"
            !build.loaded -> "正在获取构建状态…"
            !status.enabled -> "构建服务未启用"
            !status.workerOnline -> "节点离线，已生成的安装包仍可下载"
            !status.signingReady -> "请在构建节点配置原 Release 签名"
            status.activeTask == null -> "编译时自动更新源码，成功后可下载安装"
            else -> ""
        }
        if (notice.isNotBlank()) Text(notice, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
        status.activeTask?.let { task ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                    Text(task.stageLabel, style = MaterialTheme.typography.labelLarge)
                    Text("#${task.id} · ${task.elapsedLabel(ui.clock)}", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                }
                if (task.canCancel) TextButton({ cancel(task) }, enabled = !ui.working && task.status != "CANCELLING") {
                    Text(if (task.status == "CANCELLING") "正在取消" else "取消任务", color = TbColors.Danger)
                } else Text("其他设备发起", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
            }
        }
    }
}

@Composable
private fun BuildOutput(ui: AppUpdateUiState, vm: AppUpdateViewModel, install: () -> Unit, history: () -> Unit, modifier: Modifier = Modifier) {
    val build = ui.build
    val task = build.selectedTask
    val context = LocalContext.current
    val scroll = rememberScrollState()
    var menu by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    LaunchedEffect(build.selectedId, build.logs.length, build.follow, scroll.maxValue) {
        if (build.follow && build.logs.isNotEmpty()) scroll.scrollTo(scroll.maxValue)
    }
    AiCard(modifier, shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("执行日志", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                task?.let { Text("#${it.id} · ${it.statusLabel}", style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted) }
                Box {
                    IconButton({ menu = true }) { Icon(Icons.Outlined.MoreHoriz, "日志操作") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("构建历史") }, onClick = { menu = false; history() })
                        DropdownMenuItem(text = { Text(if (build.follow) "暂停自动滚动" else "开启自动滚动") },
                            onClick = { menu = false; vm.toggleFollow() })
                        DropdownMenuItem(text = { Text("复制日志") }, enabled = build.logs.isNotBlank(), onClick = {
                            menu = false
                            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("构建日志", build.logs))
                            scope.launch { snackbar.showSnackbar("日志已复制") }
                        })
                        DropdownMenuItem(text = { Text("下载完整日志") }, enabled = task != null && !build.download.active && !ui.working,
                            onClick = { menu = false; task?.let { vm.download(it, true) } })
                        DropdownMenuItem(text = { Text("下载此任务 APK") }, enabled = task?.downloadable == true && !build.download.active && !ui.working,
                            onClick = { menu = false; task?.let { vm.download(it) } })
                    }
                }
            }
            if (build.download.phase != BuildDownloadPhase.Idle) BuildDownloadStrip(build.download, ui.working, vm, install)
            task?.error?.takeIf(String::isNotBlank)?.let {
                SelectionContainer { Text(it, Modifier.heightIn(max = 72.dp).verticalScroll(rememberScrollState()).padding(bottom = 8.dp),
                    style = MaterialTheme.typography.bodySmall, color = TbColors.Danger) }
            }
            Box(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(TbColors.Canvas)) {
                if (build.logs.isBlank()) Text(if (task == null) "开始构建后，日志将在这里显示" else "等待任务输出日志…",
                    Modifier.align(Alignment.Center).padding(12.dp), color = TbColors.TextMuted, style = MaterialTheme.typography.bodySmall)
                else SelectionContainer(Modifier.fillMaxSize()) {
                    Text(build.logs, Modifier.fillMaxSize().verticalScroll(scroll).padding(12.dp),
                        fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 18.sp)
                }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(when {
                    build.connectionError -> "正在重连"
                    task == null -> "等待任务"
                    !build.follow -> "已暂停自动滚动"
                    build.logComplete -> "日志已全部加载"
                    else -> "实时更新 · 自动跟随"
                }, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
                task?.let { Text(it.elapsedLabel(ui.clock), style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted) }
            }
            SnackbarHost(snackbar)
        }
    }
}

@Composable
private fun BuildDownloadStrip(download: AndroidDownload, busy: Boolean, vm: AppUpdateViewModel, install: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(download.error ?: download.message, style = MaterialTheme.typography.labelMedium,
                    color = if (download.error != null) TbColors.Danger else TbColors.TextSoft)
                Text(download.filename, style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (download.active) Text("${formatBytes(download.received.toDouble())} / ${formatBytes(download.total.takeIf { it > 0 }?.toDouble())}",
                    style = MaterialTheme.typography.labelSmall, color = TbColors.TextMuted)
            }
            if (download.phase == BuildDownloadPhase.Ready && !download.logFile) TextButton(install, enabled = !busy) { Text("安装") }
            TextButton(vm::cancelDownload, enabled = !busy) { Text(if (download.active) "取消下载" else "清除") }
        }
        if (download.active) {
            val progress = download.progress
            if (progress == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            else LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
        }
    }
}
