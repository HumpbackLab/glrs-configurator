package org.expresslrs.androidupdater

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallArgs {
    lateinit var path: String
}

@TauriPlugin
class AndroidUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun install(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallArgs::class.java)
            val apk = File(args.path)
            if (!apk.isFile) {
                invoke.reject("Downloaded APK is missing")
                return
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !activity.packageManager.canRequestPackageInstalls()) {
                val settings = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}"),
                )
                activity.startActivity(settings)
                invoke.resolve(result(permissionRequired = true, installerLaunched = false))
                return
            }

            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.androidupdater.fileprovider",
                apk,
            )
            val installer = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(Intent.EXTRA_RETURN_RESULT, false)
            }
            activity.startActivity(installer)
            invoke.resolve(result(permissionRequired = false, installerLaunched = true))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Failed to launch Android package installer")
        }
    }

    private fun result(permissionRequired: Boolean, installerLaunched: Boolean): JSObject {
        return JSObject().apply {
            put("permissionRequired", permissionRequired)
            put("installerLaunched", installerLaunched)
        }
    }
}
