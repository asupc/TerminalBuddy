package com.terminalbuddy.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.terminalbuddy.android.ui.TerminalBuddyRoot
import com.terminalbuddy.android.ui.TerminalBuddyTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { TerminalBuddyTheme { TerminalBuddyRoot() } }
    }
}
