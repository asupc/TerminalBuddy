package com.terminalbuddy.android

import android.app.Application
import com.terminalbuddy.android.data.AiRepository
import com.terminalbuddy.android.notifications.AiTaskNotifications

class TerminalBuddyApplication : Application() {
    val aiRepository by lazy { AiRepository(this) }
    val taskNotifications by lazy { AiTaskNotifications(this, aiRepository) }

    override fun onCreate() {
        super.onCreate()
        taskNotifications.initialize()
    }
}
