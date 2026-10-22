package com.terminalbuddy.android.ui

import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import com.terminalbuddy.android.data.AiMessage
import com.terminalbuddy.android.data.AiSession
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first

/**
 * 逐字显示状态放在 LazyColumn 的 item 之外，滚动离开再回来不会重播动画。
 * 只有 assistant 的新增/增量文本做打字效果；用户消息、工具日志和替换内容直接展示服务端文本。
 */
@Stable
internal class AiAnimatedMessage(message: AiMessage, animate: Boolean) {
    val id = message.id
    val role = message.role
    var text by mutableStateOf(if (animate && role == "assistant") "" else message.text)
        private set
    private var targetText by mutableStateOf(message.text)
    var entered by mutableStateOf(!animate)
    val isRevealing get() = text.length < targetText.length

    fun update(message: AiMessage) {
        // 服务端替换整段文本或缩短回复时必须立即对齐，不能装作还在增长。
        if (role != "assistant" || !message.text.startsWith(text)) text = message.text
        targetText = message.text
    }

    fun revealNext() {
        if (!isRevealing) return
        // 每次追上剩余长度的 1/12：大块增量不会积压成很长的动画队列。
        val step = ((targetText.length - text.length) / 12).coerceAtLeast(1)
        var end = (text.length + step).coerceAtMost(targetText.length)
        // 不要在中途切开代理对，否则会短暂显示乱码方框。
        if (end < targetText.length && Character.isHighSurrogate(targetText[end - 1]) && Character.isLowSurrogate(targetText[end])) end++
        text = targetText.substring(0, end)
    }
}

@Stable
internal class AiConversationMotion {
    val messages = mutableStateListOf<AiAnimatedMessage>()
    var initialized by mutableStateOf(false)
        private set

    fun update(incoming: List<AiMessage>) {
        val previous = messages.associateBy { it.id }
        val next = incoming.map { message ->
            previous[message.id]?.also { it.update(message) } ?: AiAnimatedMessage(message, animate = initialized)
        }
        if (next != messages) {
            messages.clear()
            messages.addAll(next)
        }
        initialized = true
    }
}

@Composable
internal fun rememberAiConversationMotion(session: AiSession, loading: Boolean): AiConversationMotion {
    val motion = remember(session.id) { AiConversationMotion() }
    LaunchedEffect(motion, session.messages, loading) {
        if (!loading) motion.update(session.messages)
    }
    LaunchedEffect(motion) {
        snapshotFlow { motion.messages.any { it.isRevealing } }.collect { pending ->
            if (pending) {
                while (true) {
                    val revealing = motion.messages.filter { it.isRevealing }
                    if (revealing.isEmpty()) break
                    revealing.forEach { it.revealNext() }
                    delay(24)
                }
            }
        }
    }
    return motion
}

/** 跟随最新消息的滚动状态：用户手动上滑后停止跟随，点「回到最新」或发送后恢复。 */
@Stable
internal class AiConversationScroll(val list: LazyListState) {
    var following by mutableStateOf(true)
    var positioned by mutableStateOf(false)
    val gestures = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput && available.y != 0f) following = false
            return Offset.Zero
        }
    }
}

@Composable
internal fun rememberAiConversationScroll(sessionId: String, ready: Boolean, messageCount: Int): AiConversationScroll {
    val scroll = remember(sessionId) { AiConversationScroll(LazyListState()) }
    val list = scroll.list
    LaunchedEffect(scroll, ready) {
        if (ready && !scroll.positioned) {
            // 末尾还有一个「状态/锚点」item，所以等消息数 + 1 的条数就绪再定位。
            val count = snapshotFlow { list.layoutInfo.totalItemsCount }.first { it >= messageCount + 1 }
            // 打开历史只定位一次，直接的 scrollToItem 不会出现滚动动画。
            list.scrollToItem(count - 1)
            scroll.positioned = true
        }
    }
    LaunchedEffect(scroll) {
        snapshotFlow { list.isScrollInProgress }.collect { moving ->
            if (!moving && !list.canScrollForward) scroll.following = true
        }
    }
    LaunchedEffect(scroll) {
        snapshotFlow { scroll.positioned && scroll.following }.collectLatest { follow ->
            if (follow) {
                snapshotFlow { list.canScrollForward }.collect { canScroll ->
                    if (canScroll) {
                        // 每段短滚动完成后重新测量，流式 token 更新不会打断动画。
                        while (list.canScrollForward) {
                            val layout = list.layoutInfo
                            val lastIndex = layout.totalItemsCount - 1
                            val bottom = layout.visibleItemsInfo.lastOrNull()?.takeIf { it.index == lastIndex }
                            if (bottom == null) {
                                list.animateScrollToItem(lastIndex)
                            } else {
                                val distance = (bottom.offset + bottom.size + layout.afterContentPadding - layout.viewportEndOffset).coerceAtLeast(1)
                                list.animateScrollBy(distance.toFloat(), tween(220, easing = LinearOutSlowInEasing))
                            }
                            withFrameNanos { }
                        }
                    }
                }
            }
        }
    }
    return scroll
}
