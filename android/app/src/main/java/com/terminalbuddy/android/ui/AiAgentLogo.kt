package com.terminalbuddy.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.R

/**
 * Agent 标志，兼容 Agent 标识与展示名称。
 * Claude/Codex 是透明底单色标志，随主题正文颜色染色；
 */
@Composable
internal fun AiAgentLogo(
    agent: String, modifier: Modifier = Modifier, contentDescription: String? = null, tint: Color = TbColors.Text,
) {
    when (agent.lowercase()) {
        "codex" -> Icon(
            painterResource(R.drawable.ai_logo_codex), contentDescription, modifier.size(20.dp), tint = tint,
        )
        "claude", "claude code" -> Icon(
            painterResource(R.drawable.ai_logo_claude), contentDescription, modifier.size(20.dp), tint = tint,
        )
        else -> Icon(Icons.Outlined.AutoAwesome, contentDescription, modifier.size(20.dp), tint = tint)
    }
}

/** 首页对话列表与空对话提示共用的 30dp 标志容器。 */
@Composable
internal fun AiAgentBadge(agent: String, modifier: Modifier = Modifier, size: Dp = 30.dp) {
    Box(
        modifier.background(TbColors.SurfaceHover, RoundedCornerShape(size * .3f)).size(size),
        contentAlignment = Alignment.Center,
    ) {
        AiAgentLogo(agent, Modifier.size(size * .67f))
    }
}
