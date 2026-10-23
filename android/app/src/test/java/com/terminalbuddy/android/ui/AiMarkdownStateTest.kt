package com.terminalbuddy.android.ui

import com.mikepenz.markdown.model.State as MarkdownRenderState
import com.mikepenz.markdown.model.parseMarkdownFlow
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.intellij.markdown.IElementType
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMElementTypes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AiMarkdownStateTest {
    @Test
    fun headings_emphasis_lists_code_and_tables_are_parsed() = runBlocking {
        val source = """
            ## 新闻标题

            **重点**、*强调*和~~过时内容~~。

            - 第一条
            - 第二条

            > 一段引用

            ~~~kotlin
            val answer = 42
            ~~~

            | 项目 | 数值 |
            | --- | ---: |
            | 输入 | 100 |
        """.trimIndent()
        val state = AiMarkdownState()
        state.update(source)
        val parsed = requireNotNull(state.snapshot?.parsed)
        assertEquals(source, parsed.content)
        listOf(
            MarkdownElementTypes.ATX_2, MarkdownElementTypes.STRONG, MarkdownElementTypes.EMPH,
            GFMElementTypes.STRIKETHROUGH, MarkdownElementTypes.UNORDERED_LIST,
            MarkdownElementTypes.BLOCK_QUOTE, MarkdownElementTypes.CODE_FENCE, GFMElementTypes.TABLE,
        ).forEach { type -> assertTrue("缺少语法节点：$type", parsed.node.containsType(type)) }
    }

    @Test
    fun repeated_content_reuses_the_message_cache() = runBlocking {
        var calls = 0
        val state = AiMarkdownState { source ->
            calls++
            parsedState(source)
        }
        state.update("**同一条正文**")
        val previous = state.snapshot
        state.update("**同一条正文**")
        assertSame(previous, state.snapshot)
        assertEquals(1, calls)
    }

    @Test
    fun previous_result_remains_visible_until_the_next_result_is_ready() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val state = AiMarkdownState { source ->
            if (source == "## 新内容") {
                entered.complete(Unit)
                release.await()
            }
            parsedState(source)
        }
        state.update("旧内容")
        val previous = state.snapshot
        val updating = launch { state.update("## 新内容") }
        entered.await()
        assertSame(previous, state.snapshot)
        release.complete(Unit)
        updating.join()
        assertEquals("## 新内容", state.snapshot?.source)
        assertNotNull(state.snapshot?.parsed)
    }

    @Test
    fun incomplete_streaming_code_fence_is_renderable_and_can_finish() = runBlocking {
        val state = AiMarkdownState()
        state.update("~~~kotlin\nval value = 1")
        assertTrue(requireNotNull(state.snapshot?.parsed).node.containsType(MarkdownElementTypes.CODE_FENCE))
        val completed = "~~~kotlin\nval value = 1\n~~~\n\n**完成**"
        state.update(completed)
        val parsed = requireNotNull(state.snapshot?.parsed)
        assertEquals(completed, parsed.content)
        assertTrue(parsed.node.containsType(MarkdownElementTypes.STRONG))
    }

    @Test
    fun parser_error_uses_the_current_source_as_fallback() = runBlocking {
        val state = AiMarkdownState { MarkdownRenderState.Error(IllegalArgumentException("解析失败")) }
        state.update("需要保留的原文")
        assertEquals("需要保留的原文", state.snapshot?.source)
        assertNull(state.snapshot?.parsed)
    }

    @Test
    fun parser_exception_also_uses_the_current_source_as_fallback() = runBlocking {
        val state = AiMarkdownState { throw IllegalArgumentException("解析异常") }
        state.update("异常时的原文")
        assertEquals("异常时的原文", state.snapshot?.source)
        assertNull(state.snapshot?.parsed)
    }

    @Test
    fun cancelling_an_update_preserves_the_previous_result() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val state = AiMarkdownState { source ->
            if (source == "取消的更新") {
                entered.complete(Unit)
                awaitCancellation()
            }
            parsedState(source)
        }
        state.update("已有结果")
        val previous = state.snapshot
        val updating = launch { state.update("取消的更新") }
        entered.await()
        updating.cancelAndJoin()
        assertSame(previous, state.snapshot)
    }

    @Test
    fun web_links_support_http_https_and_reject_incomplete_destinations() {
        assertTrue(isAiMarkdownWebLink("https://example.com/path?q=1"))
        assertTrue(isAiMarkdownWebLink("HTTP://example.com"))
        assertFalse(isAiMarkdownWebLink("https://"))
        assertFalse(isAiMarkdownWebLink("javascript:alert(1)"))
        assertFalse(isAiMarkdownWebLink("file:///data/local/tmp"))
        assertFalse(isAiMarkdownWebLink("/relative/path"))
    }

    private suspend fun parsedState(source: String): MarkdownRenderState =
        parseMarkdownFlow(source).first { it !is MarkdownRenderState.Loading }

    private fun ASTNode.containsType(type: IElementType): Boolean =
        this.type == type || children.any { it.containsType(type) }
}
