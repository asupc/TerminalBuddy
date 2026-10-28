package com.terminalbuddy.android.notifications

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

internal data class AiBackgroundSettingsResult(val opened: Boolean, val message: String)

/** 接收间断是运行结果，不能据此认定厂商冻结或后台权限已放行。时间均为本进程的 elapsedRealtime。 */
internal data class AiBackgroundReceptionState(
    val checkedAt: Long = 0,
    val backgroundMillis: Long = 0,
    val receptionGapMillis: Long = 0,
    val interrupted: Boolean = false,
) {
    val checked get() = checkedAt > 0

    companion object {
        private const val MIN_BACKGROUND_MILLIS = 90_000L

        fun afterBackground(startedAt: Long, now: Long, lastReceivedAt: Long): AiBackgroundReceptionState? {
            val duration = (now - startedAt).coerceAtLeast(0)
            // 短暂切换设置或页面不作判断，给正常同步、超时和重连留出余量。
            if (duration < MIN_BACKGROUND_MILLIS) return null
            val gap = if (lastReceivedAt > 0) (now - lastReceivedAt).coerceAtLeast(0) else duration
            return AiBackgroundReceptionState(now, duration, gap, gap >= MIN_BACKGROUND_MILLIS)
        }
    }
}

/** vivo/iQOO 的厂商设置需用户确认，标准电池豁免不代表厂商后台授权。 */
internal object AiBackgroundCompatibility {
    private const val PREFS = "terminal_buddy_background_compatibility"
    private const val VIVO_GUIDE_CHECKED = "vivo_guide_checked_v1"

    fun isVivoDevice(): Boolean = listOf(Build.MANUFACTURER, Build.BRAND).any {
        it.equals("vivo", ignoreCase = true) || it.equals("iqoo", ignoreCase = true)
    }

    fun vivoGuideChecked(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(VIVO_GUIDE_CHECKED, false)

    fun markVivoGuideChecked(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(VIVO_GUIDE_CHECKED, true).apply()
    }

    fun openVivoAutoStart(context: Context): AiBackgroundSettingsResult {
        val intent = Intent().setComponent(ComponentName(
            "com.vivo.permissionmanager",
            "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
        ))
        // 显式启动并处理异常，避免 Android 包可见性让 resolveActivity 误判入口不可用。
        if (launch(context, intent)) return AiBackgroundSettingsResult(
            true, "已打开自启动管理，请找到 TerminalBuddy 并允许自启动、关联启动。",
        )
        return openAppDetails(context, "已打开应用详情，请在权限管理中查找自启动、关联启动。")
    }

    fun openPowerSettings(context: Context): AiBackgroundSettingsResult {
        // 使用公开的电池入口，具体的后台耗电选项由 OriginOS 提供，兼容不同固件。
        if (launch(context, Intent(Intent.ACTION_POWER_USAGE_SUMMARY))) return AiBackgroundSettingsResult(
            true, "已打开电池设置，请进入后台耗电管理，将 TerminalBuddy 设为允许后台高耗电。",
        )
        return openAppDetails(context, "已打开应用详情，请进入耗电管理，允许后台高耗电。")
    }

    fun openBatteryOptimizationSettings(context: Context): AiBackgroundSettingsResult {
        val power = context.getSystemService(PowerManager::class.java)
        if (power.isIgnoringBatteryOptimizations(context.packageName)) return AiBackgroundSettingsResult(
            true, "系统电池优化已豁免，仍需单独检查 vivo 后台耗电和自启动设置。",
        )
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.packageName}"))
        if (launch(context, intent)) return AiBackgroundSettingsResult(true, "请在系统提示中允许电池优化豁免。")
        return openAppDetails(context, "已打开应用详情，请检查电池优化设置。")
    }

    private fun openAppDetails(context: Context, message: String): AiBackgroundSettingsResult {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        return if (launch(context, intent)) AiBackgroundSettingsResult(true, message)
        else AiBackgroundSettingsResult(false, "未能打开系统设置，请手动进入设置，检查 TerminalBuddy 的后台耗电和自启动权限。")
    }

    private fun launch(context: Context, intent: Intent): Boolean = runCatching {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.isSuccess
}
