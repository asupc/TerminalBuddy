package com.terminalbuddy.android.ui

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.annotation.Keep
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleStartEffect
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.data.ApiJson
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.ByteArrayInputStream

@Composable
internal fun ServerTerminalScreen(ui: ServerTerminalUiState, vm: ServerTerminalViewModel) {
    val terminal = ui.selected ?: return
    val context = LocalContext.current
    val host = remember(ui.connection, terminal.id) { LocalTerminalView(context, vm) }
    var command by rememberSaveable(terminal.id) { mutableStateOf("") }
    var confirmClose by remember(terminal.id) { mutableStateOf(false) }
    val send = { if (ui.connected && !ui.closing) { vm.input(command + "\r"); command = "" } }
    BackHandler(onBack = vm::leaveTerminal)
    DisposableEffect(host) { onDispose { host.dispose() } }
    LifecycleStartEffect(host) {
        host.view.onResume()
        vm.setVisible(true)
        onStopOrDispose { vm.setVisible(false); host.view.onPause() }
    }
    Column(Modifier.fillMaxSize().imePadding().navigationBarsPadding()) {
        AiSubpageHeader(terminal.profileName, vm::leaveTerminal) {
            IconButton(host::copySelection) { Icon(Icons.Outlined.ContentCopy, "复制选中的终端内容") }
            IconButton({ confirmClose = true }, enabled = !ui.ended && !ui.closing) {
                Icon(Icons.Outlined.Close, "关闭服务端终端", tint = TbColors.Danger)
            }
        }
        Text(listOfNotNull(terminal.group.takeIf(String::isNotBlank), terminal.directory).joinToString(" · "),
            Modifier.fillMaxWidth().padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall,
            color = TbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(ui.status, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                color = if (ui.connected) TbColors.Accent else TbColors.TextMuted)
            if (!ui.connected) {
                TextButton(vm::refreshService, enabled = !ui.closing) { Text("刷新服务") }
                TextButton(vm::reconnect, enabled = !ui.ended && !ui.closing) { Text("重新连接") }
            }
        }
        ui.terminalError?.let {
            Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                style = MaterialTheme.typography.bodySmall, color = TbColors.Danger)
        }
        AndroidView(factory = { host.view }, modifier = Modifier.fillMaxWidth().weight(1f))
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton({ vm.input("\u0003") }, enabled = ui.connected && !ui.closing) { Text("Ctrl+C") }
            TextButton({ vm.input("\t") }, enabled = ui.connected && !ui.closing) { Text("Tab") }
            TextButton({ vm.input("\r") }, enabled = ui.connected && !ui.closing) { Text("回车") }
            Spacer(Modifier.weight(1f))
            IconButton(host::scrollToBottom) { Icon(Icons.Outlined.VerticalAlignBottom, "滚动到底部") }
        }
        Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 4.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(command, { command = it }, Modifier.weight(1f),
                placeholder = { Text("输入命令或回答") }, singleLine = true,
                enabled = ui.connected && !ui.closing, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }))
            TextButton(send, enabled = ui.connected && !ui.closing) { Text("发送") }
        }
    }
    if (confirmClose) AlertDialog(
        onDismissRequest = { confirmClose = false }, title = { Text("关闭服务端终端") },
        text = { Text("关闭「${terminal.profileName}」？仍在该终端内运行的命令可能被中断。返回页面会保留终端。") },
        confirmButton = { TextButton({ confirmClose = false; vm.closeTerminal() }) { Text("关闭终端", color = TbColors.Danger) } },
        dismissButton = { TextButton({ confirmClose = false }) { Text("取消") } },
    )
}

/** 仅提供本地渲染桥接，不向 JavaScript 暴露服务器地址或令牌。 */
@Keep
internal class TerminalJavascriptBridge(
    private val readyAction: () -> Unit,
    private val resizeAction: (Int, Int) -> Unit,
    private val inputAction: (String) -> Unit,
    private val errorAction: () -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    @JavascriptInterface fun ready() { main.post { readyAction() } }
    @JavascriptInterface fun resize(cols: Int, rows: Int) { main.post { resizeAction(cols, rows) } }
    @JavascriptInterface fun input(data: String) { main.post { inputAction(data) } }
    @JavascriptInterface fun error() { main.post { errorAction() } }
}

@SuppressLint("SetJavaScriptEnabled")
private class LocalTerminalView(context: Context, private val vm: ServerTerminalViewModel) {
    val view = WebView(context)
    private var disposed = false
    private var ready = false
    init {
        view.setBackgroundColor(AndroidColor.rgb(16, 20, 24))
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val name = uri.path?.removePrefix("/terminal/")
                val mime = when (name) {
                    "index.html" -> "text/html"
                    "terminal.js", "xterm.js", "fit.js" -> "application/javascript"
                    "xterm.css" -> "text/css"
                    else -> null
                }
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
                    uri.path?.startsWith("/terminal/") == true && mime != null) {
                    return WebResourceResponse(mime, "UTF-8", context.assets.open("terminal/$name"))
                }
                return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
        }
        view.addJavascriptInterface(TerminalJavascriptBridge(
            readyAction = {
                if (!disposed) {
                    ready = true
                    vm.attachRenderer { message ->
                        if (!disposed) view.evaluateJavascript("window.terminalHost.receive($message)", null)
                    }
                }
            },
            resizeAction = { cols, rows -> if (!disposed) vm.resize(cols, rows) },
            inputAction = { data -> if (!disposed) vm.input(data) },
            errorAction = { if (!disposed) vm.renderingFailed() },
        ), "AndroidTerminal")
        view.loadUrl("https://appassets.androidplatform.net/terminal/index.html")
    }
    fun scrollToBottom() {
        if (ready && !disposed) view.evaluateJavascript("window.terminalHost.scrollToBottom()", null)
    }
    fun copySelection() {
        if (!ready || disposed) return
        view.evaluateJavascript("window.terminalHost.selection()") { value ->
            val text = (runCatching { ApiJson.parseToJsonElement(value) }.getOrNull() as? JsonPrimitive)?.contentOrNull.orEmpty()
            if (text.isNotEmpty()) {
                val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("终端内容", text))
            }
        }
    }
    fun dispose() {
        disposed = true
        vm.detachRenderer()
        view.removeJavascriptInterface("AndroidTerminal")
        view.stopLoading()
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }
}
