package com.terminalbuddy.android.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.terminalbuddy.android.TerminalBuddyApplication

/** 仅在系统明确允许的开机/升级广播中恢复已登录账号的前台消息服务。 */
class AiTaskMonitorReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        (context.applicationContext as TerminalBuddyApplication).taskNotifications.restoreFromSystem(intent.action.orEmpty())
    }
}
