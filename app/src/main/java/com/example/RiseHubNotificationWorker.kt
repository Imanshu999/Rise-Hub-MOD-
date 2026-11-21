package com.example

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Native, first-party Rise Hub notification engine.
 * No Firebase, OneSignal, or other push service is used.
 * It polls the existing public JSON feeds when Android allows background work.
 */
class RiseHubNotificationWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            RiseHubNotifications.sync(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val WORK_NAME = "rise_hub_notification_sync"
        private const val IMMEDIATE_WORK_NAME = "rise_hub_notification_sync_now"

        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<RiseHubNotificationWorker>(
                15, TimeUnit.MINUTES
            )
                .setConstraints(constraints)
                .build()

            val workManager = WorkManager.getInstance(context)
            workManager.enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )

            val immediate = OneTimeWorkRequestBuilder<RiseHubNotificationWorker>()
                .setConstraints(constraints)
                .build()
            workManager.enqueueUniqueWork(
                IMMEDIATE_WORK_NAME,
                androidx.work.ExistingWorkPolicy.REPLACE,
                immediate
            )
        }

        fun syncNow(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val immediate = OneTimeWorkRequestBuilder<RiseHubNotificationWorker>()
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_WORK_NAME,
                androidx.work.ExistingWorkPolicy.REPLACE,
                immediate
            )
        }
    }
}

