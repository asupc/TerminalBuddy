package com.terminalbuddy.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 圆角方块图标，与桌面端侧栏和网页端列表的图标容器保持一致。 */
@Composable
fun RoundIcon(icon: ImageVector, color: Color = MaterialTheme.colorScheme.primary, modifier: Modifier = Modifier) {
    Box(
        modifier.size(44.dp).background(color.copy(alpha = .12f), RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(24.dp), tint = color)
    }
}

/** 页面标题栏：左对齐大标题，可带右侧操作。 */
@Composable
fun PageHeader(title: String, action: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding()
            .heightIn(min = 64.dp).padding(start = 22.dp, end = 16.dp, top = 15.dp, bottom = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title, Modifier.weight(1f), color = MaterialTheme.colorScheme.onBackground,
            fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.Bold, maxLines = 1,
        )
        action()
    }
}

/** 顶部错误条：可关闭，颜色跟随主题的错误色。 */
@Composable
fun ErrorBar(message: String, dismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.error.copy(alpha = .10f)).padding(start = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message, Modifier.weight(1f).padding(vertical = 8.dp),
            color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
        )
        IconButton(dismiss) {
            Icon(Icons.Outlined.Close, "关闭提示", tint = MaterialTheme.colorScheme.error)
        }
    }
}

/**
 * 界面里反复出现的「小标题 + 说明」区块。
 * 单独抽出来是为了让首页各卡片的间距、字号保持一致。
 */
@Composable
fun SectionCaption(title: String, caption: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        caption?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
