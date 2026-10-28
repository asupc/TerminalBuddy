package com.terminalbuddy.android.data

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/** 系统后台下载；保存下载记录，应用重启后仍可继续查看进度和安装。 */
class AppUpdateDownloader(private val context: Context, private val repository: AppUpdateRepository) {
    private val manager = context.getSystemService(DownloadManager::class.java)
    private val preferences = context.getSharedPreferences("terminal_buddy_build_download", Context.MODE_PRIVATE)
    private val operations = Mutex()
    private var downloadId = preferences.getLong("id", -1)
    private var filename = preferences.getString("filename", "").orEmpty()
    private var logFile = preferences.getBoolean("logFile", false)
    private var sha256 = preferences.getString("sha256", "").orEmpty()
    private val mutable = MutableStateFlow(if (downloadId > 0 && safeFilename(filename)) AndroidDownload(
        taskId = preferences.getLong("taskId", 0), phase = BuildDownloadPhase.Downloading, logFile = logFile,
        filename = filename, total = preferences.getLong("total", 0), message = "正在恢复下载状态…",
    ) else AndroidDownload())
    val state = mutable.asStateFlow()

    suspend fun download(task: AndroidBuildTask, logs: Boolean = false) = withContext(Dispatchers.IO) {
        operations.withLock {
            if (mutable.value.active) return@withLock
            val ticket = repository.ticket(task.id, logs)
            val path = ticket.text("path")
            // 只接受当前服务下的短时票据地址，下载不会向其他主机发送凭据。
            require(Regex("^/api/public/android-downloads/[A-Za-z0-9_-]+$").matches(path)) { "下载地址无效，请重新下载" }
            val name = ticket.text("filename").ifBlank {
                if (logs) "terminalbuddy-task-${task.id}.log" else "terminalbuddy-${task.id}.apk"
            }
            require(safeFilename(name)) { "服务返回的文件名无效" }
            removeDownload()
            mutable.value = AndroidDownload()
            filename = name
            logFile = logs
            sha256 = if (logs) "" else task.sha256
            val target = targetFile()
            check(target.parentFile?.isDirectory == true || target.parentFile?.mkdirs() == true) { "无法创建下载目录，请检查手机存储空间" }
            if (target.exists()) check(target.delete()) { "无法清理旧文件，请稍后重试" }
            val url = ServerAddress.endpoint(repository.store.server, path.removePrefix("/api/").split('/'))
            val request = DownloadManager.Request(Uri.parse(url.toString()))
                .setTitle(if (logs) "TerminalBuddy 构建日志" else "TerminalBuddy 安装包")
                .setDescription("任务 #${task.id} · $name")
                .setMimeType(if (logs) "text/plain" else "application/vnd.android.package-archive")
                .setAllowedOverMetered(true).setAllowedOverRoaming(false)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, relativePath())
            downloadId = manager.enqueue(request)
            preferences.edit().putLong("id", downloadId).putString("filename", filename).putBoolean("logFile", logs)
                .putLong("taskId", task.id).putLong("total", if (logs) 0 else task.apkSize).putString("sha256", sha256).apply()
            mutable.value = AndroidDownload(taskId = task.id, phase = BuildDownloadPhase.Downloading, logFile = logs,
                filename = name, total = if (logs) 0 else task.apkSize, message = if (logs) "正在下载构建日志…" else "正在下载安装包…")
        }
    }

    suspend fun poll() = withContext(Dispatchers.IO) {
        operations.withLock {
            if (downloadId <= 0 || !mutable.value.active) return@withLock
            try {
                manager.query(DownloadManager.Query().setFilterById(downloadId)).use { cursor ->
                    check(cursor != null && cursor.moveToFirst()) { "系统下载记录已移除，请重新下载" }
                    val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                        .takeIf { it > 0 } ?: mutable.value.total
                    when (status) {
                        DownloadManager.STATUS_SUCCESSFUL -> {
                            if (!logFile) validateApk(targetFile())
                            mutable.update { it.copy(phase = BuildDownloadPhase.Ready, received = received, total = total,
                                message = if (logFile) "构建日志已下载" else "安装包已下载，可以安装", error = null) }
                        }
                        DownloadManager.STATUS_FAILED -> {
                            val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                            error(when (reason) {
                                DownloadManager.ERROR_INSUFFICIENT_SPACE -> "手机存储空间不足，请清理后重试"
                                401, 403, 404 -> "下载链接已失效，请重新下载"
                                else -> "下载失败，请检查网络后重试（$reason）"
                            })
                        }
                        else -> mutable.update { it.copy(received = received, total = total, message = when (status) {
                            DownloadManager.STATUS_PAUSED -> "网络中断，等待系统重试"
                            DownloadManager.STATUS_PENDING -> "等待开始下载"
                            else -> "正在下载…"
                        }) }
                    }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Throwable) { mutable.update { it.copy(phase = BuildDownloadPhase.Failed, error = error.userMessage()) } }
        }
    }

    suspend fun cancel() = withContext(Dispatchers.IO) {
        operations.withLock { removeDownload(); mutable.value = AndroidDownload() }
    }

    fun installIntent(): Intent {
        check(mutable.value.phase == BuildDownloadPhase.Ready && !logFile) { "请先下载安装包" }
        val file = targetFile()
        check(file.isFile) { "安装包已被移除，请重新下载" }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    fun canInstallPackages(): Boolean = context.packageManager.canRequestPackageInstalls()
    fun installationError(message: String) { mutable.update { it.copy(error = message) } }

    @Suppress("DEPRECATION")
    private fun validateApk(file: File) {
        check(file.isFile && file.length() > 0) { "安装包文件为空，请重新下载" }
        val expectedSize = preferences.getLong("total", 0)
        check(expectedSize <= 0 || file.length() == expectedSize) { "安装包大小与服务端不符，请重新下载" }
        if (sha256.isNotBlank()) {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(65536)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            check(digest.digest().hex().equals(sha256, ignoreCase = true)) { "安装包校验失败，请重新下载" }
        }
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath, flags)
            ?: error("无法解析安装包，请重新下载")
        check(archive.packageName == context.packageName) { "安装包不属于 TerminalBuddy，已停止安装" }
        val installed = context.packageManager.getPackageInfo(context.packageName, flags)
        val archiveCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        val installedCode = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
        check(archiveCode >= installedCode) { "该安装包版本低于当前版本，请编译最新版本" }
        val incoming = if (Build.VERSION.SDK_INT >= 28) archive.signingInfo?.apkContentsSigners else archive.signatures
        val current = if (Build.VERSION.SDK_INT >= 28) installed.signingInfo?.apkContentsSigners else installed.signatures
        check(!incoming.isNullOrEmpty() && !current.isNullOrEmpty() &&
            incoming.map { it.toByteArray().toList() }.toSet() == current.map { it.toByteArray().toList() }.toSet()) {
            "安装包签名与当前应用不一致，请使用原 Release 签名打包"
        }
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun safeFilename(value: String) = value.isNotBlank() && value != "." && value != ".." &&
        value.length <= 180 && value.none { it == '/' || it == '\\' || it.isISOControl() }
    private fun relativePath() = "${if (logFile) "logs" else "builds"}/terminalbuddy/$filename"
    private fun targetFile(): File {
        check(safeFilename(filename)) { "下载文件名无效，请重新下载" }
        val root = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: error("手机存储暂时不可用")
        return File(root, relativePath())
    }
    private fun removeDownload() {
        if (downloadId > 0) runCatching { manager.remove(downloadId) }
        if (safeFilename(filename)) runCatching { targetFile().delete() }
        downloadId = -1
        filename = ""
        preferences.edit().clear().apply()
    }
}

class AppUpdateFileProvider : FileProvider()
