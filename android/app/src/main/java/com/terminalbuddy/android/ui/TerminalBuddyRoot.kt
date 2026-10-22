package com.terminalbuddy.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.IntOffset
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.terminalbuddy.android.AiViewModel

private enum class RootPage { Home, AiConversation }

/**
 * 根导航：首页始终在下层，二级会话页从右侧滑入。
 * Ai 会话页的转场与状态恢复方式移植自葫芦娃 Android `ui/HuluwaRoot.kt`。
 */
@Composable
fun TerminalBuddyRoot(aiVm: AiViewModel = viewModel()) {
    val aiUi by aiVm.state.collectAsStateWithLifecycle()
    val holder = rememberSaveableStateHolder()
    // 只有 Ai 页面可见时才保持实时连接；退到后台由 LifecycleStartEffect 释放。
    val aiActive = aiUi.authenticated
    LifecycleStartEffect(aiActive) {
        aiVm.setVisible(true)
        onStopOrDispose { aiVm.setVisible(false) }
    }
    BackHandler(aiActive && aiUi.selected != null) { aiVm.closeSession() }
    val page = if (aiActive && aiUi.selected != null) RootPage.AiConversation else RootPage.Home
    // 退场动画期间 closeSession() 已清空 selected，保留最后一次快照供正在滑出的页面绘制。
    val aiSnapshot = remember { mutableStateOf(aiUi) }
    SideEffect { if (aiUi.selected != null) aiSnapshot.value = aiUi }
    val pageAiUi = if (aiUi.selected != null) aiUi else aiSnapshot.value
    // 根节点统一铺底色：Compose 的 Column/Box 不会自动绘制 Material 背景，否则会露出窗口默认底色。
    Surface(Modifier.fillMaxSize(), color = TbColors.Canvas) {
        Box(Modifier.fillMaxSize()) {
            AnimatedContent(targetState = page, transitionSpec = { pageSlideTransition() }, label = "页面转场") { destination ->
                if (destination == RootPage.Home) {
                    Box(
                        Modifier.fillMaxSize()
                            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                    ) {
                        holder.SaveableStateProvider("ai-home") { AiScreen(aiUi, aiVm) }
                    }
                } else {
                    Box(Modifier.fillMaxSize()) {
                        holder.SaveableStateProvider("ai-session:${pageAiUi.selected?.id}") { AiConversationScreen(pageAiUi, aiVm) }
                    }
                }
            }
        }
    }
}

/**
 * 与桌面端网页一致的页面转场：前进时新页从右滑入、旧页向左让出 1/4 宽度；返回时反向。
 * 时长 320ms，缓动曲线取网页端的 cubic-bezier(.32,.72,0,1)。
 */
private fun AnimatedContentTransitionScope<RootPage>.pageSlideTransition(): ContentTransform {
    val forward = targetState != RootPage.Home
    val spec = tween<IntOffset>(durationMillis = 320, easing = CubicBezierEasing(.32f, .72f, 0f, 1f))
    val enter = slideInHorizontally(spec) { width -> if (forward) width else -width / 4 }
    val exit = slideOutHorizontally(spec) { width -> if (forward) -width / 4 else width }
    return enter togetherWith exit
}
