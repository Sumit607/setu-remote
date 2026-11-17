package app.setu.remote

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

/** "Setu Input": taps, swipes and types on behalf of the paired laptop while the screen is being shared. */
class InputService : AccessibilityService() {
    companion object { @Volatile var instance: InputService? = null }

    override fun onServiceConnected() {
        instance = this
        SetuService.instance?.let { it.refreshCaps(); it.changed() }
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        SetuService.instance?.let { it.refreshCaps(); it.changed() }
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    private fun size(): Pair<Float, Float> {
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(dm)
        return Pair(dm.widthPixels.toFloat(), dm.heightPixels.toFloat())
    }

    private fun stroke(points: List<Pair<Float, Float>>, ms: Long) {
        if (points.isEmpty()) return
        val (w, h) = size()
        val path = Path()
        var first = true
        for ((nx, ny) in points) {
            val x = (nx * w).coerceIn(0f, w - 1f)
            val y = (ny * h).coerceIn(0f, h - 1f)
            if (first) { path.moveTo(x, y); first = false } else path.lineTo(x, y)
        }
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms.coerceIn(30L, 8000L))).build()
        dispatchGesture(g, null, null)
    }

    fun perform(ev: JSONObject) {
        try {
            when (ev.optString("k")) {
                "tap" -> stroke(listOf(Pair(ev.optDouble("x").toFloat(), ev.optDouble("y").toFloat())), 60)
                "gesture" -> {
                    val pts = ev.optJSONArray("pts") ?: return
                    val list = ArrayList<Pair<Float, Float>>()
                    for (i in 0 until pts.length()) { val p = pts.optJSONArray(i) ?: continue; list.add(Pair(p.optDouble(0).toFloat(), p.optDouble(1).toFloat())) }
                    stroke(list, ev.optLong("ms", 300))
                }
                "scroll" -> {
                    val x = ev.optDouble("x", 0.5).toFloat()
                    val y = ev.optDouble("y", 0.5).toFloat()
                    val dy = ev.optDouble("dy", 1.0).toFloat().coerceIn(-3f, 3f)
                    stroke(listOf(Pair(x, y), Pair(x, (y - dy * 0.18f).coerceIn(0.02f, 0.98f))), 220)
                }
                "key" -> key(ev.optString("a"))
                "text" -> typeText(ev.optString("s"))
            }
        } catch (e: Exception) { Log.w(TAG, "input ${ev.optString("k")}", e) }
    }

    private fun key(a: String) {
        when (a) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "quicksettings" -> if (Build.VERSION.SDK_INT >= 31) performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS) else performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "lock" -> if (Build.VERSION.SDK_INT >= 28) performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
            "volup", "voldown" -> (getSystemService(Context.AUDIO_SERVICE) as AudioManager)
                .adjustStreamVolume(AudioManager.STREAM_MUSIC, if (a == "volup") AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
            "enter" -> focused()?.let { n ->
                if (Build.VERSION.SDK_INT >= 30) n.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) else setText(n, current(n) + "\n")
            }
            "backspace", "delete" -> focused()?.let { n -> val t = current(n); if (t.isNotEmpty()) setText(n, t.dropLast(1)) }
        }
    }

    private fun focused(): AccessibilityNodeInfo? = try { findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } catch (e: Exception) { null }

    private fun current(n: AccessibilityNodeInfo): String {
        if (Build.VERSION.SDK_INT >= 26 && n.isShowingHintText) return ""
        return n.text?.toString() ?: ""
    }

    private fun setText(n: AccessibilityNodeInfo, s: String) {
        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, s)
        n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    // ------------------------------------------------------------ lock screen (see Unlock.kt)
    private fun roots(): List<AccessibilityNodeInfo> {
        val out = ArrayList<AccessibilityNodeInfo>()
        try { for (w in windows) w.root?.let { out.add(it) } } catch (e: Exception) {}
        if (out.isEmpty()) try { rootInActiveWindow?.let { out.add(it) } } catch (e: Exception) {}
        return out
    }

    private fun find(n: AccessibilityNodeInfo?, depth: Int, test: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (n == null || depth > 40) return null
        if (test(n)) return n
        for (i in 0 until n.childCount) { val hit = find(try { n.getChild(i) } catch (e: Exception) { null }, depth + 1, test); if (hit != null) return hit }
        return null
    }

    private fun findAny(test: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        for (r in roots()) { val hit = find(r, 0, test); if (hit != null) return hit }
        return null
    }

    private fun label(n: AccessibilityNodeInfo): String = (n.text?.toString()?.trim().takeUnless { it.isNullOrEmpty() } ?: n.contentDescription?.toString()?.trim() ?: "")
    private fun idOf(n: AccessibilityNodeInfo): String = n.viewIdResourceName?.substringAfterLast('/') ?: ""

    /** Performs one stroke and waits until Android has finished it. */
    private fun strokePx(points: List<Pair<Float, Float>>, ms: Long): Boolean {
        if (points.isEmpty()) return false
        val path = Path()
        points.forEachIndexed { i, (x, y) -> if (i == 0) path.moveTo(x, y) else path.lineTo(x, y) }
        if (points.size == 1) path.lineTo(points[0].first + 1f, points[0].second + 1f)
        val latch = java.util.concurrent.CountDownLatch(1)
        var ok = false
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build()
        val sent = dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { ok = true; latch.countDown() }
            override fun onCancelled(d: GestureDescription?) { latch.countDown() }
        }, null)
        if (!sent) return false
        latch.await(ms + 1500, java.util.concurrent.TimeUnit.MILLISECONDS)
        return ok
    }

    /** Presses a node: the proper click if it (or a parent) offers one, otherwise a tap at its centre. */
    private fun press(n: AccessibilityNodeInfo): Boolean {
        var c: AccessibilityNodeInfo? = n
        var hops = 0
        while (c != null && hops++ < 4) { if (c.isClickable && c.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true; c = c.parent }
        val r = android.graphics.Rect(); n.getBoundsInScreen(r)
        if (r.isEmpty) return false
        return strokePx(listOf(Pair(r.exactCenterX(), r.exactCenterY())), 60)
    }

    fun swipeUp() { val (w, h) = size(); strokePx(listOf(Pair(w / 2f, h * 0.86f), Pair(w / 2f, h * 0.55f), Pair(w / 2f, h * 0.28f)), 240) }

    private fun digitKey(d: Char): AccessibilityNodeInfo? {
        val s = d.toString()
        return findAny { n -> val id = idOf(n); (id == "key$s" || id == "digit$s" || id == "num$s" || id == "btn_$s") || (label(n) == s && n.className?.toString()?.contains("EditText") != true) }
    }

    private fun patternView(): AccessibilityNodeInfo? = findAny { n -> val id = idOf(n).lowercase(); val cls = n.className?.toString() ?: ""; cls.contains("LockPatternView") || id.contains("lockpattern") || id == "pattern_view" }
    private fun passwordField(): AccessibilityNodeInfo? = findAny { n -> n.isEditable || (n.isPassword && n.className?.toString()?.contains("EditText") == true) }

    fun lockInputVisible(kind: String): Boolean = when (kind) {
        "pattern" -> patternView() != null
        "password" -> passwordField() != null
        else -> digitKey('5') != null && digitKey('0') != null
    }

    fun enterPin(pin: String): Boolean {
        for (ch in pin) {
            val k = digitKey(ch) ?: return false
            if (!press(k)) return false
            Thread.sleep(130)
        }
        return true
    }

    fun pressLockEnter() {
        val k = findAny { n -> val id = idOf(n).lowercase(); val l = label(n).lowercase(); id == "key_enter" || id == "enter" || id == "ok" || l == "enter" || l == "ok" || l == "done" || l == "confirm" } ?: return
        press(k)
    }

    /** [dots] like "14789": the pattern's dots in order, numbered 1-9 from the top-left. */
    fun drawPattern(dots: String): Boolean {
        val v = patternView() ?: return false
        val r = android.graphics.Rect(); v.getBoundsInScreen(r)
        if (r.isEmpty) return false
        val pts = ArrayList<Pair<Float, Float>>()
        for (ch in dots) {
            val i = ch - '1'
            if (i !in 0..8) return false
            pts.add(Pair(r.left + (i % 3 + 0.5f) * r.width() / 3f, r.top + (i / 3 + 0.5f) * r.height() / 3f))
        }
        if (pts.size < 2) return false
        return strokePx(pts, (160L * pts.size).coerceIn(400L, 2500L))
    }

    fun enterPassword(pw: String): Boolean {
        val f = passwordField() ?: return false
        f.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle(); args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, pw)
        if (!f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false
        Thread.sleep(200)
        if (Build.VERSION.SDK_INT >= 30) f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        return true
    }

    /** A short list of what is on screen, sent to the laptop when the keypad cannot be found, to help fix it. */
    fun describeScreen(): String {
        val seen = LinkedHashSet<String>()
        for (r in roots()) find(r, 0) { n -> val l = label(n); val id = idOf(n); if (l.isNotEmpty() && l.length <= 14) seen.add(l) else if (id.isNotEmpty() && n.isClickable) seen.add("#$id"); seen.size >= 30 }
        return if (seen.isEmpty()) "(The lock screen did not show its buttons to the app.)" else "(On screen: ${seen.joinToString(", ")})"
    }

    // ------------------------------------------------------------ "Start sharing without a tap"
    /**
     * Presses "Start" on Android's own screen-sharing prompt, choosing "Entire screen" first where Android asks.
     * Only runs when the owner switched this on in the app, and only for the prompt that names this app.
     */
    fun acceptCapturePrompt(timeoutMs: Long) {
        val end = System.currentTimeMillis() + timeoutMs
        val entire = Regex("(?i).*(entire|whole) screen.*")
        val single = Regex("(?i).*(single|one) app.*")
        val go = Regex("(?i)^(start now|start|share screen|share|start recording|start sharing|next|allow|continue)$")
        var pickedEntire = false
        while (System.currentTimeMillis() < end && SetuService.instance?.waitingForConsent == true) {
            try {
                val dialog = roots().firstOrNull { r -> val pkg = r.packageName?.toString() ?: ""; pkg != packageName && find(r, 0) { label(it).contains("Setu Remote") } != null }
                if (dialog != null) {
                    if (!pickedEntire) {
                        val opt = find(dialog, 0) { entire.matches(label(it)) }
                        val spinner = find(dialog, 0) { single.matches(label(it)) }
                        if (opt != null && (opt.isClickable || opt.parent?.isClickable == true) && spinner == null) { press(opt); pickedEntire = true; Thread.sleep(400); continue }
                        if (spinner != null) { press(spinner); Thread.sleep(500); findAny { entire.matches(label(it)) }?.let { press(it); pickedEntire = true }; Thread.sleep(500); continue }
                    }
                    val btn = find(dialog, 0) { idOf(it) == "button1" && it.isEnabled } ?: find(dialog, 0) { it.isClickable && go.matches(label(it)) }
                    if (btn != null) { press(btn); Thread.sleep(700); continue }
                }
            } catch (e: Exception) { Log.w(TAG, "capture prompt", e) }
            Thread.sleep(300)
        }
    }

    private fun typeText(s: String) {
        if (s.isEmpty()) return
        val n = focused() ?: return
        if (n.isPassword) return   // Android hides password text from apps, so appending would wipe the field
        setText(n, current(n) + s)
    }
}
