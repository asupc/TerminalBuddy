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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.terminalbuddy.android.R

/**
 * Agent 标志，兼容 Agent 标识与展示名称。
 * Claude/Codex 是透明底单色标志，随主题正文颜色染色；
 * Pi 使用 pi.dev 官方三色几何标（橙/蓝/黄），必须保留原色，不能经 Icon 染色。
 */
@Composable
internal fun AiAgentLogo(agent: String, modifier: Modifier = Modifier, contentDescription: String? = null) {
    when (agent.lowercase()) {
        "codex" -> Icon(
            painterResource(R.drawable.ai_logo_codex), contentDescription, modifier.size(20.dp), tint = TbColors.Text,
        )
        "claude", "claude code" -> Icon(
            painterResource(R.drawable.ai_logo_claude), contentDescription, modifier.size(20.dp), tint = TbColors.Text,
        )
        "pi" -> Image(painterResource(R.drawable.ai_logo_pi), contentDescription, modifier.size(20.dp))
        else -> Icon(Icons.Outlined.AutoAwesome, contentDescription, modifier.size(20.dp), tint = TbColors.Text)
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
