package com.terminalbuddy.android.ui

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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.R

/** 透明底单色标志，随主题正文颜色切换，兼容 Agent 标识与展示名称。 */
@Composable
internal fun AiAgentLogo(agent: String, modifier: Modifier = Modifier, contentDescription: String? = null) {
    val resource = when (agent.lowercase()) {
        "codex" -> R.drawable.ai_logo_codex
        "claude", "claude code" -> R.drawable.ai_logo_claude
        "pi" -> R.drawable.ai_logo_pi
        else -> null
    }
    if (resource != null) {
        Icon(painterResource(resource), contentDescription, modifier.size(20.dp), tint = TbColors.Text)
    } else {
        Icon(Icons.Outlined.AutoAwesome, contentDescription, modifier.size(20.dp), tint = TbColors.Text)
    }
}

/** 首页对话列表与空对话提示共用的 30dp 标志容器。 */
@Composable
internal fun AiAgentBadge(agent: String, modifier: Modifier = Modifier) {
    Box(
        modifier.background(TbColors.SurfaceHover, RoundedCornerShape(9.dp)).size(30.dp),
        contentAlignment = Alignment.Center,
    ) {
        AiAgentLogo(agent)
    }
}
