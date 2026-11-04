package com.terminalbuddy.android.data

/**
 * 手机「开始对话」按所选 Agent / 供应商 / 模型组装终端启动命令。
 *
 * 终端由服务端创建（`POST /api/terminals`，空 profileId + startupCommand），
 * 这样手机打开的会话和电脑终端里打开的完全一致：同一个 PTY、同一份转录，
 * 电脑端立刻能在终端列表中看到并接力。模型由服务端引用标记展开：
 * `__TB_CLAUDE_REF__:<providerId>:<modelId>` / `__TB_CODEX_REF__:<providerId>:<modelId>`，
 * 与网页端模型启动使用同一套机制。
 */
internal object AgentLaunchCommand {
    const val DEFAULT_CLAUDE = "claude --dangerously-skip-permissions"
    const val DEFAULT_CODEX = "codex --dangerously-bypass-approvals-and-sandbox"

    private const val CLAUDE_REF_PREFIX = "__TB_CLAUDE_REF__:"
    private const val CODEX_REF_PREFIX = "__TB_CODEX_REF__:"

    /** Claude 引用会自带 `--model` / `--settings` / `--effort`，原命令中的同名参数必须剔除。 */
    private val CLAUDE_CONFLICT_ARGS = Regex(
        """(^|\s)--(model|settings|effort)(=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?""",
        RegexOption.IGNORE_CASE,
    )

    /** Codex 引用会自带供应商与模型配置，原命令里的同名参数必须剔除。 */
    private val CODEX_CONFLICT_ARGS = Regex(
        """(^|\s)(?:--(?:model|profile|config|local-provider|remote|remote-auth-token-env)|-[mpc])(?==|\s|$)(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?""",
        RegexOption.IGNORE_CASE,
    )
    private val CODEX_OSS_ARG = Regex("""(^|\s)--oss(?=$|\s)""", RegexOption.IGNORE_CASE)
    private val CLAUDE_HEAD = Regex(
        """(?:[\s"'=]|^)claude(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)""",
        RegexOption.IGNORE_CASE,
    )
    private val CODEX_HEAD = Regex(
        """(?:[\s"'=]|^)codex(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)""",
        RegexOption.IGNORE_CASE,
    )
    private val COMMAND_SEPARATOR = Regex("""&&|\|\||;|\|""")
    private val WHITESPACE = Regex("""\s+""")

    /**
     * 返回可直接作为空白终端 `startupCommand` 的命令。
     *
     * - 供应商为 `llm:<id>`（Claude）/ `codex:<id>` 且模型非空：生成引用命令；
     * - `default:*`、供应商为空或模型为空：使用 Agent 基础命令（服务端默认配置）；
     * - 其余形态（例如原生会话专用的 `claude:<id>`）同样回退基础命令，保证仍能启动终端，
     *   不会把无效引用发给服务端导致启动被拒。
     */
    fun build(agent: String, providerId: String, modelId: String, configuredBase: String?): String {
        val base = configuredBase?.trim()?.takeIf(String::isNotBlank)
            ?: if (agent == "codex") DEFAULT_CODEX else DEFAULT_CLAUDE
        return when (agent) {
            "codex" -> buildCodex(providerId, modelId, base)
            else -> buildClaude(providerId, modelId, base)
        }
    }

    private fun buildClaude(providerId: String, modelId: String, base: String): String {
        val id = providerId.removePrefix("llm:")
        if (!providerId.startsWith("llm:") || id.isBlank() || modelId.isBlank()) return base
        val inherited = inheritableArgs(base, CLAUDE_HEAD, CLAUDE_CONFLICT_ARGS)
        return listOf("$CLAUDE_REF_PREFIX$id:$modelId", inherited)
            .filter(String::isNotBlank)
            .joinToString(" ")
    }

    private fun buildCodex(providerId: String, modelId: String, base: String): String {
        val id = providerId.removePrefix("codex:")
        if (!providerId.startsWith("codex:") || id.isBlank() || modelId.isBlank()) return base
        val source = if (CODEX_HEAD.containsMatchIn(base)) base else DEFAULT_CODEX
        val inherited = inheritableArgs(source, CODEX_HEAD, CODEX_CONFLICT_ARGS)
            .replace(CODEX_OSS_ARG, " ")
            .replace(WHITESPACE, " ")
            .trim()
        return listOf("$CODEX_REF_PREFIX$id:$modelId", inherited)
            .filter(String::isNotBlank)
            .joinToString(" ")
    }

    /** 提取基础命令中该 Agent 的参数部分，并剔除引用自带参数；找不到命令头时返回空串。 */
    private fun inheritableArgs(command: String, head: Regex, conflict: Regex): String {
        val match = head.find(command) ?: return ""
        val rest = command.substring(match.range.last + 1)
        val args = rest.split(COMMAND_SEPARATOR, limit = 2).first().trim()
        return args.replace(conflict, " ").replace(WHITESPACE, " ").trim()
    }
}

/** `/api/runtime` 中与手机启动终端相关的字段。 */
@kotlinx.serialization.Serializable
internal data class AgentRuntimeInfo(
    val agentCommands: AgentCommandPair = AgentCommandPair(),
    val defaultTerminalType: String = "",
)

@kotlinx.serialization.Serializable
internal data class AgentCommandPair(
    val claude: String = "",
    val codex: String = "",
) {
    fun of(agent: String): String = if (agent == "codex") codex else claude
}