object RiseHubNotifications {
    const val CHANNEL_ID = "rise_hub_updates"
    private const val PREFS = "rise_hub_notifications"
    private const val SEEN_APPS = "seen_app_ids"
    private const val APP_SIGNATURES = "app_signatures"
    private const val SEEN_CUSTOM = "seen_custom_ids"
    private const val APP_FEED_URL =
        "https://raw.githubusercontent.com/Imanshu999/InstaPro-hack/refs/heads/main/app.json"
    private const val NOTIFICATION_FEED_URL =
        "https://raw.githubusercontent.com/Imanshu999/InstaPro-hack/refs/heads/main/notifications.json"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Rise Hub Updates",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "New apps and custom announcements from Rise Hub"
            }
        )
    }

    suspend fun sync(context: Context) {
        ensureChannel(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return

        val appsJson = fetchText(APP_FEED_URL)
        syncNewApps(context, appsJson)

        val customJson = runCatching { fetchText(NOTIFICATION_FEED_URL) }.getOrNull()
        if (!customJson.isNullOrBlank()) {
            syncCustomNotifications(context, customJson)
        }
    }

    private fun syncNewApps(context: Context, json: String) {
        val array = JSONArray(json)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(SEEN_APPS, emptySet())?.toMutableSet() ?: mutableSetOf()
        val signatures = prefs.getStringSet(APP_SIGNATURES, emptySet())?.toMutableSet() ?: mutableSetOf()

        // First run is intentionally silent: seed the current catalog instead of
        // notifying users about every app already present in the store.
        if (!prefs.contains(SEEN_APPS)) {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val id = item.optString("id").trim()
                if (id.isNotEmpty()) {
                    seen.add(id)
                    signatures.add(appSignature(item))
                }
            }
            prefs.edit()
                .putStringSet(SEEN_APPS, seen)
                .putStringSet(APP_SIGNATURES, signatures)
                .apply()
            return
        }

        val editor = prefs.edit()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val id = item.optString("id").trim()
            if (id.isEmpty()) continue

            val signature = appSignature(item)
            if (!seen.contains(id)) {
                postAppNotification(context, item, isUpdate = false)
                seen.add(id)
                signatures.add(signature)
            } else if (!signatures.contains(signature)) {
                postAppNotification(context, item, isUpdate = true)
                signatures.removeAll { it.startsWith("$id|") }
                signatures.add(signature)
            }
        }
        editor.putStringSet(SEEN_APPS, seen).putStringSet(APP_SIGNATURES, signatures).apply()
    }

    private fun syncCustomNotifications(context: Context, json: String) {
        val root = JSONObject(json)
        val array = root.optJSONArray("notifications") ?: JSONArray()
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(SEEN_CUSTOM, emptySet())?.toMutableSet() ?: mutableSetOf()

        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            if (!item.optBoolean("enabled", true)) continue

            val id = item.optString("id").trim()
            if (id.isEmpty() || seen.contains(id)) continue

            postCustomNotification(context, item)
            seen.add(id)
        }

        prefs.edit().putStringSet(SEEN_CUSTOM, seen).apply()
    }

    private fun appSignature(app: JSONObject): String {
        val id = app.optString("id").trim()
        val version = app.optString("version").trim()
        val updated = app.optString("updatedAt").trim()
        return "$id|$version|$updated"
    }

    private fun postAppNotification(context: Context, app: JSONObject, isUpdate: Boolean) {
        val id = app.optString("id").trim()
        val name = app.optString("name", "New app")
        val version = app.optString("version").trim()
        val developer = app.optString("developer").trim()
        val size = app.optString("size").trim()
        val date = app.optString("addedAt").ifBlank {
            app.optString("updatedAt").ifBlank { "Just added" }
        }
        val description = app.optString("description").trim()
        val iconUrl = app.optString("icon").trim()

        val details = buildString {
            append("$name is now available on Rise Hub.")
            if (version.isNotBlank()) append("\nVersion: $version")
            if (developer.isNotBlank()) append("\nDeveloper: $developer")
            if (size.isNotBlank()) append("\nSize: $size")
            append("\nAdded: $date")
            if (description.isNotBlank()) append("\n\n$description")
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("rise_hub_app_id", id)
        }
        val pending = PendingIntent.getActivity(
            context,
            stableId("app:$id"),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(com.example.R.mipmap.ic_launcher)
            .setContentTitle(if (isUpdate) "✨ App Updated • $name" else "🆕 New App Added • $name")
            .setContentText("Version ${version.ifBlank { "new" }} • ${if (isUpdate) "Updated" else "Added"} $date")
            .setStyle(NotificationCompat.BigTextStyle().bigText(details))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pending)

        downloadBitmap(iconUrl)?.let { bitmap ->
            builder.setLargeIcon(bitmap)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                builder.setStyle(
                    NotificationCompat.BigPictureStyle()
                        .bigPicture(bitmap)
                        .bigLargeIcon(null as Bitmap?)
                        .setSummaryText("$name • ${if (isUpdate) "Updated" else "Added"} $date")
                )
            }
        }

        NotificationManagerCompat.from(context).notify(stableId("app:$id"), builder.build())
    }

    private fun postCustomNotification(context: Context, item: JSONObject) {
        val id = item.optString("id").trim()
        val title = item.optString("title", "Rise Hub").trim()
        val message = item.optString("message", "").trim()
        val date = item.optString("date").trim()
        val time = item.optString("time").trim()
        val imageUrl = item.optString("image").trim()
        val appId = item.optString("appId").trim()

        if (message.isBlank()) return

        val details = buildString {
            append(message)
            if (date.isNotBlank() || time.isNotBlank()) {
                append("\n\n")
                if (date.isNotBlank()) append("Date: $date")
                if (time.isNotBlank()) append(" • Time: $time")
            }
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (appId.isNotBlank()) putExtra("rise_hub_app_id", appId)
        }
        val pending = PendingIntent.getActivity(
            context,
            stableId("custom:$id"),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(com.example.R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(details))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pending)

        downloadBitmap(imageUrl)?.let { bitmap ->
            builder.setLargeIcon(bitmap)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                builder.setStyle(
                    NotificationCompat.BigPictureStyle()
                        .bigPicture(bitmap)
                        .bigLargeIcon(null as Bitmap?)
                )
            }
        }

        NotificationManagerCompat.from(context).notify(stableId("custom:$id"), builder.build())
    }

    private fun fetchText(urlString: String): String {
        val connection = URL(urlString).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15000
            connection.readTimeout = 20000
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-cache")
            connection.setRequestProperty("User-Agent", "RiseHub/2.2 Android")
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun downloadBitmap(urlString: String): Bitmap? {
        if (urlString.isBlank() || !(urlString.startsWith("https://") || urlString.startsWith("http://"))) return null
        val connection = runCatching { URL(urlString).openConnection() as HttpURLConnection }.getOrNull() ?: return null
        return try {
            connection.connectTimeout = 10000
            connection.readTimeout = 15000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("User-Agent", "RiseHub/2.2 Android")
            if (connection.responseCode !in 200..299) return null
            connection.inputStream.use { BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    private fun stableId(value: String): Int = value.hashCode() and 0x7fffffff
}
