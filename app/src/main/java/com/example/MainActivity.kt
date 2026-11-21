package com.example

import android.annotation.SuppressLint
import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.FileProvider
import com.example.ui.theme.RiseHubTheme
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    RiseHubNotifications.ensureChannel(this)
    RiseHubNotificationWorker.schedule(this)
    NotificationRouter.pendingAppId = intent.getStringExtra("rise_hub_app_id")
    enableEdgeToEdge()
    setContent {
      RiseHubTheme { RiseHubApp() }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    NotificationRouter.pendingAppId = intent.getStringExtra("rise_hub_app_id")
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == 4101 &&
      grantResults.isNotEmpty() &&
      grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      // Permission was just granted: run the first catalog/notification sync immediately.
      RiseHubNotificationWorker.syncNow(this)
    }
  }
}

private object NotificationRouter {
  @Volatile var pendingAppId: String? = null
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun RiseHubApp() {
  val context = LocalContext.current
  var webViewInstance by remember { mutableStateOf<WebView?>(null) }
  var showNotificationPrompt by rememberSaveable { mutableStateOf(false) }

  LaunchedEffect(Unit) {
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      showNotificationPrompt = true
    } else {
      RiseHubNotificationWorker.syncNow(context)
    }
  }
  var filePathCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
  val assetLoader = remember(context) {
    WebViewAssetLoader.Builder()
      .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
      .build()
  }

  val filePickerLauncher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.GetMultipleContents()
  ) { uris ->
    filePathCallback?.onReceiveValue(uris.toTypedArray())
    filePathCallback = null
  }

  BackHandler(enabled = webViewInstance != null) {
    webViewInstance?.evaluateJavascript("window.handleHardwareBack ? window.handleHardwareBack() : false") { result ->
      if (result != "true") {
        if (webViewInstance?.canGoBack() == true) webViewInstance?.goBack()
        else (context as? ComponentActivity)?.finish()
      }
    }
  }

  if (showNotificationPrompt && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
    AlertDialog(
      onDismissRequest = { showNotificationPrompt = false },
      title = {
        Text(
          text = "Stay updated with Rise Hub",
          style = MaterialTheme.typography.headlineSmall
        )
      },
      text = {
        Text(
          "Allow notifications to get instant alerts when a new app, update, or announcement is published on Rise Hub. You can change this permission anytime in Android Settings."
        )
      },
      confirmButton = {
        Button(
          onClick = {
            showNotificationPrompt = false
            (context as? ComponentActivity)?.requestPermissions(
              arrayOf(Manifest.permission.POST_NOTIFICATIONS),
              4101
            )
          }
        ) {
          Text("Allow notifications")
        }
      },
      dismissButton = {
        TextButton(onClick = { showNotificationPrompt = false }) {
          Text("Not now")
        }
      }
    )
  }

  Box(
    modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
      .windowInsetsPadding(WindowInsets.statusBars).testTag("rise_hub_main_container")
  ) {
    AndroidView(
      modifier = Modifier.fillMaxSize().testTag("rise_hub_webview"),
      factory = { ctx ->
        WebView(ctx).apply {
          layoutParams = android.view.ViewGroup.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT
          )
          settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
          }

          val bridge = RiseHubDownloadBridge(ctx, this)
          addJavascriptInterface(bridge, "AndroidBridge")

          webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean = super.onConsoleMessage(consoleMessage)
            override fun onShowFileChooser(
              webView: WebView?,
              filePathCallbackParam: ValueCallback<Array<Uri>>?,
              fileChooserParams: FileChooserParams?
            ): Boolean {
              filePathCallback?.onReceiveValue(null)
              filePathCallback = filePathCallbackParam
              return try {
                filePickerLauncher.launch("image/*")
                true
              } catch (e: Exception) {
                filePathCallback = null
                false
              }
            }
          }

          webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) =
              request?.url?.let { assetLoader.shouldInterceptRequest(it) }
                ?: super.shouldInterceptRequest(view, request)

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
              val url = request?.url?.toString() ?: return true
              return if (url.startsWith("file://") || url.startsWith("data:")) false else true
            }
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
              super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
              super.onPageFinished(view, url)
              val appId = NotificationRouter.pendingAppId ?: return
              NotificationRouter.pendingAppId = null
              val safeId = JSONObject.quote(appId)
              view?.postDelayed({
                view.evaluateJavascript(
                  "window.RiseHubOpenNotificationApp && window.RiseHubOpenNotificationApp($safeId);",
                  null
                )
              }, 1200L)
            }
          }

          setDownloadListener { _, _, _, _, _ ->
            // Download actions are handled explicitly by the Rise Hub bridge.
          }

          loadUrl("https://appassets.androidplatform.net/assets/rise_hub.html")
          webViewInstance = this
        }
      },
      update = { webViewInstance = it }
    )
  }
}

// End of RiseHubApp.

