package app.setu.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (msgs.isEmpty()) return
        val addr = msgs[0].originatingAddress ?: ""
        val body = msgs.joinToString("") { it.messageBody ?: "" }
        SetuService.instance?.onSmsReceived(addr, body)
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val paired = ctx.getSharedPreferences("setu", Context.MODE_PRIVATE).getString("pairings", "[]") != "[]"
        if (paired) try { SetuService.start(ctx) } catch (e: Exception) {}
    }
}
