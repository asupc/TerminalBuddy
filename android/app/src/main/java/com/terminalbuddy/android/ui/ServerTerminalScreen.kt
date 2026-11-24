package com.terminalbuddy.android.ui

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.annotation.Keep
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleStartEffect
import com.terminalbuddy.android.ServerTerminalUiState
import com.terminalbuddy.android.ServerTerminalViewModel
import com.terminalbuddy.android.data.ApiJson
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.ByteArrayInputStream

@Composable
internal fun ServerTerminalScreen(ui: ServerTerminalUiState, vm: ServerTerminalViewModel) {
    val terminal = ui.selected ?: return
    val context = LocalContext.current
    val host = remember(ui.connection, terminal.id) { LocalTerminalView(context, vm) }
    var confirmClose by remember(terminal.id) { mutableStateOf(false) }
    val textMode = !ui.rendererReady || ui.renderingError != null
    BackHandler(onBack = vm::leaveTerminal)
    Column(Modifier.fillMaxSize().imePadding().navigationBarsPadding()) {
        AiSubpageHeader(terminal.profileName, vm::leaveTerminal) {
            IconButton({ if (textMode) host.copyText(ui.outputLog) else host.copySelection() }) {
                Icon(Icons.Outlined.ContentCopy, if (textMode) "复制文本日志" else "复制选中的终端内容")
            }
            IconButton({ confirmClose = true }, enabled = !ui.ended && !ui.closing) {
                Icon(Icons.Outlined.Close, "关闭服务端终端", tint = TbColors.Danger)
            }
        }
        ServerTerminalContent(ui, vm, host)
    }
    if (confirmClose) AlertDialog(
        onDismissRequest = { confirmClose = false }, title = { Text("关闭服务端终端") },
        text = { Text("关闭「${terminal.profileName}」？仍在该终端内运行的命令可能被中断。返回页面会保留终端。") },
        confirmButton = { TextButton({ confirmClose = false; vm.closeTerminal() }) { Text("关闭终端", color = TbColors.Danger) } },
        dismissButton = { TextButton({ confirmClose = false }) { Text("取消") } },
    )
}

/**
 * 不含头栏的终端内容区（渲染视图 + 快捷键行 + 输入行）。
 * 终端 Agent 会话页的「终端」页签复用同一内容，避免双顶栏；头栏与关闭按钮由调用方按场景提供。
 */
@Composable
internal fun ServerTerminalContent(
    ui: ServerTerminalUiState,
    vm: ServerTerminalViewModel,
    host: LocalTerminalView,
    modifier: Modifier = Modifier,
) {
    var command by rememberSaveable(ui.selected?.id.orEmpty()) { mutableStateOf("") }
    val textMode = !ui.rendererReady || ui.renderingError != null
    var followLogs by remember(ui.selected?.id.orEmpty()) { mutableStateOf(true) }
    val logScroll = rememberScrollState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(logScroll) {
        snapshotFlow { Triple(logScroll.isScrollInProgress, logScroll.value, logScroll.maxValue) }
            .collect { (scrolling, position, maximum) ->
                if (scrolling) followLogs = position >= maximum - 24
            }
    }
    LaunchedEffect(ui.outputLog, textMode, logScroll.maxValue) {
        if (textMode && followLogs && !logScroll.isScrollInProgress) {
            withFrameNanos { }
            logScroll.scrollTo(logScroll.maxValue)
        }
    }
    val send = { if (ui.connected && !ui.closing) { vm.input(command + "\r"); command = "" } }
    DisposableEffect(host) { onDispose { host.dispose() } }
    LifecycleStartEffect(host) {
        host.view.onResume()
        vm.setVisible(true)
        onStopOrDispose { vm.setVisible(false); host.view.onPause() }
    }
    Column(modifier) {
        Box(Modifier.fillMaxWidth().weight(1f)) {
            key(host) {
                AndroidView(factory = { host.view }, modifier = Modifier.matchParentSize())
            }
            if (textMode) Surface(Modifier.matchParentSize(), color = TbColors.Canvas) {
                SelectionContainer {
                    Box(Modifier.fillMaxSize().verticalScroll(logScroll).horizontalScroll(rememberScrollState()).padding(12.dp)) {
                        Text(ui.outputLog.ifEmpty { "等待服务端输出…" }, fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall, color = TbColors.Text)
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton({ vm.input("\u0003") }, enabled = ui.connected && !ui.closing) { Text("Ctrl+C") }
            TextButton({ vm.input("\t") }, enabled = ui.connected && !ui.closing) { Text("Tab") }
            TextButton({ vm.input("\r") }, enabled = ui.connected && !ui.closing) { Text("回车") }
            Spacer(Modifier.weight(1f))
            IconButton({
                if (textMode) {
                    followLogs = true
                    scope.launch { logScroll.scrollTo(logScroll.maxValue) }
                } else host.scrollToBottom()
            }) { Icon(Icons.Outlined.VerticalAlignBottom, "滚动到底部") }
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
internal class LocalTerminalView(context: Context, private val vm: ServerTerminalViewModel) {
    val view = WebView(context)
    private var disposed = false
    private var ready = false
    private var failed = false
    private val main = Handler(Looper.getMainLooper())
    private val readyTimeout = Runnable { fail() }

    private fun fail() {
        if (disposed || failed) return
        failed = true
        ready = false
        main.removeCallbacks(readyTimeout)
        vm.renderingFailed()
    }
    init {
        view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.setBackgroundColor(AndroidColor.rgb(16, 20, 24))
        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                if (consoleMessage.messageLevel() == ConsoleMessage.MessageLevel.ERROR) main.post { fail() }
                return true
            }
        }
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { fail() }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                // 图标等非必要请求不能使已经正常显示的终端失效。
                if (request.isForMainFrame || request.url.lastPathSegment in setOf("compat.js", "terminal.js", "xterm.js", "xterm.css")) fail()
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val name = uri.path?.removePrefix("/terminal/")
                val mime = when (name) {
                    "index.html" -> "text/html"
                    "compat.js", "terminal.js", "xterm.js" -> "application/javascript"
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
                if (!disposed && !failed) {
                    ready = true
                    main.removeCallbacks(readyTimeout)
                    vm.attachRenderer { message ->
                        if (!disposed && ready) view.evaluateJavascript("window.terminalHost.receive($message)", null)
                    }
                }
            },
            resizeAction = { cols, rows -> if (!disposed) vm.resize(cols, rows) },
            inputAction = { data -> if (!disposed) vm.input(data) },
            errorAction = { fail() },
        ), "AndroidTerminal")
        main.postDelayed(readyTimeout, 10_000)
        view.loadUrl("https://appassets.androidplatform.net/terminal/index.html")
    }
    fun scrollToBottom() {
        if (ready && !disposed) view.evaluateJavascript("window.terminalHost.scrollToBottom()", null)
    }
    fun copySelection() {
        if (!ready || disposed) return
        view.evaluateJavascript("window.terminalHost.selection()") { value ->
            val text = (runCatching { ApiJson.parseToJsonElement(value) }.getOrNull() as? JsonPrimitive)?.contentOrNull.orEmpty()
            copyText(text)
        }
    }
    fun copyText(text: String) {
        if (text.isEmpty()) return
        val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("终端内容", text))
    }
    fun dispose() {
        disposed = true
        main.removeCallbacks(readyTimeout)
        vm.detachRenderer()
        view.removeJavascriptInterface("AndroidTerminal")
        view.stopLoading()
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }
}
