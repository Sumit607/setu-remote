package app.setu.remote

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.hardware.display.DisplayManager
import android.media.MediaScannerConnection
import android.media.ThumbnailUtils
import android.media.projection.MediaProjection
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.StatFs
import android.provider.ContactsContract
import android.provider.OpenableColumns
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SmsManager
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.util.Size
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.Camera2Capturer
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.VideoCapturer
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Always-on service: keeps the phone reachable from the laptop and answers its requests. */
class SetuService : Service(), Api {
    companion object {
        @Volatile var instance: SetuService? = null
        val listeners = CopyOnWriteArrayList<() -> Unit>()
        const val CH = "setu_status"
        const val CH_MSG = "setu_events"
        const val NID = 1
        const val ACTION_SEND = "app.setu.remote.SEND"
        const val ACTION_STOP_SHARE = "app.setu.remote.STOP_SHARE"
        const val ACTION_CAM = "app.setu.remote.CAMERA_SCREEN"

        fun start(ctx: Context, intent: Intent? = null) {
            val i = intent ?: Intent(ctx, SetuService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }

    lateinit var prefs: SharedPreferences
    val rooms = ConcurrentHashMap<String, Room>()
    val work: ExecutorService = Executors.newCachedThreadPool()
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private var rtc: Rtc? = null
    private val root: String get() = Environment.getExternalStorageDirectory().absolutePath
    private val contactCache = ConcurrentHashMap<String, String>()

    // screen sharing state
    @Volatile private var projWait: CompletableFuture<Intent>? = null
    private var capturer: VideoCapturer? = null
    @Volatile private var capKind = ""          // "screen" or "camera" while something is being sent
    @Volatile private var camFirstFrame = false
    private var camFacing = "back"
    @Volatile private var camWait: CompletableFuture<Boolean>? = null
    val waitingForConsent: Boolean get() = projWait != null
    val cameraOn: Boolean get() = capKind == "camera" && capPeer != null
    var autoShare: Boolean
        get() = prefs.getBoolean("autoShare", false)
        set(v) { prefs.edit().putBoolean("autoShare", v).apply() }
    private var source: VideoSource? = null
    private var helper: SurfaceTextureHelper? = null
    private var track: VideoTrack? = null
    @Volatile private var capPeer: Peer? = null
    private var capSize = Pair(0, 0)
    val sharing: Boolean get() = capPeer != null
    private val updateTick = object : Runnable { override fun run() { Updater.check(this@SetuService, false); main.postDelayed(this, 3 * 3600_000L + 60_000L) } }

    val selfId: String get() = prefs.getString("id", null) ?: (100000000 + java.security.SecureRandom().nextInt(900000000)).toString().also { prefs.edit().putString("id", it).apply() }
    val selfName: String get() = Settings.Global.getString(contentResolver, "device_name")?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = getSharedPreferences("setu", Context.MODE_PRIVATE)
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CH, "Connection status", NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CH_MSG, "Files and text from your laptop", NotificationManager.IMPORTANCE_DEFAULT))
        }
        goForeground(false)
        try { rtc = Rtc(this) } catch (e: Throwable) { Log.e(TAG, "WebRTC failed to start", e) }
        for (p in pairings()) openRoom(p)
        main.postDelayed(updateTick, 45_000L)
        // Tell the laptop when the phone locks or unlocks, so its "Unlock" button is always right.
        try {
            val f = IntentFilter(Intent.ACTION_SCREEN_OFF); f.addAction(Intent.ACTION_USER_PRESENT); f.addAction(Intent.ACTION_SCREEN_ON)
            registerReceiver(object : android.content.BroadcastReceiver() {
                override fun onReceive(c: Context?, i: Intent?) { main.postDelayed({ work.execute { try { pc()?.let { if (it.online) it.notify("sys.changed", JSONObject()) } } catch (e: Exception) {} } }, 400) }
            }, f)
        } catch (e: Exception) { Log.w(TAG, "screen state receiver", e) }
        main.post { changed() } // the main screen may already be open and showing "Starting…"
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { for (r in rooms.values) r.networkChanged() }
            })
        } catch (e: Exception) { Log.w(TAG, "network callback", e) }
        (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).registerDisplayListener(object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
            override fun onDisplayChanged(displayId: Int) { if (capturer != null && capKind == "screen") work.execute { resizeCapture() } }
        }, main)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_SHARE -> work.execute { stopCapture(true) }
            // The camera screen is in front: Android now allows the camera, so mark the service as using it.
            ACTION_CAM -> { val f = camWait; if (f != null) { try { goForeground(false, true); f.complete(true) } catch (e: Exception) { f.completeExceptionally(e) } } }
            ACTION_SEND -> {
                val uris = ArrayList<Uri>()
                intent?.clipData?.let { c -> for (i in 0 until c.itemCount) c.getItemAt(i).uri?.let { uris.add(it) } }
                val text = intent?.getStringExtra(Intent.EXTRA_TEXT)
                if (uris.isNotEmpty()) sendUris(uris) else if (!text.isNullOrBlank()) sendText(text)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        for (r in rooms.values) r.close()
        instance = null
        super.onDestroy()
    }

    // ---------------------------------------------------------------- pairing and state
    fun pairings(): List<JSONObject> {
        val a = try { JSONArray(prefs.getString("pairings", "[]")) } catch (e: Exception) { JSONArray() }
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }
    }

    private fun savePairings(list: List<JSONObject>) { prefs.edit().putString("pairings", JSONArray(list).toString()).apply() }

    fun pair(code: String) {
        val p = Proto.decodePairing(code)
        val list = pairings().filter { it.optString("s") != p.optString("s") && it.optString("id") != p.optString("id") }
        for (old in pairings()) if (old.optString("id") == p.optString("id")) rooms.remove(old.optString("s"))?.close()
        savePairings(list + p)
        openRoom(p)
        changed()
    }

    fun unpairAll() {
        for (r in rooms.values) r.close()
        rooms.clear(); savePairings(emptyList()); changed()
    }

    private fun openRoom(p: JSONObject) {
        val r = rtc ?: return
        val secret = p.optString("s")
        if (secret.isEmpty() || rooms.containsKey(secret)) return
        try {
            val room = Room(this, p, selfId, selfName, this, r, http) { persist(); changed() }
            rooms[secret] = room
            room.start()
        } catch (e: Exception) { Log.e(TAG, "bad pairing", e) }
    }

    private fun persist() { savePairings(rooms.values.map { it.pairing }) }

    fun pc(): Peer? = rooms.values.mapNotNull { it.pc() }.let { l -> l.firstOrNull { it.online } ?: l.firstOrNull() }
    val paired: Boolean get() = rooms.isNotEmpty()
    val relayOpen: Boolean get() = rooms.values.any { it.relayOpen }

    /** Pairing code handed to the built-in web controller (always carries the laptop's latest Wi-Fi address). */
    fun webPairingCode(): String? = rooms.values.firstOrNull()?.let { Proto.encodePairing(it.pairing) }

    fun changed() {
        main.post {
            try { getSystemService(NotificationManager::class.java).notify(NID, statusNotification()) } catch (e: Exception) {}
            for (l in listeners) try { l() } catch (e: Exception) {}
        }
    }

    fun refreshCaps() { for (r in rooms.values) r.announceNow() }

    // ---------------------------------------------------------------- notifications
    private fun statusNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val peer = pc()
        val sharing = capPeer
        val b = NotificationCompat.Builder(this, CH).setSmallIcon(R.drawable.ic_stat).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        if (sharing != null) {
            val cam = capKind == "camera"
            val stop = PendingIntent.getService(this, 1, Intent(this, SetuService::class.java).setAction(ACTION_STOP_SHARE), PendingIntent.FLAG_IMMUTABLE)
            b.setContentTitle(if (cam) "${sharing.name} is viewing this phone’s camera" else "${sharing.name} is viewing this phone").setContentText(if (cam) "Tap Stop to turn the camera off." else "Tap Stop to end screen sharing.").addAction(0, "Stop", stop).setColor(0xFFF2A20C.toInt())
        } else if (!paired) b.setContentTitle("Setu Remote").setContentText("Not paired yet. Open the app to pair with your laptop.")
        else if (peer != null && peer.online) b.setContentTitle("Connected to ${peer.name}").setContentText("Files, messages and screen are available to your laptop.")
        else b.setContentTitle("Setu Remote").setContentText(if (relayOpen) "Waiting for your laptop to come online." else "Looking for a connection…")
        return b.build()
    }

    private fun goForeground(projection: Boolean, camera: Boolean = false) {
        var type = 0
        if (Build.VERSION.SDK_INT >= 29) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            if (projection) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            if (camera && Build.VERSION.SDK_INT >= 30) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        try { ServiceCompat.startForeground(this, NID, statusNotification(), type) }
        catch (e: Exception) { Log.e(TAG, "startForeground", e); if (projection) throw IOException("Android did not allow screen sharing to start"); if (camera) throw IOException("Android did not allow the camera to start") }
    }

    private var eventId = 100
    private fun eventNote(title: String, text: String, open: Intent? = null) {
        val pi = PendingIntent.getActivity(this, eventId, open ?: Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, CH_MSG).setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(pi).build()
        try { getSystemService(NotificationManager::class.java).notify(eventId++, n) } catch (e: Exception) {}
    }

    private fun has(perm: String) = ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
    fun hasFiles(): Boolean = if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else has(Manifest.permission.WRITE_EXTERNAL_STORAGE)

    // ---------------------------------------------------------------- Api
    override fun caps(): JSONObject = JSONObject().put("input", InputService.instance != null).put("files", hasFiles())
        .put("sms", has(Manifest.permission.READ_SMS)).put("notif", NotifService.instance != null)

    override fun onInput(ev: JSONObject, peer: Peer) { if (peer === capPeer && capKind == "screen") InputService.instance?.perform(ev) }

    override fun onVideoEnded(peer: Peer) { if (peer === capPeer) work.execute { stopCapture(false) } }

    override fun handle(method: String, p: JSONObject, peer: Peer): Reply = when (method) {
        "sys.info" -> Reply(sysInfo())
        "fs.list" -> Reply(fsList(p.optString("path"), p.optInt("offset"), p.optInt("limit", 500)))
        "fs.read" -> fsRead(p.getString("path"))
        "fs.write" -> fsWrite(p, peer)
        "fs.thumb" -> Reply(fsThumb(p.getString("path"), p.optInt("max", 200)))
        "media.recent" -> Reply(mediaRecent(p.optInt("limit", 300)))
        "sms.threads" -> Reply(smsThreads(p.optInt("limit", 40)))
        "sms.list" -> Reply(smsList(p))
        "sms.send" -> Reply(smsSend(p.getString("addr"), p.getString("body")))
        "notif.list" -> Reply(JSONObject().put("items", NotifService.instance?.list() ?: JSONArray()))
        "notif.reply" -> Reply((NotifService.instance ?: throw IOException("Allow notification access for Setu Remote on the phone")).reply(p.getString("key"), p.getString("text")))
        "text.push" -> { setClipboard(p.optString("text")); eventNote("Text from ${peer.name} (copied)", p.optString("text")); Reply() }
        "clip.set" -> { setClipboard(p.optString("text")); Reply() }
        "screen.start" -> Reply(screenStart(peer))
        "screen.stop" -> { stopCapture(false); Reply() }
        "cam.start" -> Reply(camStart(peer, p.optString("facing", "back")))
        "cam.stop" -> { stopCapture(false); Reply() }
        "dev.unlock" -> { val r = Unlocker.unlock(this); changed(); Reply(r) }
        else -> throw IOException("Not supported: $method")
    }

    private fun sysInfo(): JSONObject {
        val o = JSONObject().put("name", selfName).put("model", "${Build.MANUFACTURER} ${Build.MODEL}").put("android", Build.VERSION.RELEASE).put("caps", caps())
        o.put("locked", Unlocker.locked(this)).put("unlock", Unlocker.ready(this))
        registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.let { b ->
            val level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            if (level >= 0 && scale > 0) o.put("battery", level * 100 / scale)
            o.put("charging", b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0)
        }
        try { val st = StatFs(root); o.put("storageTotal", st.totalBytes).put("storageFree", st.availableBytes) } catch (e: Exception) {}
        if (has(Manifest.permission.READ_SMS)) try {
            contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI, arrayOf("_id"), "read=0", null, null)?.use { o.put("smsUnread", it.count) }
        } catch (e: Exception) {}
        return o
    }

    // ---------- files
    private fun needFiles() { if (!hasFiles()) throw IOException("Allow “All files access” for Setu Remote on the phone") }

    private fun places(): JSONArray {
        val out = JSONArray()
        val list = listOf(Triple("Camera", "$root/DCIM/Camera", "camera"), Triple("Screenshots", "$root/DCIM/Screenshots", "camera"), Triple("Screenshots", "$root/Pictures/Screenshots", "camera"),
            Triple("Downloads", "$root/Download", "folder"), Triple("Documents", "$root/Documents", "file"),
            Triple("WhatsApp media", "$root/Android/media/com.whatsapp/WhatsApp/Media", "folder"), Triple("Setu inbox", "$root/Download/Setu", "folder"), Triple("Internal storage", root, "phone"))
        val seen = HashSet<String>()
        for ((n, path, icon) in list) if (File(path).isDirectory && seen.add(n)) out.put(JSONObject().put("n", n).put("p", path).put("i", icon))
        return out
    }

    private fun fsList(path: String, offset: Int, limit: Int): JSONObject {
        needFiles()
        val roots = JSONArray().put(JSONObject().put("n", "Internal storage").put("p", root).put("i", "phone").put("d", true))
        if (path.isEmpty()) return JSONObject().put("path", "").put("total", 1).put("entries", roots).put("roots", roots).put("places", places())
        val dir = File(path)
        val files = dir.listFiles() ?: throw IOException("Android does not allow apps to open this folder")
        val all = files.filter { !it.name.startsWith(".") && !it.name.endsWith(".part") }.sortedWith(compareBy<File> { !it.isDirectory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        val entries = JSONArray()
        for (f in all.drop(offset).take(limit.coerceIn(1, 1000))) {
            val d = f.isDirectory
            entries.put(JSONObject().put("n", f.name).put("p", f.absolutePath).put("d", d).put("s", if (d) 0 else f.length()).put("m", f.lastModified()))
        }
        return JSONObject().put("path", dir.absolutePath).put("parent", if (dir.absolutePath == root) "" else (dir.parent ?: "")).put("total", all.size)
            .put("entries", entries).put("roots", roots).put("places", places())
    }

    private fun fsRead(path: String): Reply {
        needFiles()
        val f = File(path)
        if (!f.isFile) throw IOException("File not found")
        return Reply(JSONObject().put("size", f.length()).put("mtime", f.lastModified()).put("name", f.name), stream = FileInputStream(f))
    }

    private fun fsWrite(p: JSONObject, peer: Peer): Reply {
        needFiles()
        val dir = File(p.optString("dir").ifEmpty { "$root/Download/Setu" })
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Could not create the folder on the phone")
        val name = p.optString("name", "file").replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").take(180).ifEmpty { "file" }
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var target = File(dir, name)
        var i = 1
        while (target.exists() || File(target.path + ".part").exists()) target = File(dir, "$base (${i++})$ext")
        val part = File(target.path + ".part")
        val out = FileOutputStream(part)
        val mtime = p.optLong("mtime")
        val dest = target
        return Reply(JSONObject().put("path", dest.absolutePath), sink = object : Sink {
            override fun write(b: ByteArray, off: Int, len: Int) { out.write(b, off, len) }
            override fun end(ok: Boolean): JSONObject? {
                try { out.close() } catch (e: Exception) {}
                if (!ok) { part.delete(); return null }
                if (!part.renameTo(dest)) { part.delete(); throw IOException("Could not save the file") }
                if (mtime > 0) dest.setLastModified(mtime)
                MediaScannerConnection.scanFile(this@SetuService, arrayOf(dest.absolutePath), null, null)
                eventNote("File from ${peer.name}", "${dest.name} saved in ${dir.name}")
                return JSONObject().put("path", dest.absolutePath)
            }
        })
    }

    private fun isVideo(name: String) = Regex("\\.(mp4|mkv|mov|3gp|webm)$", RegexOption.IGNORE_CASE).containsMatchIn(name)
    private fun isImage(name: String) = Regex("\\.(jpe?g|png|webp|gif|heic|bmp)$", RegexOption.IGNORE_CASE).containsMatchIn(name)

    private fun fsThumb(path: String, maxIn: Int): JSONObject {
        needFiles()
        val f = File(path)
        val max = maxIn.coerceIn(64, 512)
        val bmp: Bitmap = if (Build.VERSION.SDK_INT >= 29) {
            if (isVideo(f.name)) ThumbnailUtils.createVideoThumbnail(f, Size(max, max), null) else ThumbnailUtils.createImageThumbnail(f, Size(max, max), null)
        } else {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, o)
            var sample = 1
            while (maxOf(o.outWidth, o.outHeight) / sample > max * 2) sample *= 2
            BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: throw IOException("Not an image")
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 72, out)
        return JSONObject().put("b64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
    }

    private fun mediaRecent(limit: Int): JSONObject {
        needFiles()
        val found = ArrayList<File>()
        fun walk(d: File, depth: Int) {
            val list = d.listFiles() ?: return
            for (f in list) {
                if (f.name.startsWith(".")) continue
                if (f.isDirectory) { if (depth < 3) walk(f, depth + 1) } else if (isImage(f.name) || isVideo(f.name)) found.add(f)
            }
        }
        walk(File("$root/DCIM"), 0)
        val items = JSONArray()
        for (f in found.sortedByDescending { it.lastModified() }.take(limit.coerceIn(1, 2000)))
            items.put(JSONObject().put("p", f.absolutePath).put("n", f.name).put("s", f.length()).put("m", f.lastModified()))
        return JSONObject().put("items", items)
    }

    // ---------- SMS
    private fun needSms() { if (!has(Manifest.permission.READ_SMS)) throw IOException("Allow SMS access for Setu Remote on the phone") }

    private fun contactName(addr: String): String {
        if (addr.isEmpty() || !has(Manifest.permission.READ_CONTACTS)) return ""
        return contactCache.getOrPut(addr) {
            try {
                contentResolver.query(Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(addr)), arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
                    ?.use { if (it.moveToFirst()) it.getString(0) ?: "" else "" } ?: ""
            } catch (e: Exception) { "" }
        }
    }

    private fun smsThreads(limit: Int): JSONObject {
        needSms()
        val threads = LinkedHashMap<Long, JSONObject>()
        contentResolver.query(Telephony.Sms.CONTENT_URI, arrayOf("thread_id", "address", "body", "date", "type", "read"), null, null, "date DESC")?.use { c ->
            var rows = 0
            while (c.moveToNext() && rows++ < 3000) {
                val tid = c.getLong(0)
                val t = threads[tid]
                val unread = c.getInt(4) == 1 && c.getInt(5) == 0
                if (t == null) {
                    if (threads.size >= limit) continue
                    val addr = c.getString(1) ?: ""
                    threads[tid] = JSONObject().put("tid", tid).put("addr", addr).put("name", contactName(addr)).put("last", c.getString(2) ?: "").put("ts", c.getLong(3)).put("unread", if (unread) 1 else 0)
                } else if (unread) t.put("unread", t.optInt("unread") + 1)
            }
        }
        return JSONObject().put("items", JSONArray(threads.values.toList()))
    }

    private fun smsList(p: JSONObject): JSONObject {
        needSms()
        val items = JSONArray()
        val byThread = p.has("tid")
        val sel = if (byThread) "thread_id=?" else "address=?"
        val arg = if (byThread) p.optLong("tid").toString() else p.optString("addr")
        val limit = p.optInt("limit", 60).coerceIn(1, 300)
        contentResolver.query(Telephony.Sms.CONTENT_URI, arrayOf("_id", "body", "date", "type"), sel, arrayOf(arg), "date DESC")?.use { c ->
            var n = 0
            while (c.moveToNext() && n++ < limit) items.put(JSONObject().put("id", c.getLong(0)).put("body", c.getString(1) ?: "").put("ts", c.getLong(2)).put("out", c.getInt(3) != 1))
        }
        return JSONObject().put("items", items)
    }

    private fun smsSend(addr: String, body: String): JSONObject {
        if (!has(Manifest.permission.SEND_SMS)) throw IOException("Allow SMS access for Setu Remote on the phone")
        if (addr.isBlank() || body.isBlank()) throw IOException("Missing number or text")
        @Suppress("DEPRECATION")
        val sm: SmsManager = if (Build.VERSION.SDK_INT >= 31) getSystemService(SmsManager::class.java) else SmsManager.getDefault()
        val parts = sm.divideMessage(body)
        sm.sendMultipartTextMessage(addr, null, parts, null, null)
        return JSONObject().put("ok", true)
    }

    fun onSmsReceived(addr: String, body: String) {
        val peer = pc() ?: return
        peer.notify("sms.received", JSONObject().put("addr", addr).put("name", contactName(addr)).put("body", body).put("ts", System.currentTimeMillis()))
    }

    fun onNotif(event: String, item: JSONObject) { pc()?.let { if (it.online) it.notify(event, item) } }

    private fun setClipboard(text: String) {
        main.post { try { (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Setu", text)) } catch (e: Exception) { Log.w(TAG, "clipboard", e) } }
    }

    // ---------------------------------------------------------------- screen sharing
    private fun screenStart(peer: Peer): JSONObject {
        val r = rtc ?: throw IOException("Video is not available on this phone")
        if (capturer != null && capPeer === peer && capKind == "screen") return JSONObject().put("w", capSize.first).put("h", capSize.second).put("input", InputService.instance != null)
        stopCapture(capPeer !== peer)
        val f = CompletableFuture<Intent>()
        projWait = f
        val ask = Intent(this, ProjectionActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        main.post { try { (InputService.instance ?: this).startActivity(ask) } catch (e: Exception) { Log.w(TAG, "consent screen", e) } }
        eventNoteOnce("${peer.name} wants to see this phone", "Tap here, then tap Start now.", ask)
        // Switched on by the owner: press Start on Android's prompt for them (they may not be near the phone).
        if (autoShare) InputService.instance?.let { acc -> work.execute { Thread.sleep(700); acc.acceptCapturePrompt(20_000) } }
        val data = try { f.get(50, TimeUnit.SECONDS) } catch (e: Exception) { projWait = null; throw IOException("Unlock the phone and tap “Start now” to share its screen") }
        getSystemService(NotificationManager::class.java).cancel(99)
        val latch = CountDownLatch(1)
        var err: Exception? = null
        main.post { try { goForeground(true) } catch (e: Exception) { err = e } finally { latch.countDown() } }
        latch.await(5, TimeUnit.SECONDS)
        err?.let { throw it }
        val (w, h) = captureSize()
        val cap = ScreenCapturerAndroid(data, object : MediaProjection.Callback() { override fun onStop() { work.execute { stopCapture(true) } } })
        val src = r.factory.createVideoSource(true)
        val hlp = SurfaceTextureHelper.create("SetuCapture", r.egl.eglBaseContext)
        cap.initialize(hlp, this, src.capturerObserver)
        cap.startCapture(w, h, 24)
        val tr = r.factory.createVideoTrack("screen", src)
        capturer = cap; source = src; helper = hlp; track = tr; capPeer = peer; capSize = Pair(w, h); capKind = "screen"
        peer.setVideo(tr)
        changed()
        return JSONObject().put("w", w).put("h", h).put("input", InputService.instance != null)
    }

    // ---------------------------------------------------------------- camera
    private fun camStart(peer: Peer, facing: String): JSONObject {
        val r = rtc ?: throw IOException("Video is not available on this phone")
        if (!has(Manifest.permission.CAMERA)) throw IOException("Allow “Camera” for Setu Remote on the phone")
        val en = Camera2Enumerator(this)
        val names = en.deviceNames
        if (names.isEmpty()) throw IOException("This phone has no camera")
        val wantFront = facing == "front"
        val name = names.firstOrNull { en.isFrontFacing(it) == wantFront } ?: names[0]
        val actual = if (en.isFrontFacing(name)) "front" else "back"
        val cams = JSONArray(); for (n in names) { val f = if (en.isFrontFacing(n)) "front" else "back"; var dup = false; for (i in 0 until cams.length()) if (cams.optString(i) == f) dup = true; if (!dup) cams.put(f) }
        val switching = capKind == "camera" && capPeer === peer
        stopCapture(capPeer != null && capPeer !== peer, keepCameraScreen = switching)

        // Android only lets an app use the camera while it is on screen, so bring the camera notice to the front.
        if (CameraActivity.current == null || !switching) {
            val f = CompletableFuture<Boolean>()
            camWait = f
            val show = Intent(this, CameraActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            main.post { try { (InputService.instance ?: this).startActivity(show) } catch (e: Exception) { Log.w(TAG, "camera screen", e) } }
            try { f.get(12, TimeUnit.SECONDS) }
            catch (e: Exception) { throw IOException("The phone could not bring its camera to the front. Open Setu Remote on the phone and try again.") }
            finally { camWait = null }
        }
        camFirstFrame = false
        val cap = Camera2Capturer(this, name, object : CameraVideoCapturer.CameraEventsHandler {
            override fun onCameraError(msg: String?) { Log.w(TAG, "camera error: $msg"); camError(peer, if (msg.isNullOrBlank()) "The phone could not open its camera." else "The phone’s camera reported: $msg") }
            override fun onCameraDisconnected() { camError(peer, "Another app took the phone’s camera.") }
            override fun onCameraFreezed(msg: String?) { Log.w(TAG, "camera froze: $msg"); camError(peer, "The phone’s camera stopped responding" + if (msg.isNullOrBlank()) "." else ": $msg") }
            override fun onCameraOpening(cameraName: String?) {}
            override fun onFirstFrameAvailable() { camFirstFrame = true }
            override fun onCameraClosed() {}
        })
        val src = r.factory.createVideoSource(false)
        val hlp = SurfaceTextureHelper.create("SetuCamera", r.egl.eglBaseContext)
        cap.initialize(hlp, this, src.capturerObserver)
        cap.startCapture(1280, 720, 24)
        val tr = r.factory.createVideoTrack("camera", src)
        capturer = cap; source = src; helper = hlp; track = tr; capPeer = peer; capSize = Pair(1280, 720); capKind = "camera"; camFacing = actual
        peer.setVideo(tr)
        changed()
        // If no frame arrives in a few seconds the picture is black on the laptop; tell it why instead of staying blank.
        main.postDelayed({ if (capKind == "camera" && capPeer === peer && !camFirstFrame) camError(peer, "The phone opened its camera but sent no picture. On the phone, keep the “your laptop is using this camera” screen open and make sure the Camera permission is on.") }, 6500)
        return JSONObject().put("w", 1280).put("h", 720).put("facing", actual).put("cams", cams)
    }

    private fun camError(peer: Peer, msg: String) {
        try { if (peer.online) peer.notify("cam.error", JSONObject().put("msg", msg)) } catch (e: Exception) {}
        work.execute { if (capKind == "camera") stopCapture(false) }
    }

    /** The Stop button on the phone's camera notice. */
    fun stopCameraFromPhone() { work.execute { if (capKind == "camera") stopCapture(true) } }

    private fun eventNoteOnce(title: String, text: String, open: Intent) {
        val pi = PendingIntent.getActivity(this, 99, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, CH_MSG).setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text).setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setContentIntent(pi).setTimeoutAfter(50_000).build()
        try { getSystemService(NotificationManager::class.java).notify(99, n) } catch (e: Exception) {}
    }

    fun onProjection(data: Intent?) {
        val f = projWait
        projWait = null
        if (f == null) return
        if (data != null) f.complete(data) else f.completeExceptionally(IOException("denied"))
    }

    private fun captureSize(): Pair<Int, Int> {
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(dm)
        val scale = minOf(1f, 1600f / maxOf(dm.widthPixels, dm.heightPixels))
        return Pair(((dm.widthPixels * scale).toInt() / 2) * 2, ((dm.heightPixels * scale).toInt() / 2) * 2)
    }

    private fun resizeCapture() {
        val cap = capturer ?: return
        val s = captureSize()
        if (s == capSize) return
        capSize = s
        try { cap.changeCaptureFormat(s.first, s.second, 24) } catch (e: Exception) { Log.w(TAG, "resize", e) }
    }

    @Synchronized
    private fun stopCapture(tellPeer: Boolean, keepCameraScreen: Boolean = false) {
        val cap = capturer ?: return
        val peer = capPeer
        val wasCamera = capKind == "camera"
        capturer = null; capPeer = null; capKind = ""
        if (wasCamera && !keepCameraScreen) main.post { CameraActivity.current?.finish() }
        try { peer?.setVideo(null) } catch (e: Exception) {}
        try { cap.stopCapture() } catch (e: Exception) {}
        try { cap.dispose() } catch (e: Exception) {}
        try { track?.dispose() } catch (e: Exception) {}
        try { source?.dispose() } catch (e: Exception) {}
        try { helper?.dispose() } catch (e: Exception) {}
        track = null; source = null; helper = null
        if (tellPeer) peer?.notify("screen.ended")
        if (!keepCameraScreen) main.post { try { goForeground(false) } catch (e: Exception) {} }
        changed()
    }

    // ---------------------------------------------------------------- phone -> laptop
    fun sendUris(uris: List<Uri>) {
        work.execute {
            val peer = pc()
            if (peer == null || !peer.online) { eventNote("Could not send", "Your laptop is offline. Open Setu Remote on it and try again."); return@execute }
            var sent = 0
            try {
                for (u in uris) {
                    var name = "file"
                    var size = -1L
                    contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                        if (c.moveToFirst()) { name = c.getString(0) ?: name; if (!c.isNull(1)) size = c.getLong(1) }
                    }
                    if (size < 0) size = contentResolver.openFileDescriptor(u, "r")?.use { it.statSize } ?: -1L
                    if (size < 0) throw IOException("Could not read $name")
                    val input = contentResolver.openInputStream(u) ?: throw IOException("Could not open $name")
                    peer.push("fs.write", JSONObject().put("name", name).put("mtime", System.currentTimeMillis()), input, size)
                    sent++
                }
                eventNote("Sent to ${peer.name}", if (sent == 1) "1 file is in the laptop's Downloads/Setu folder." else "$sent files are in the laptop's Downloads/Setu folder.")
            } catch (e: Exception) {
                Log.w(TAG, "send failed", e)
                eventNote("Could not send to ${peer.name}", "${e.message ?: "Something went wrong"}${if (sent > 0) " ($sent sent before that)" else ""}")
            }
        }
    }

    fun sendText(text: String) {
        work.execute {
            val peer = pc()
            try {
                if (peer == null || !peer.online) throw IOException("Your laptop is offline")
                peer.request("text.push", JSONObject().put("text", text))
                main.post { android.widget.Toast.makeText(this, "Sent to ${peer.name}", android.widget.Toast.LENGTH_SHORT).show() }
            } catch (e: Exception) { eventNote("Could not send text", e.message ?: "Something went wrong") }
        }
    }
}
