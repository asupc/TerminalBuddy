package com.terminalbuddy.android

import android.app.Application
import com.terminalbuddy.android.data.AiRepository

class TerminalBuddyApplication : Application() {
    val aiRepository by lazy { AiRepository(this) }
}
