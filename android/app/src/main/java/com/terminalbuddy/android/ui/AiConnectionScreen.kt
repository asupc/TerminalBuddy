package com.terminalbuddy.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.AiUiState

/** 登录表单保持单列布局，小屏和键盘展开时均可滚动。 */
@Composable
internal fun AiConnection(
    ui: AiUiState, login: (String, String, String, String) -> Unit, back: (() -> Unit)?,
    initialServer: String, initialUsername: String, title: String, adding: Boolean,
    initialName: String = "",
) {
    var server by rememberSaveable(initialServer, title) { mutableStateOf(initialServer) }
    var username by rememberSaveable(initialUsername, title) { mutableStateOf(initialUsername) }
    var name by rememberSaveable(initialName, title) { mutableStateOf(initialName) }
    var password by remember { mutableStateOf("") }
    var visible by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val canSubmit = server.isNotBlank() && username.isNotBlank() && password.isNotEmpty() && !ui.authenticating
    val submit: () -> Unit = {
        if (canSubmit) {
            keyboard?.hide()
            focus.clearFocus()
            login(server.trim(), username.trim(), password, name.trim())
        }
    }
    val next = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) })
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        if (back != null) AiSubpageHeader(title, back)
        else Spacer(Modifier.statusBarsPadding().height(16.dp))
        Column(
            Modifier.weight(1f).fillMaxWidth().imePadding().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Column(
                Modifier.widthIn(max = 480.dp).fillMaxWidth().padding(horizontal = 28.dp, vertical = 28.dp),
                verticalArrangement = Arrangement.spacedBy(28.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Surface(Modifier.size(52.dp), color = TbColors.Accent, shape = RoundedCornerShape(17.dp)) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Terminal, null, Modifier.size(27.dp), tint = TbColors.AccentInk)
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Terminal Buddy", style = MaterialTheme.typography.titleMedium)
                        Text("你的随身 AI 工作空间", style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (adding) "连接新的工作空间" else "欢迎回来", style = MaterialTheme.typography.headlineLarge)
                    Text("登录你的服务，继续 Claude 与 Codex 会话。",
                        style = MaterialTheme.typography.bodyMedium, color = TbColors.TextSoft)
                }
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    OutlinedTextField(
                        server, { server = it }, Modifier.fillMaxWidth(), label = { Text("服务地址") },
                        placeholder = { Text("http://192.168.1.10:9600") },
                        leadingIcon = { Icon(Icons.Outlined.Dns, null, Modifier.size(20.dp)) },
                        singleLine = true, enabled = !ui.authenticating, shape = RoundedCornerShape(14.dp),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                        keyboardActions = next, textStyle = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedTextField(
                        name, { name = it }, Modifier.fillMaxWidth(), label = { Text("名称（可选）") },
                        placeholder = { Text("例如：客厅 NAS") },
                        leadingIcon = { Icon(Icons.Outlined.Label, null, Modifier.size(20.dp)) },
                        singleLine = true, enabled = !ui.authenticating, shape = RoundedCornerShape(14.dp),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next), keyboardActions = next,
                        textStyle = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedTextField(
                        username, { username = it }, Modifier.fillMaxWidth(), label = { Text("账号") },
                        leadingIcon = { Icon(Icons.Outlined.PersonOutline, null, Modifier.size(20.dp)) },
                        singleLine = true, enabled = !ui.authenticating, shape = RoundedCornerShape(14.dp),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next), keyboardActions = next,
                        textStyle = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedTextField(
                        password, { password = it }, Modifier.fillMaxWidth(), label = { Text("密码") },
                        leadingIcon = { Icon(Icons.Outlined.Lock, null, Modifier.size(20.dp)) },
                        singleLine = true, enabled = !ui.authenticating, shape = RoundedCornerShape(14.dp),
                        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { submit() }),
                        textStyle = MaterialTheme.typography.bodyMedium,
                        trailingIcon = {
                            IconButton({ visible = !visible }, enabled = !ui.authenticating) {
                                Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                    if (visible) "隐藏密码" else "显示密码", Modifier.size(20.dp))
                            }
                        },
                    )
                    ui.error?.let { error ->
                        Surface(
                            color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        ) {
                            Text(error, Modifier.fillMaxWidth().padding(12.dp),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
                        }
                    }
                    Button(
                        submit, Modifier.fillMaxWidth().padding(top = 6.dp).heightIn(min = 56.dp),
                        enabled = canSubmit, shape = RoundedCornerShape(16.dp),
                        colors = primaryButtonColors(), border = primaryControlBorder(),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
                    ) {
                        if (ui.authenticating) {
                            CircularProgressIndicator(Modifier.size(18.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
                            Spacer(Modifier.width(10.dp))
                        }
                        Text(if (ui.authenticating) "正在连接…" else if (adding) "登录并添加账号" else "连接并登录")
                        if (!ui.authenticating) {
                            Spacer(Modifier.width(10.dp))
                            Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(18.dp))
                        }
                    }
                }
                Surface(color = TbColors.Surface, shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, TbColors.Border)) {
                    Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(Icons.Outlined.VerifiedUser, null, Modifier.padding(top = 2.dp).size(18.dp), tint = TbColors.TextMuted)
                        Text("密码不会保存在设备上，登录凭证由系统加密保护。",
                            style = MaterialTheme.typography.bodySmall, color = TbColors.TextMuted)
                    }
                }
            }
        }
    }
}