private class RiseHubDownloadBridge(
  private val context: android.content.Context,
  private val webView: WebView
) {
  private val executor = Executors.newCachedThreadPool()
  private val activeTasks = ConcurrentHashMap<String, Future<*>>()
  private val cancelFlags = ConcurrentHashMap<String, AtomicBoolean>()

  private fun safeId(id: String) = id.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)
  private fun downloadDir(): File = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir, "risehub")
  private fun apkFile(appId: String): File = File(downloadDir(), "risehub_${safeId(appId)}.apk")

  private fun js(script: String) { webView.post { webView.evaluateJavascript(script, null) } }
  private fun jsArg(value: String) = JSONObject.quote(value)

  @JavascriptInterface
  fun getAppVersion(): String = BuildConfig.VERSION_NAME

  // True when the device has an active network that can reach the internet.
  @JavascriptInterface
  fun isNetworkAvailable(): Boolean {
    return try {
      val cm = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
      val network = cm.activeNetwork ?: return false
      val caps = cm.getNetworkCapabilities(network) ?: return false
      caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    } catch (e: Exception) {
      true
    }
  }

  // Opens the system Wi-Fi / mobile data settings from the no-internet screen.
  @JavascriptInterface
  fun openNetworkSettings() {
    try {
      context.startActivity(
        Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    } catch (e: Exception) { }
  }

  @JavascriptInterface
  fun downloadFile(urlString: String, originalName: String, appId: String) {
    val id = appId.trim()
    if (id.isEmpty() || urlString.isBlank()) {
      js("window.onNativeDownloadError && window.onNativeDownloadError(${jsArg(id)},${jsArg("Invalid download request.")})")
      return
    }

    cancelDownload(id, notify = false)
    val cancelled = AtomicBoolean(false)
    cancelFlags[id] = cancelled

    val future = executor.submit {
      val targetDir = downloadDir()
      if (!targetDir.exists()) targetDir.mkdirs()
      val target = apkFile(id)
      var connection: HttpURLConnection? = null
      var completed = false
      try {
        connection = openDownloadConnection(urlString)
        val response = connection.responseCode
        if (response !in 200..299) {
          if (response == HttpURLConnection.HTTP_FORBIDDEN) {
            connection.disconnect()
            connection = openDownloadConnection(urlString, retry = true)
          }
        }

        val finalResponse = connection.responseCode
        if (finalResponse !in 200..299) {
          throw IllegalStateException("Download server returned HTTP $finalResponse.")
        }

        val contentType = connection.contentType?.lowercase().orEmpty()
        val total = connection.contentLengthLong.coerceAtLeast(0L)
        var received = 0L
        var signature = ByteArray(0)

        connection.inputStream.use { input ->
          FileOutputStream(target).use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              if (cancelled.get() || Thread.currentThread().isInterrupted) throw InterruptedException()
              val count = input.read(buffer)
              if (count < 0) break
              if (signature.size < 4) {
                val needed = 4 - signature.size
                val take = minOf(needed, count)
                signature += buffer.copyOfRange(0, take)
              }
              output.write(buffer, 0, count)
              received += count
              val percent = if (total > 0) ((received * 100L) / total).toInt() else 0
              js("window.onNativeDownloadProgress && window.onNativeDownloadProgress(${jsArg(id)},$percent,$received,$total)")
            }
            output.flush()
          }
        }

        if (cancelled.get() || Thread.currentThread().isInterrupted) throw InterruptedException()
        val looksLikeZip = signature.size >= 2 && signature[0] == 0x50.toByte() && signature[1] == 0x4B.toByte()
        if (!looksLikeZip || contentType.contains("text/html") || contentType.contains("text/plain")) {
          throw IllegalStateException("The download server did not return a valid APK file.")
        }

        completed = true
        js("window.onNativeDownloadComplete && window.onNativeDownloadComplete(${jsArg(id)},${jsArg(target.absolutePath)})")
      } catch (e: InterruptedException) {
        target.delete()
        js("window.onNativeDownloadCancelled && window.onNativeDownloadCancelled(${jsArg(id)})")
      } catch (error: Exception) {
        target.delete()
        val message = error.message ?: "Download failed."
        js("window.onNativeDownloadError && window.onNativeDownloadError(${jsArg(id)},${jsArg(message)})")
      } finally {
        connection?.disconnect()
        if (!completed) target.deleteOnExit()
        activeTasks.remove(id)
        cancelFlags.remove(id)
      }
    }
    activeTasks[id] = future
  }

  private fun openDownloadConnection(urlString: String, retry: Boolean = false): HttpURLConnection {
    val connection = URL(urlString).openConnection() as HttpURLConnection
    connection.connectTimeout = 20000
    connection.readTimeout = 45000
    connection.instanceFollowRedirects = true
    connection.requestMethod = "GET"
    connection.setRequestProperty("User-Agent", if (retry) {
      "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36"
    } else {
      "RiseHub/1.0 AndroidAppStore"
    })
    connection.setRequestProperty("Accept", "application/vnd.android.package-archive,application/octet-stream,application/zip,*/*")
    connection.setRequestProperty("Accept-Encoding", "identity")
    connection.setRequestProperty("Connection", "close")
    try {
      val origin = Uri.parse(urlString).let { "${it.scheme}://${it.host}" }
      if (!origin.contains("null")) connection.setRequestProperty("Referer", origin + "/")
    } catch (e: Exception) { }
    return connection
  }

  @JavascriptInterface
  fun cancelDownload(appId: String) = cancelDownload(appId, notify = true)

  private fun cancelDownload(appId: String, notify: Boolean) {
    val id = appId.trim()
    cancelFlags[id]?.set(true)
    activeTasks[id]?.cancel(true)
    if (notify && activeTasks[id] == null) {
      js("window.onNativeDownloadCancelled && window.onNativeDownloadCancelled(${jsArg(id)})")
    }
  }

  @JavascriptInterface
  fun installDownloadedFile(appId: String) {
    val file = apkFile(appId)
    if (!file.exists()) {
      js("window.onNativeDownloadError && window.onNativeDownloadError(${jsArg(appId)},${jsArg("Downloaded file is no longer available.")})")
      return
    }
    try {
      val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    } catch (error: Exception) {
      js("window.onNativeDownloadError && window.onNativeDownloadError(${jsArg(appId)},${jsArg(error.message ?: "Unable to open installer.")})")
    }
  }

  @JavascriptInterface
  fun deleteDownloadedFile(appId: String) {
    cancelDownload(appId, notify = false)
    apkFile(appId).delete()
  }
}

private object JSONObject {
  fun quote(value: String): String {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\""
  }
}
