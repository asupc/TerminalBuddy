package com.terminalbuddy.android.ui

import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
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
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 缩略图下载共用一个连接池：每张图新建 OkHttpClient 会反复建线程与连接。 */
private val imageHttp = OkHttpClient()

/** 缩略图最大解码像素边长（足够覆盖 64dp~160dp @3x-4x 显示密度，避免 12MP 原图爆内存）。 */
private const val THUMB_MAX_DIM_PX = 512

private val thumbMemoryCache = object : LruCache<String, ImageBitmap>(48) {}

private fun thumbCacheKey(source: String): String {
    if (!source.startsWith("data:") && source.length <= 512) return source
    val digest = MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
}

private fun decodeSampledBitmap(bytes: ByteArray): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sampleSize = 1
    while (bounds.outWidth / sampleSize > THUMB_MAX_DIM_PX * 2 ||
        bounds.outHeight / sampleSize > THUMB_MAX_DIM_PX * 2
    ) {
        sampleSize *= 2
    }
    val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}

private suspend fun fetchImageBytes(url: String): ByteArray? = suspendCancellableCoroutine { cont ->
    val call = imageHttp.newCall(Request.Builder().url(url).build())
    cont.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }
        override fun onResponse(call: Call, response: Response) {
            response.use { res ->
                val body = if (res.isSuccessful) res.body?.bytes() else null
                if (cont.isActive) cont.resume(body)
            }
        }
    })
}

/**
 * 聊天图片缩略图：本地待发送图片是 `data:` URL，直接解码；
 * 服务端附件走带 JWT 的 `/api/desktop/file` 下载。
 */
@Composable
internal fun AiImageThumb(source: String, modifier: Modifier = Modifier) {
    val cacheKey = remember(source) { thumbCacheKey(source) }
    var bitmap by remember(cacheKey) { mutableStateOf(thumbMemoryCache.get(cacheKey)) }
    var failed by remember(cacheKey) { mutableStateOf(false) }
    LaunchedEffect(cacheKey) {
        if (thumbMemoryCache.get(cacheKey) != null) {
            bitmap = thumbMemoryCache.get(cacheKey)
            failed = false
            return@LaunchedEffect
        }
        val decoded = withContext(Dispatchers.IO) {
            runCatching {
                val bytes = if (source.startsWith("data:")) {
                    Base64.decode(source.substringAfter(','), Base64.DEFAULT)
                } else {
                    fetchImageBytes(source)
                }
                bytes?.let(::decodeSampledBitmap)
            }.getOrNull()
        }
        if (decoded != null) thumbMemoryCache.put(cacheKey, decoded)
        bitmap = decoded
        failed = decoded == null
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
