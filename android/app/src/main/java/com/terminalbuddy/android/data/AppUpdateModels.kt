package com.terminalbuddy.android.data

import kotlinx.serialization.json.*
import java.util.Locale

private fun JsonObject.buildFlag(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true

enum class BuildDownloadPhase { Idle, Downloading, Ready, Failed }

/** 安卓构建任务：字段与后端 android_build_task 表一一对应。 */
data class AndroidBuildTask(
    val id: Long, val type: String, val status: String, val stage: String,
    val commit: String, val commitSubject: String, val versionCode: Long?, val versionName: String,
    val artifactName: String, val apkSize: Long, val error: String,
    val requestedBy: String, val createdAt: String, val startedAt: String, val completedAt: String,
    val serverId: String = "local", val sha256: String = "",
) {
    val building get() = type == "BUILD"
    val active get() = status in setOf("QUEUED", "RUNNING", "CANCELLING")
    val downloadable get() = building && status == "SUCCESS" && artifactName.isNotBlank() && apkSize > 0
    val typeLabel get() = if (building) "编译 APK" else "更新代码"
    val statusLabel get() = when (status) {
        "QUEUED" -> "等待执行"
        "RUNNING" -> "执行中"
        "CANCELLING" -> "正在取消"
        "SUCCESS" -> "成功"
        "FAILED" -> "失败"
        "CANCELLED" -> "已取消"
        "TIMED_OUT" -> "超时"
        "INTERRUPTED" -> "意外中断"
        else -> status
    }
    val stageLabel get() = when (stage) {
        "QUEUED" -> "等待执行"
        "FETCHING" -> "更新源码"
        "PREPARING" -> "准备编译"
        "COMPILING" -> "正在编译"
        "VERIFYING" -> "校验安装包"
        "ARCHIVING" -> "归档安装包"
        "DONE" -> "完成"
        else -> stage.ifBlank { statusLabel }
    }
    /** 任务耗时：未结束的任务以当前时钟兜底。 */
    fun elapsedLabel(clock: Long): String {
        val start = parseLocalTime(startedAt.ifBlank { createdAt }) ?: return "—"
        val end = parseLocalTime(completedAt) ?: clock
        val seconds = (end - start).coerceAtLeast(0) / 1000
        return if (seconds < 60) "${seconds} 秒" else "${seconds / 60} 分 ${seconds % 60} 秒"
    }
    /** 开始时间：兼容 ISO-8601（带时区）和本地时间两种写法，统一显示为本地时间。 */
    val startedLabel: String get() = formatLocalTime(startedAt.ifBlank { createdAt })
    companion object {
        fun from(raw: JsonObject) = AndroidBuildTask(
            raw.number("id")?.toLong() ?: 0, raw.text("type", fallback = "UPDATE"),
            raw.text("status", fallback = "QUEUED"), raw.text("stage"),
            raw.text("commit"), raw.text("commitSubject"), raw.number("versionCode")?.toLong(), raw.text("versionName"),
            raw.text("artifactName"), raw.number("apkSize")?.toLong() ?: 0, raw.text("error"),
            raw.text("requestedBy"), raw.text("createdAt"), raw.text("startedAt"), raw.text("completedAt"),
            raw.text("serverId", fallback = "local"), raw.text("sha256"),
        )
    }
}

/** 源码快照：构建容器成功执行「更新代码」后写入 source.json。 */
data class AndroidSource(val commit: String = "", val commitSubject: String = "", val branch: String = "", val updatedAt: String = "") {
    companion object {
        fun from(raw: JsonObject) = AndroidSource(raw.text("commit"), raw.text("commitSubject"), raw.text("branch"), raw.text("updatedAt"))
    }
}

data class AndroidBuildServer(val id: String, val name: String, val online: Boolean) {
    companion object {
        fun from(raw: JsonObject) = AndroidBuildServer(raw.text("id"), raw.text("name"), raw.buildFlag("online"))
    }
}

data class AndroidBuildStatus(
    val enabled: Boolean = false, val workerOnline: Boolean = false, val signingReady: Boolean = false,
    val branch: String = "master", val source: AndroidSource = AndroidSource(),
    val activeTask: AndroidBuildTask? = null, val latestApk: AndroidBuildTask? = null,
    val servers: List<AndroidBuildServer> = emptyList(),
    val serverId: String = "local",
) {
    /** 编译任务会先更新源码，首次构建也可直接提交。 */
    val canBuild get() = enabled && workerOnline && activeTask == null && signingReady
    val canDownload get() = latestApk?.downloadable == true
    companion object {
        fun from(raw: JsonObject) = AndroidBuildStatus(
            raw.buildFlag("enabled"), raw.buildFlag("workerOnline"), raw.buildFlag("signingReady"),
            raw.text("branch", fallback = "master"), AndroidSource.from(raw["source"].asObject()),
            (raw["activeTask"] as? JsonObject)?.let(AndroidBuildTask::from),
            (raw["latestApk"] as? JsonObject)?.let(AndroidBuildTask::from),
            (raw["servers"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(AndroidBuildServer::from) } ?: emptyList(),
            raw.text("serverId", fallback = "local"),
        )
    }
}

/** 增量日志分片：cursor 是下一次请求的字节位置，reset 表示服务端已从头返回。 */
data class AndroidLogChunk(val task: AndroidBuildTask?, val text: String, val cursor: Long, val hasMore: Boolean, val reset: Boolean) {
    companion object {
        fun from(raw: JsonObject) = AndroidLogChunk(
            (raw["task"] as? JsonObject)?.let(AndroidBuildTask::from), raw.text("text"),
            raw.number("cursor")?.toLong() ?: 0, raw.buildFlag("hasMore"), raw.buildFlag("reset"),
        )
    }
}

data class AndroidBuildState(
    val serverId: String = "local",
    val status: AndroidBuildStatus = AndroidBuildStatus(),
    val tasks: List<AndroidBuildTask> = emptyList(), val loaded: Boolean = false,
    val selectedId: Long? = null, val logs: String = "", val cursor: Long = 0,
    val logComplete: Boolean = false, val follow: Boolean = true,
    val connectionError: Boolean = false, val error: String? = null, val download: AndroidDownload = AndroidDownload(),
) {
    val selectedTask: AndroidBuildTask? get() = selectedId?.let { id -> tasks.firstOrNull { it.id == id } }
}

/** 安装包下载状态：服务端只下发短时票据，App 用系统 DownloadManager 拉取。 */
data class AndroidDownload(
    val taskId: Long = 0, val phase: BuildDownloadPhase = BuildDownloadPhase.Idle, val logFile: Boolean = false,
    val filename: String = "", val received: Long = 0, val total: Long = 0,
    val message: String = "", val error: String? = null,
) {
    val active get() = phase == BuildDownloadPhase.Downloading
    val progress get() = if (total > 0) (received.toFloat() / total).coerceIn(0f, 1f) else null
}

fun formatBytes(value: Double?): String {
    if (value == null || !value.isFinite()) return "—"
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var size = value.coerceAtLeast(0.0); var index = 0
    while (size >= 1024 && index < units.lastIndex) { size /= 1024; index++ }
    return String.format(Locale.ROOT, if (index == 0) "%.0f %s" else "%.1f %s", size, units[index])
}


/** 解析后端时间：兼容 ISO-8601（带时区）和本地时间字符串，返回本地毫秒时间戳。 */
internal fun parseLocalTime(raw: String): Long? {
    if (raw.isBlank()) return null
    runCatching { return java.time.OffsetDateTime.parse(raw).toInstant().toEpochMilli() }
    runCatching { return java.time.LocalDateTime.parse(raw.replace(' ', 'T').take(19))
        .atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli() }
    return null
}
/** 把后端时间格式化为「yyyy-MM-dd HH:mm」。 */
internal fun formatLocalTime(raw: String): String {
    val millis = parseLocalTime(raw) ?: return raw.take(16).replace('T', ' ')
    return java.time.Instant.ofEpochMilli(millis).atZone(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))
}

