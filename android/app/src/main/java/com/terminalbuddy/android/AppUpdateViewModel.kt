package com.terminalbuddy.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.terminalbuddy.android.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

/** 构建状态独立于终端账号；切换节点、任务或服务后丢弃旧请求的返回值。 */
data class AppUpdateUiState(
    val server: String = "", val username: String = "admin", val editing: Boolean = true,
    val working: Boolean = false, val error: String? = null,
    val build: AndroidBuildState = AndroidBuildState(), val clock: Long = System.currentTimeMillis(),
)

class AppUpdateViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TerminalBuddyApplication
    private val repository = app.appUpdateRepository
    private val downloader = app.appUpdateDownloader
    private val refreshLock = Mutex()
    private var revision = 0
    private val mutable = MutableStateFlow(AppUpdateUiState(
        server = repository.store.server, username = repository.store.username, editing = !repository.store.loggedIn,
        build = AndroidBuildState(serverId = repository.selectedServer(), download = downloader.state.value),
    ))
    val state = mutable.asStateFlow()

    init {
        viewModelScope.launch { downloader.state.collect { download ->
            mutable.update { it.copy(build = it.build.copy(download = download)) }
        } }
    }

    fun editConnection() {
        if (mutable.value.working) return
        revision++
        mutable.update { it.copy(editing = true, error = null) }
    }
    fun keepConnection() {
        if (!repository.store.loggedIn || mutable.value.working) return
        mutable.update { it.copy(editing = false, error = null) }
        viewModelScope.launch { refresh() }
    }
    val canKeepConnection get() = repository.store.loggedIn

    fun login(server: String, username: String, password: String) {
        if (mutable.value.working) return
        revision++
        mutable.update { it.copy(working = true, error = null) }
        viewModelScope.launch {
            try {
                repository.login(server, username, password)
                mutable.update { it.copy(server = repository.store.server, username = repository.store.username,
                    editing = false, working = false,
                    build = AndroidBuildState(serverId = repository.selectedServer(), download = downloader.state.value)) }
                refresh()
            } catch (error: CancellationException) { throw error }
            catch (error: Throwable) { mutable.update { it.copy(working = false, error = error.userMessage()) } }
        }
    }

    suspend fun refresh() {
        if (mutable.value.editing || mutable.value.working || !repository.store.loggedIn || !refreshLock.tryLock()) return
        val epoch = revision
        val previous = mutable.value.build
        try {
            val status = repository.status(previous.serverId)
            var tasks = repository.tasks()
            val selected = previous.selectedId?.takeIf { id -> tasks.any { it.id == id } }
                ?: status.activeTask?.id ?: tasks.firstOrNull()?.id
            var logs = if (selected == previous.selectedId) previous.logs else ""
            var cursor = if (selected == previous.selectedId) previous.cursor else 0
            var complete = selected == previous.selectedId && previous.logComplete
            if (selected != null && !complete) {
                val chunk = repository.logs(selected, cursor)
                logs = ((if (chunk.reset) "" else logs) + chunk.text).takeLast(200_000)
                cursor = chunk.cursor
                complete = !chunk.hasMore && chunk.task?.active != true
                chunk.task?.let { task -> tasks = tasks.map { if (it.id == task.id) task else it } }
            }
            if (epoch != revision) return
            repository.selectServer(status.serverId)
            mutable.update { it.copy(clock = System.currentTimeMillis(), build = it.build.copy(
                serverId = status.serverId, status = status, tasks = tasks, loaded = true,
                selectedId = selected, logs = logs, cursor = cursor, logComplete = complete,
                connectionError = false, error = null,
            )) }
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) {
            if (epoch == revision) {
                if (error is ApiException && error.code == 401) {
                    repository.store.clear()
                    revision++
                    mutable.update { it.copy(editing = true, error = "葫芦娃登录已过期，请重新登录") }
                } else mutable.update { it.copy(build = it.build.copy(connectionError = true, error = error.userMessage())) }
            }
        } finally { refreshLock.unlock() }
    }

    fun selectServer(id: String) {
        if (mutable.value.working || id == mutable.value.build.serverId) return
        revision++
        repository.selectServer(id)
        mutable.update { it.copy(build = AndroidBuildState(serverId = id, download = it.build.download)) }
        viewModelScope.launch { refresh() }
    }
    fun selectTask(id: Long) {
        if (mutable.value.working || id == mutable.value.build.selectedId) return
        revision++
        mutable.update { it.copy(build = it.build.copy(selectedId = id, logs = "", cursor = 0, logComplete = false, follow = true)) }
        viewModelScope.launch { refresh() }
    }
    fun toggleFollow() { mutable.update { it.copy(build = it.build.copy(follow = !it.build.follow)) } }
    fun clearError() { mutable.update { it.copy(error = null) } }

    fun build() = perform {
        val task = repository.build(mutable.value.build.serverId)
        mutable.update { it.copy(build = it.build.copy(selectedId = task.id, logs = "", cursor = 0,
            logComplete = false, follow = true, tasks = listOf(task) + it.build.tasks.filter { old -> old.id != task.id },
            status = it.build.status.copy(activeTask = task))) }
    }
    fun cancelTask(id: Long) = perform { repository.cancel(id) }
    fun download(task: AndroidBuildTask, logFile: Boolean = false) = perform { downloader.download(task, logFile) }
    fun cancelDownload() = perform { downloader.cancel() }
    private fun perform(action: suspend () -> Unit) {
        if (mutable.value.working || mutable.value.editing) return
        revision++
        mutable.update { it.copy(working = true, error = null) }
        viewModelScope.launch {
            try { action() }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) {
                if (error is ApiException && error.code == 401) {
                    repository.store.clear()
                    mutable.update { it.copy(editing = true) }
                }
                mutable.update { it.copy(error = error.userMessage()) }
            } finally { mutable.update { it.copy(working = false) } }
            refresh()
        }
    }
    suspend fun pollDownload() = downloader.poll()
    fun installerIntent() = downloader.installIntent()
    fun canInstallPackages() = downloader.canInstallPackages()
    fun installationError(message: String) = downloader.installationError(message)
}
