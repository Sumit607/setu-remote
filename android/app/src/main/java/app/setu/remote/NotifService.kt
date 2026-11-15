package app.setu.remote

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/** Mirrors chat notifications to the laptop and sends replies through the notification's own reply action. */
class NotifService : NotificationListenerService() {
    companion object { @Volatile var instance: NotifService? = null }

    private val items = ConcurrentHashMap<String, StatusBarNotification>()

    override fun onListenerConnected() {
        instance = this
        try { activeNotifications?.forEach { if (wanted(it)) items[it.key] = it } } catch (e: Exception) { Log.w(TAG, "notifications", e) }
        SetuService.instance?.let { it.refreshCaps(); it.changed() }
    }

    override fun onListenerDisconnected() { instance = null; SetuService.instance?.refreshCaps() }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null || !wanted(sbn)) return
        items[sbn.key] = sbn
        SetuService.instance?.onNotif("notif.posted", toJson(sbn))
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        if (sbn == null) return
        if (items.remove(sbn.key) != null) SetuService.instance?.onNotif("notif.removed", JSONObject().put("key", sbn.key))
    }

    private fun replyAction(n: Notification): Notification.Action? {
        val actions = n.actions ?: return null
        for (a in actions) { val ris = a.remoteInputs ?: continue; if (ris.any { it.allowFreeFormInput }) return a }
        return null
    }

    private fun wanted(sbn: StatusBarNotification): Boolean {
        val n = sbn.notification ?: return false
        if (sbn.packageName == packageName || sbn.isOngoing) return false
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return false
        if (n.extras?.getCharSequence(Notification.EXTRA_TEXT).isNullOrBlank()) return false
        return n.category == Notification.CATEGORY_MESSAGE || replyAction(n) != null
    }

    private fun toJson(sbn: StatusBarNotification): JSONObject {
        val n = sbn.notification
        val app = try { packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString() } catch (e: Exception) { sbn.packageName.substringAfterLast('.') }
        return JSONObject().put("key", sbn.key).put("pkg", sbn.packageName).put("app", app)
            .put("title", n.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: app)
            .put("text", n.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "")
            .put("ts", sbn.postTime).put("reply", replyAction(n) != null)
    }

    fun list(): JSONArray {
        val out = JSONArray()
        for (s in items.values.sortedByDescending { it.postTime }.take(60)) out.put(toJson(s))
        return out
    }

    fun reply(key: String, text: String): JSONObject {
        val sbn = items[key] ?: throw IOException("That notification is no longer on the phone")
        val a = replyAction(sbn.notification) ?: throw IOException("This app does not allow replies from its notifications")
        val intent = Intent()
        val results = Bundle()
        for (ri in a.remoteInputs) results.putCharSequence(ri.resultKey, text)
        RemoteInput.addResultsToIntent(a.remoteInputs, intent, results)
        try { a.actionIntent.send(this, 0, intent) } catch (e: Exception) { throw IOException("The app refused the reply") }
        return JSONObject().put("ok", true)
    }
}
