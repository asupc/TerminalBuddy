package com.terminalbuddy.android.ui

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.mikepenz.markdown.model.State as MarkdownRenderState
import com.mikepenz.markdown.model.parseMarkdownFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.first

/** 一次完整解析的快照；解析失败时保留原文作为可选择、可复制的回退内容。 */
@Immutable
internal data class AiMarkdownSnapshot(val source: String, val parsed: MarkdownRenderState.Success?)

/** 缓存随消息对象存活，列表项离屏后再回来也不丢失已经解析的正文。 */
@Stable
internal class AiMarkdownState(
    private val parse: suspend (String) -> MarkdownRenderState = { source ->
        parseMarkdownFlow(source).first { it !is MarkdownRenderState.Loading }
    },
) {
    var snapshot: AiMarkdownSnapshot? by mutableStateOf(null)
        private set

    suspend fun update(source: String) {
        if (snapshot?.source == source) return
        val parsed = try {
            parse(source).also {
                if (it is MarkdownRenderState.Error && it.result is CancellationException) throw it.result
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        }
        currentCoroutineContext().ensureActive()
        // 只在新结果就绪时整体替换；解析期间不发布 Loading，不清空旧快照。
        snapshot = AiMarkdownSnapshot(source, parsed as? MarkdownRenderState.Success)
    }
}
