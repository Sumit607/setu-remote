package app.setu.remote

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * "Unlock from laptop". The phone's PIN, pattern or password is kept on the phone only, encrypted with a key
 * that never leaves Android's keystore. When the paired laptop asks, Setu Input wakes the screen and enters it
 * on the lock screen the way a finger would.
 *
 * One wrong attempt switches the feature off until the secret is saved again, so a stale PIN can never run the
 * phone into its "too many attempts" lockout.
 */
object Unlocker {
    private const val TAG = "SetuUnlock"
    private const val ALIAS = "setu_unlock"
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("setu", Context.MODE_PRIVATE)

    fun has(ctx: Context): Boolean = prefs(ctx).contains("unlock_c")
    fun kind(ctx: Context): String = prefs(ctx).getString("unlock_kind", "") ?: ""
    fun blocked(ctx: Context): Boolean = prefs(ctx).getBoolean("unlock_blocked", false)
    fun ready(ctx: Context): Boolean = has(ctx) && !blocked(ctx) && InputService.instance != null

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return gen.generateKey()
    }

    /** [kind] is "pin", "pattern" (dots numbered 1-9 from the top-left) or "password". */
    fun save(ctx: Context, kind: String, secret: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(secret.toByteArray(Charsets.UTF_8))
        prefs(ctx).edit().putString("unlock_c", Base64.encodeToString(c.iv + ct, Base64.NO_WRAP)).putString("unlock_kind", kind).putBoolean("unlock_blocked", false).apply()
    }

    fun clear(ctx: Context) { prefs(ctx).edit().remove("unlock_c").remove("unlock_kind").remove("unlock_blocked").apply() }

    private fun load(ctx: Context): String? {
        val raw = prefs(ctx).getString("unlock_c", null) ?: return null
        return try {
            val b = Base64.decode(raw, Base64.NO_WRAP)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
            String(c.doFinal(b, 12, b.size - 12), Charsets.UTF_8)
        } catch (e: Exception) { Log.w(TAG, "stored secret unreadable", e); null }
    }

    fun locked(ctx: Context): Boolean {
        val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        return km.isKeyguardLocked || !pm.isInteractive
    }

    private fun waitUnlocked(km: KeyguardManager, ms: Long): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) { if (!km.isKeyguardLocked) return true; Thread.sleep(150) }
        return !km.isKeyguardLocked
    }

    /** Blocks for a few seconds; call from a worker thread. */
    @Synchronized
    fun unlock(ctx: Context): JSONObject {
        val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val done = JSONObject().put("ok", true)
        if (!km.isKeyguardLocked && pm.isInteractive) return done.put("already", true)
        val acc = InputService.instance ?: throw IOException("Turn on “Setu Input” on the phone to unlock it from the laptop")

        // 1. wake the screen
        if (!pm.isInteractive) {
            @Suppress("DEPRECATION")
            val wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE, "setu:unlock")
            try { wl.acquire(4000) } catch (e: Exception) { Log.w(TAG, "wake", e) }
            var i = 0
            while (!pm.isInteractive && i++ < 20) Thread.sleep(100)
            Thread.sleep(500)
        }
        if (!km.isKeyguardLocked) return done
        if (!km.isDeviceSecure) {            // swipe-only lock screen
            acc.swipeUp(); if (waitUnlocked(km, 2500)) return done
            acc.swipeUp(); if (waitUnlocked(km, 2500)) return done
            throw IOException("The phone did not open after swiping up")
        }
        val secret = load(ctx) ?: throw IOException("Save the phone’s PIN or pattern in the phone app first (Unlock from laptop)")
        if (blocked(ctx)) throw IOException("The saved PIN or pattern did not work last time. Save it again in the phone app.")
        val kind = kind(ctx)

        // 2. bring up the keypad, 3. enter the secret
        var shown = acc.lockInputVisible(kind)
        var tries = 0
        while (!shown && tries++ < 3) { acc.swipeUp(); Thread.sleep(900); shown = acc.lockInputVisible(kind) }
        if (!shown) throw IOException("Could not find the phone’s lock screen keypad. ${acc.describeScreen()}")
        val entered = when (kind) {
            "pattern" -> acc.drawPattern(secret)
            "password" -> acc.enterPassword(secret)
            else -> acc.enterPin(secret)
        }
        if (!entered) throw IOException("Could not enter the ${if (kind == "pattern") "pattern" else "PIN"} on the lock screen. ${acc.describeScreen()}")
        if (waitUnlocked(km, 1200)) return done
        acc.pressLockEnter()
        if (waitUnlocked(km, 4000)) return done

        prefs(ctx).edit().putBoolean("unlock_blocked", true).apply()
        SetuService.instance?.changed()
        throw IOException("The phone stayed locked, so the saved PIN or pattern is probably wrong. Save it again in the phone app.")
    }
}
