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

    private fun typeText(s: String) {
        if (s.isEmpty()) return
        val n = focused() ?: return
        if (n.isPassword) return   // Android hides password text from apps, so appending would wipe the field
        setText(n, current(n) + s)
    }
}
