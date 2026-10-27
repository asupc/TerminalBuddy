package com.terminalbuddy.android.notifications

import android.content.Context
import android.util.Log
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 只记录本地链路状态，不记录服务地址、令牌、正文或异常中的请求 URL。 */
internal class AiNotificationDiagnostics(context: Context) {
    private val preferences = context.getSharedPreferences("terminal_buddy_notification_diagnostics", Context.MODE_PRIVATE)
    private val events = runCatching {
        val saved = JSONArray(preferences.getString("events", "[]"))
        (0 until saved.length()).map { saved.getString(it) }.takeLast(60).toMutableList()
    }.getOrDefault(mutableListOf())

    fun record(message: String) {
        Log.i("AiTaskMonitor", message)
        val time = SimpleDateFormat("MM-dd HH:mm:ss", Locale.ROOT).format(Date())
        events.add("$time $message")
        while (events.size > 60) events.removeAt(0)
        preferences.edit().putString("events", JSONArray(events).toString()).apply()
    }

    fun text(): String = events.joinToString("\n")
}
