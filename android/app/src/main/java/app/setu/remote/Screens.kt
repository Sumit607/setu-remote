package app.setu.remote

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/** Shows Android's own "Start recording or casting?" prompt when the laptop asks to see the screen. */
class ProjectionActivity : ComponentActivity() {
    private val ask = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        SetuService.instance?.onProjection(if (r.resultCode == RESULT_OK) r.data else null)
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) ask.launch((getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).createScreenCaptureIntent())
    }
}

/** Control the laptop: hosts the same web controller the laptop serves to browsers, bundled inside the app. */
class RemoteActivity : ComponentActivity() {
    private var web: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val svc = SetuService.instance
        val code = svc?.webPairingCode()
        if (svc == null || code == null) { Toast.makeText(this, "Pair with your laptop first", Toast.LENGTH_SHORT).show(); finish(); return }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val w = WebView(this)
        web = w
        setContentView(w)
        @Suppress("DEPRECATION")
        w.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.mediaPlaybackRequiresUserGesture = false
        w.settings.allowFileAccess = true
        w.webViewClient = WebViewClient()
        w.webChromeClient = WebChromeClient()
        w.addJavascriptInterface(object { @JavascriptInterface fun close() { runOnUiThread { finish() } } }, "SetuHost")
        w.loadUrl("file:///android_asset/web/index.html#" + code + "&id=" + svc.selfId + "7&name=" + Uri.encode(svc.selfName) + "&embed=1&auto=1")
    }

    override fun onDestroy() {
        web?.let { it.loadUrl("about:blank"); it.destroy() }
        web = null
        super.onDestroy()
    }
}

/** "Share → Setu Remote" from any app: sends the files or text to the laptop. */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val out = Intent(this, SetuService::class.java).setAction(SetuService.ACTION_SEND)
        val uris = ArrayList<Uri>()
        @Suppress("DEPRECATION")
        when (intent?.action) {
            Intent.ACTION_SEND -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        }
        val text = intent?.getStringExtra(Intent.EXTRA_TEXT)
        if (uris.isNotEmpty()) {
            val clip = ClipData.newRawUri("files", uris[0])
            for (u in uris.drop(1)) clip.addItem(ClipData.Item(u))
            out.clipData = clip
            out.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } else if (!text.isNullOrBlank()) out.putExtra(Intent.EXTRA_TEXT, text)
        else { finish(); return }
        try { SetuService.start(this, out); Toast.makeText(this, "Sending to your laptop…", Toast.LENGTH_SHORT).show() }
        catch (e: Exception) { Toast.makeText(this, "Open Setu Remote once, then try again", Toast.LENGTH_LONG).show() }
        finish()
    }
}
