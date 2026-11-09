package com.terminalbuddy.android.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** 缩略图下载共用一个连接池：每张图新建 OkHttpClient 会反复建线程与连接。 */
private val imageHttp = OkHttpClient()

/**
 * 聊天图片缩略图：本地待发送图片是 `data:` URL，直接解码；
 * 服务端附件走带 JWT 的 `/api/desktop/file` 下载。
 */
@Composable
internal fun AiImageThumb(source: String, modifier: Modifier = Modifier) {
    var bitmap by remember(source) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(source) { mutableStateOf(false) }
    LaunchedEffect(source) {
        bitmap = withContext(Dispatchers.IO) {
            runCatching {
                val bytes = if (source.startsWith("data:")) {
                    Base64.decode(source.substringAfter(','), Base64.DEFAULT)
                } else {
                    imageHttp.newCall(Request.Builder().url(source).build()).execute().use { response ->
                        if (response.isSuccessful) response.body?.bytes() else null
                    }
                }
                bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
            }.getOrNull()
        }
        failed = bitmap == null
    }
    val current = bitmap
    if (current != null) {
        Image(
            current, contentDescription = null, modifier = modifier.clip(RoundedCornerShape(7.dp)),
            contentScale = ContentScale.Crop,
        )
    } else {
        Box(
            modifier.background(TbColors.CanvasSoft, RoundedCornerShape(7.dp)).clip(RoundedCornerShape(7.dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (failed) {
                Icon(Icons.Outlined.BrokenImage, "图片加载失败", Modifier.size(18.dp), tint = TbColors.TextMuted)
            } else {
                CircularProgressIndicator(Modifier.size(16.dp), color = TbColors.TextMuted, strokeWidth = 1.5.dp)
            }
        }
    }
}
