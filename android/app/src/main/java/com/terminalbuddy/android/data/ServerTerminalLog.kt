package com.terminalbuddy.android.data

/** 保留可读输出，不执行终端控制序列；解析状态跨输出分片保留。 */
internal class ServerTerminalLog {
    private val text = StringBuilder()
    private var state = State.Text
    private var carriageReturn = false

    fun clear() {
        text.clear()
        state = State.Text
        carriageReturn = false
    }

    fun append(data: String) {
        data.forEach { char ->
            when (state) {
                State.Text -> when (char) {
                    '\u001b' -> state = State.Escape
                    '\u009b' -> state = State.Csi
                    '\u0090', '\u009d', '\u009e', '\u009f' -> state = State.ControlString
                    '\r' -> carriageReturn = true
                    '\b' -> if (text.isNotEmpty() && text.last() != '\n') text.deleteCharAt(text.lastIndex)
                    else -> if (char == '\n' || char == '\t' || (char >= ' ' && char !in '\u007f'..'\u009f')) {
                        // 进度条的 CR 更新单独保留成行；CRLF 仍然只产生一个换行。
                        if (carriageReturn && char != '\n' && text.isNotEmpty() && text.last() != '\n') text.append('\n')
                        carriageReturn = false
                        text.append(char)
                    }
                }
                State.Escape -> when (char) {
                    '[' -> state = State.Csi
                    ']', 'P', 'X', '^', '_' -> state = State.ControlString
                    else -> if (char !in ' '..'/') state = State.Text
                }
                State.Csi -> when {
                    char == '\u001b' -> state = State.Escape
                    char in '@'..'~' -> state = State.Text
                }
                State.ControlString -> when (char) {
                    '\u0007', '\u009c' -> state = State.Text
                    '\u001b' -> state = State.StringEscape
                }
                State.StringEscape -> state = when (char) {
                    '\\', '\u0007', '\u009c' -> State.Text
                    '\u001b' -> State.StringEscape
                    else -> State.ControlString
                }
            }
        }
        if (text.length > MAX_CHARACTERS) {
            val excess = text.length - MAX_CHARACTERS
            val newline = text.indexOf("\n", excess)
            var end = if (newline >= 0 && newline < text.lastIndex) newline + 1 else excess
            if (end < text.length && text[end].isLowSurrogate()) end++
            text.delete(0, end)
        }
    }

    fun snapshot(): String = text.toString()

    private enum class State { Text, Escape, Csi, ControlString, StringEscape }
    private companion object { const val MAX_CHARACTERS = 256 * 1024 }
}
