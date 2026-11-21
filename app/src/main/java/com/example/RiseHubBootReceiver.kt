package com.example

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class RiseHubBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED ||
            intent?.action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            RiseHubNotificationWorker.schedule(context)
        }
    }
}
