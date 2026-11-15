package app.setu.remote

import android.Manifest
import android.app.AlertDialog
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : AppCompatActivity() {
    private val peacock = Color.parseColor("#0E6B74")
    private val ink = Color.parseColor("#15202B")
    private val ink2 = Color.parseColor("#56636F")
    private val leaf = Color.parseColor("#2E8B57")
    private lateinit var statusTitle: TextView
    private lateinit var statusSub: TextView
    private lateinit var actions: LinearLayout
    private lateinit var permList: LinearLayout
    private val refresher: () -> Unit = { runOnUiThread { refresh() } }

    private val scan = registerForActivityResult(ScanContract()) { r -> r.contents?.let { doPair(it) } }
    private val pick = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) {
            val i = Intent(this, SetuService::class.java).setAction(SetuService.ACTION_SEND)
            val clip = ClipData.newRawUri("files", uris[0])
            for (u in uris.drop(1)) clip.addItem(ClipData.Item(u))
            i.clipData = clip
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            SetuService.start(this, i)
            Toast.makeText(this, "Sending to your laptop…", Toast.LENGTH_SHORT).show()
        }
    }
    private val askPerms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh(); SetuService.instance?.refreshCaps() }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun rounded(color: Int, radius: Int, stroke: Int? = null): GradientDrawable {
        val g = GradientDrawable()
        g.setColor(color); g.cornerRadius = dp(radius).toFloat()
        if (stroke != null) g.setStroke(dp(1), stroke)
        return g
    }

    private fun text(s: String, size: Float, color: Int, bold: Boolean = false): TextView {
        val t = TextView(this)
        t.text = s; t.textSize = size; t.setTextColor(color)
        if (bold) t.setTypeface(t.typeface, Typeface.BOLD)
        return t
    }

    private fun button(label: String, primary: Boolean, onClick: () -> Unit): Button {
        val b = Button(this)
        b.text = label; b.isAllCaps = false; b.textSize = 16f
        b.setTextColor(if (primary) Color.WHITE else ink)
        b.background = if (primary) rounded(peacock, 12) else rounded(Color.WHITE, 12, Color.parseColor("#DCE2E7"))
        b.stateListAnimator = null
        b.setOnClickListener { onClick() }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50))
        lp.topMargin = dp(10)
        b.layoutParams = lp
        return b
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try { SetuService.start(this) } catch (e: Exception) {}
        val col = LinearLayout(this)
        col.orientation = LinearLayout.VERTICAL
        col.setPadding(dp(20), dp(28), dp(20), dp(32))
        col.addView(text("Setu Remote", 26f, ink, true))

        val card = LinearLayout(this)
        card.orientation = LinearLayout.VERTICAL
        card.background = rounded(Color.parseColor("#E2F0EF"), 18)
        card.setPadding(dp(18), dp(16), dp(18), dp(16))
        statusTitle = text("", 19f, ink, true)
        statusSub = text("", 15f, ink2)
        card.addView(statusTitle); card.addView(statusSub)
        val clp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        clp.topMargin = dp(16)
        col.addView(card, clp)

        actions = LinearLayout(this)
        actions.orientation = LinearLayout.VERTICAL
        col.addView(actions)

        val h = text("What your laptop can reach", 18f, ink, true)
        h.setPadding(0, dp(26), 0, dp(2))
        col.addView(h)
        col.addView(text("Turn on each one you want. You can change these any time.", 14.5f, ink2))
        permList = LinearLayout(this)
        permList.orientation = LinearLayout.VERTICAL
        col.addView(permList)

        val scroll = ScrollView(this)
        scroll.setBackgroundColor(Color.parseColor("#F4F6F7"))
        scroll.addView(col)
        setContentView(scroll)
    }

    override fun onResume() {
        super.onResume()
        SetuService.listeners.add(refresher)
        refresh()
        SetuService.instance?.refreshCaps()
        Updater.check(this, false)
    }

    override fun onPause() {
        SetuService.listeners.remove(refresher)
        super.onPause()
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun refresh() {
        val svc = SetuService.instance
        val peer = svc?.pc()
        val paired = svc?.paired == true
        when {
            svc == null -> { statusTitle.text = "Starting…"; statusSub.text = "" }
            !paired -> { statusTitle.text = "Not paired yet"; statusSub.text = "On your laptop, open Setu Remote and click “Pair a phone”. Then scan the QR code here." }
            peer != null && peer.online -> { statusTitle.text = "Connected to ${peer.name}"; statusSub.text = "Your laptop can reach this phone, and you can control the laptop from here." }
            else -> { statusTitle.text = "Waiting for your laptop"; statusSub.text = if (svc.relayOpen) "Open Setu Remote on the laptop. It connects by itself." else "No connection yet. Check Wi-Fi or mobile data." }
        }
        actions.removeAllViews()
        if (paired) {
            actions.addView(button("Control laptop", true) { startActivity(Intent(this, RemoteActivity::class.java)) })
            actions.addView(button("Send files or photos to laptop", false) { pick.launch(arrayOf("*/*")) })
            actions.addView(button("Send text to laptop", false) { promptText() })
        }
        actions.addView(button(if (paired) "Pair with another laptop (scan QR)" else "Pair with laptop (scan QR)", !paired) {
            scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the QR code shown by Setu Remote on your laptop").setBeepEnabled(false).setOrientationLocked(false))
        })
        actions.addView(button("Paste a pairing code instead", false) { promptCode() })
        if (paired) actions.addView(button("Unpair", false) {
            AlertDialog.Builder(this).setMessage("Unpair this phone from your laptop?").setPositiveButton("Unpair") { _, _ -> svc?.unpairAll() }.setNegativeButton("Cancel", null).show()
        })

        permList.removeAllViews()
        val a11y = isAccessibilityOn()
        perm("Setu Input", "Lets the laptop tap, swipe and type while you share the screen.", a11y) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        val files = if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else has(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        perm("All files", "Browse, copy and import photos, videos and documents.", files) {
            if (Build.VERSION.SDK_INT >= 30) {
                try { startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))) }
                catch (e: Exception) { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
            } else askPerms.launch(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE))
        }
        perm("SMS and contacts", "Read and send texts from the laptop, with names shown.", has(Manifest.permission.READ_SMS) && has(Manifest.permission.SEND_SMS)) {
            askPerms.launch(arrayOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_CONTACTS))
        }
        perm("Chat notifications", "See WhatsApp and other chat notifications on the laptop and reply.", NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        if (Build.VERSION.SDK_INT >= 33) perm("Show notifications", "Tells you when a file or text arrives.", has(Manifest.permission.POST_NOTIFICATIONS)) {
            askPerms.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        }
        perm("Camera", "Lets the laptop look through this phone’s camera. The phone shows a notice while it is on.", has(Manifest.permission.CAMERA)) {
            askPerms.launch(arrayOf(Manifest.permission.CAMERA))
        }
        perm("Unlock from laptop", if (Unlocker.blocked(this)) "The saved PIN or pattern did not work. Tap to save it again." else if (!a11y) "Needs Setu Input (the first item) switched on." else "Keeps your PIN or pattern on this phone, encrypted, and enters it when your laptop asks.", Unlocker.has(this) && !Unlocker.blocked(this)) { promptUnlock() }
        perm("Start sharing without a tap", "Presses Start on Android’s screen-sharing prompt for you, so the laptop can see this phone when you are away from it.", svc?.autoShare == true) {
            val s = SetuService.instance
            if (s != null) {
                if (s.autoShare) { s.autoShare = false; refresh() }
                else AlertDialog.Builder(this).setTitle("Start sharing without a tap?").setMessage("Your paired laptop will be able to see and control this phone without anyone touching it. Turn this on only if the laptop is yours alone.")
                    .setPositiveButton("Turn on") { _, _ -> s.autoShare = true; refresh() }.setNegativeButton("Cancel", null).show()
            }
        }
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        perm("No battery limits", "Keeps the phone reachable when the screen is off.", pm.isIgnoringBatteryOptimizations(packageName)) {
            try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
            catch (e: Exception) { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        }
        if (Build.VERSION.SDK_INT >= 26) perm("App updates", "Lets Setu Remote install its own new versions.", packageManager.canRequestPackageInstalls()) {
            try { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) } catch (e: Exception) {}
        }
        val note = text("If a switch in Settings is greyed out: open App info for Setu Remote, tap the three dots and choose “Allow restricted settings”.", 13.5f, ink2)
        note.setPadding(0, dp(14), 0, 0)
        permList.addView(note)

        val ver = text("Version ${Updater.versionName(this)}" + (if (Updater.status.isNotEmpty()) " · ${Updater.status}" else ""), 13.5f, ink2)
        ver.setPadding(0, dp(22), 0, 0)
        permList.addView(ver)
        if (Updater.confirm != null) permList.addView(button("Install update", true) { Updater.resumeConfirm(this) })
        else permList.addView(button("Check for updates", false) { Updater.check(this, true) })
    }

    private fun isAccessibilityOn(): Boolean {
        val on = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = ComponentName(this, InputService::class.java)
        return on.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    private fun perm(title: String, desc: String, on: Boolean, open: () -> Unit) {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.background = rounded(Color.WHITE, 14)
        row.setPadding(dp(14), dp(12), dp(12), dp(12))
        val txt = LinearLayout(this)
        txt.orientation = LinearLayout.VERTICAL
        txt.addView(text(title, 16f, ink, true))
        txt.addView(text(desc, 13.5f, ink2))
        row.addView(txt, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (on) {
            val ok = text("On", 15f, leaf, true)
            ok.setPadding(dp(12), 0, dp(6), 0)
            row.addView(ok)
            row.setOnClickListener { open() }
        } else {
            val b = Button(this)
            b.text = "Allow"; b.isAllCaps = false; b.textSize = 15f
            b.setTextColor(Color.WHITE); b.background = rounded(peacock, 10); b.stateListAnimator = null
            b.minWidth = 0; b.minimumWidth = 0
            b.setPadding(dp(16), 0, dp(16), 0)
            b.setOnClickListener { open() }
            val blp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40))
            blp.leftMargin = dp(10)
            row.addView(b, blp)
        }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.topMargin = dp(10)
        permList.addView(row, lp)
    }

    private fun input(hint: String, lines: Int): EditText {
        val e = EditText(this)
        e.hint = hint; e.minLines = lines; e.gravity = Gravity.TOP
        return e
    }

    private fun wrap(v: View): View {
        val box = LinearLayout(this)
        box.setPadding(dp(20), dp(8), dp(20), 0)
        box.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return box
    }

    private fun toast(s: String) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show() }

    private fun promptUnlock() {
        val e = input("PIN, or pattern dots in order", 1)
        e.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        val hint = text("PIN or password: type it as you do on the lock screen.\nPattern: number the dots 1 to 9, left to right from the top row, and type them in the order you draw, for example 14789.\n\nAnyone using your paired laptop will be able to unlock this phone. If it ever fails once, it switches itself off until you save it again.", 13.5f, ink2)
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(dp(20), dp(8), dp(20), 0)
        box.addView(e); box.addView(hint)
        val b = AlertDialog.Builder(this).setTitle("Unlock from laptop").setView(box)
            .setPositiveButton("Save as PIN or password") { _, _ -> val v = e.text.toString(); if (v.isNotEmpty()) { Unlocker.save(this, if (v.all { it.isDigit() }) "pin" else "password", v); toast("Saved"); SetuService.instance?.changed(); refresh() } }
            .setNeutralButton("Save as pattern") { _, _ -> val v = e.text.toString(); if (v.length >= 4 && v.all { it in '1'..'9' }) { Unlocker.save(this, "pattern", v); toast("Saved"); SetuService.instance?.changed(); refresh() } else toast("A pattern is 4 or more dots, each a digit from 1 to 9") }
        if (Unlocker.has(this)) b.setNegativeButton("Turn off") { _, _ -> Unlocker.clear(this); SetuService.instance?.changed(); refresh() } else b.setNegativeButton("Cancel", null)
        b.show()
    }

    private fun promptCode() {
        val e = input("Pairing code (starts with setu1.)", 3)
        AlertDialog.Builder(this).setTitle("Paste pairing code").setView(wrap(e))
            .setPositiveButton("Pair") { _, _ -> doPair(e.text.toString()) }.setNegativeButton("Cancel", null).show()
    }

    private fun promptText() {
        val e = input("Type or paste here", 4)
        AlertDialog.Builder(this).setTitle("Send text to laptop").setView(wrap(e))
            .setPositiveButton("Send") { _, _ -> val t = e.text.toString(); if (t.isNotBlank()) SetuService.instance?.sendText(t) }.setNegativeButton("Cancel", null).show()
    }

    private fun doPair(code: String) {
        val svc = SetuService.instance
        if (svc == null) { Toast.makeText(this, "Still starting. Try again in a moment.", Toast.LENGTH_SHORT).show(); return }
        try { svc.pair(code); Toast.makeText(this, "Paired. Connecting to your laptop…", Toast.LENGTH_SHORT).show() }
        catch (e: Exception) { Toast.makeText(this, e.message ?: "That code did not work", Toast.LENGTH_LONG).show() }
        refresh()
    }
}
