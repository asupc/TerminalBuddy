package com.terminalbuddy.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.terminalbuddy.android.data.ServerResultNotice
import com.terminalbuddy.android.data.userMessage
import com.terminalbuddy.android.notifications.ServerDecisionNotice
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** 服务端终端决策的 App 内待办与回答入口；通知监听负责写入待办，这里只负责提交。 */
class ServerDecisionViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as TerminalBuddyApplication).aiRepository
    private val notifications = (application as TerminalBuddyApplication).taskNotifications

    val decisions: StateFlow<List<ServerDecisionNotice>> = notifications.serverDecisions
    /** 最近的服务端任务结果，点击完成通知后打开详情对话框。 */
    val results: StateFlow<List<ServerResultNotice>> = notifications.serverResults
    private val mutableAnswering = MutableStateFlow<Set<String>>(emptySet())
    val answering: StateFlow<Set<String>> = mutableAnswering.asStateFlow()
    private val mutableError = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = mutableError.asStateFlow()

    fun answer(notice: ServerDecisionNotice, answers: Map<String, String>) {
        if (answers.isEmpty() || answers.values.any { it.isBlank() }) return
        if (notice.decisionId in mutableAnswering.value) return
        val connection = repository.accounts.connection(notice.accountId) ?: run {
            mutableError.value = "该决策所属账号已退出，请重新登录后再处理"
            return
        }
        mutableAnswering.update { it + notice.decisionId }
        mutableError.value = null
        viewModelScope.launch {
            try {
                repository.answerServerDecision(connection, notice.decisionId, answers)
                notifications.removeServerDecision(notice.decisionId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutableError.value = e.userMessage()
            } finally {
                mutableAnswering.update { it - notice.decisionId }
            }
        }
    }

    fun clearError() {
        mutableError.value = null
    }
}
