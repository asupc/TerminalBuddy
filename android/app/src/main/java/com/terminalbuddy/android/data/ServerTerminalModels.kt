package com.terminalbuddy.android.data

import kotlinx.serialization.Serializable

/** 只解码列表展示所需字段；启动时始终由服务端按 ID 读取完整配置。 */
@Serializable
data class ServerProfile(
    val id: String, val name: String, val group: String = "", val terminalType: String = "",
    val startupPath: String = "", val startupCommands: List<String> = emptyList(),
) {
    val projectName get() = group.trim().ifEmpty { "默认" }
    val canLaunch get() = terminalType in setOf("bash", "sh", "zsh", "cmd", "powershell", "pwsh", "ssh", "docker", "k8s")
    val unavailableReason get() = when (terminalType) {
        "mstsc" -> "远程桌面配置暂不支持在手机终端执行"
        "editor" -> "编辑器配置暂不支持在手机终端打开"
        else -> "暂不支持此配置类型"
    }
}

@Serializable
data class ServerTerminal(
    val id: String, val profileId: String = "", val profileName: String = "终端",
    val group: String = "", val terminalType: String = "", val owner: String = "",
    val directory: String? = null,
)

@Serializable
data class ServerTerminalFrame(val data: String, val cols: Int = 80, val rows: Int = 24)

data class ServerTerminalCatalog(
    val projects: List<AiProject>, val profiles: List<ServerProfile>, val terminals: List<ServerTerminal>,
)
