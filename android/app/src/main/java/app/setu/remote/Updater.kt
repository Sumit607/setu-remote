package app.setu.remote

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Keeps the app up to date by itself. Every build on GitHub publishes SetuRemote.apk and a small
 * android.json next to it; the app compares version numbers, downloads the newer APK, checks its
 * SHA-256 and hands it to Android's installer. Android only accepts it if it is signed with the
 * same key as the installed app.
 */
object Updater {
    private const val TAG = "SetuUpdate"
    const val FEED = "https://github.com/Sumit607/setu-remote/releases/download/android/android.json"
    const val ACTION_RESULT = "app.setu.remote.UPDATE_RESULT"
    private const val NOTE_ID = 98

    /** One line for the app's main screen. */
    @Volatile var status: String = ""
        private set
    @Volatile private var busy = false
    @Volatile private var lastCheck = 0L
    /** Android's "Update this app?" screen, when it insists on asking. */
    @Volatile var confirm: Intent? = null

    fun versionName(ctx: Context): String = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?" } catch (e: Exception) { "?" }

    @Suppress("DEPRECATION")
    fun versionCode(ctx: Context): Long = try {
        val p = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()
    } catch (e: Exception) { 0L }

    private fun say(s: String) { status = s; for (l in SetuService.listeners) try { l() } catch (e: Exception) {} }

    /** Background check, at most once every 3 hours unless [force]. Skipped while the screen is being shared. */
    fun check(ctx: Context, force: Boolean) {
        val app = ctx.applicationContext
        val now = System.currentTimeMillis()
        if (busy) return
        if (!force && (now - lastCheck < 3 * 3600_000L || SetuService.instance?.sharing == true)) return
        busy = true; lastCheck = now
        Thread({
            try { run(app, force) }
            catch (e: Exception) { Log.w(TAG, "update check", e); if (force) say("Could not check for updates: ${e.message ?: e.javaClass.simpleName}") }
            finally { busy = false }
        }, "setu-update").start()
    }

    private fun open(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 30000; c.instanceFollowRedirects = true
        c.setRequestProperty("Cache-Control", "no-cache")
        if (c.responseCode != 200) { val code = c.responseCode; c.disconnect(); throw IOException(if (code == 404) "no build published yet" else "server answered $code") }
        return c
    }

    private fun run(ctx: Context, force: Boolean) {
        if (force) say("Checking for updates…")
        val feed = open(FEED).let { c -> try { JSONObject(c.inputStream.bufferedReader().readText()) } finally { c.disconnect() } }
        val code = feed.getLong("versionCode")
        val name = feed.optString("versionName", code.toString())
        if (code <= versionCode(ctx)) { say("Up to date"); return }
        say("Downloading version $name…")
        val file = File(ctx.cacheDir, "update.apk")
        val md = MessageDigest.getInstance("SHA-256")
        open(feed.getString("url")).let { c ->
            try {
                c.inputStream.use { ins -> file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) { val n = ins.read(buf); if (n < 0) break; out.write(buf, 0, n); md.update(buf, 0, n) }
                } }
            } finally { c.disconnect() }
        }
        val sha = md.digest().joinToString("") { "%02x".format(it) }
        if (!sha.equals(feed.getString("sha256"), ignoreCase = true)) { file.delete(); throw IOException("downloaded file did not match its checksum") }
        say("Installing version $name…")
        install(ctx, file)
    }

    private fun install(ctx: Context, apk: File) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        params.setSize(apk.length())
        // Android 12+: an app may update itself without a prompt. If the phone still wants one, UpdateReceiver shows it.
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = pi.createSession(params)
        val session = pi.openSession(id)
        try {
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out, 64 * 1024) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val done = PendingIntent.getBroadcast(ctx, 7, Intent(ctx, UpdateReceiver::class.java).setAction(ACTION_RESULT), flags)
            session.commit(done.intentSender)
        } catch (e: Exception) {
            session.abandon()
            throw e
        } finally { session.close() }
    }

    /** Called by [UpdateReceiver] with Android's verdict. On success the app is simply restarted in the new version. */
    fun onResult(ctx: Context, intent: Intent) {
        when (val st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_SUCCESS -> say("Updated")
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val ask = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                confirm = ask
                say("Update ready. Tap “Install update”.")
                // Open Android's confirmation straight away when allowed; the notification covers the case where it is not.
                try { (InputService.instance ?: ctx).startActivity(ask) } catch (e: Exception) { Log.w(TAG, "confirm screen", e) }
                try {
                    val tap = PendingIntent.getActivity(ctx, 8, ask, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    val n = NotificationCompat.Builder(ctx, SetuService.CH_MSG).setSmallIcon(R.drawable.ic_stat).setContentTitle("Setu Remote update is ready")
                        .setContentText("Tap to install it.").setAutoCancel(true).setContentIntent(tap).build()
                    ctx.getSystemService(NotificationManager::class.java).notify(NOTE_ID, n)
                } catch (e: Exception) { Log.w(TAG, "update notification", e) }
            }
            else -> {
                confirm = null
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $st"
                Log.w(TAG, "install failed: $msg")
                say("Update could not be installed: $msg")
            }
        }
    }

    /** Opens Android's confirmation again, e.g. from the button in the app. */
    fun resumeConfirm(ctx: Context): Boolean {
        val ask = confirm ?: return false
        return try { ctx.startActivity(ask); true } catch (e: Exception) { false }
    }
}

class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Updater.ACTION_RESULT) Updater.onResult(ctx, intent)
    }
}
