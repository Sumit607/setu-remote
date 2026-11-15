package app.setu.remote

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Wire format: see /protocol/PROTOCOL.md. This file mirrors desktop/src/core/core.js (answerer side).

const val TAG = "Setu"

object Proto {
    const val PREFIX = "setu1."
    const val DEFAULT_RELAY_URL = "https://onehmelzuguildygncdr.supabase.co"
    const val DEFAULT_RELAY_KEY = "sb_publishable_-Z_QvDKwSUphuI0bGZpWRw_gjqA3cqF"
    private val rnd = SecureRandom()
    fun rand(n: Int): ByteArray = ByteArray(n).also { rnd.nextBytes(it) }
    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.DEFAULT)
    fun b64u(b: ByteArray): String = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    fun unb64u(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    fun mid(): String = hex(rand(8))

    fun decodePairing(text: String): JSONObject {
        val i = text.indexOf(PREFIX)
        if (i < 0) throw IllegalArgumentException("That is not a Setu pairing code")
        val body = text.substring(i + PREFIX.length).takeWhile { !it.isWhitespace() && it != '&' }
        val o = JSONObject(String(unb64u(body), Charsets.UTF_8))
        if (!o.has("s") || !o.has("id")) throw IllegalArgumentException("Pairing code is incomplete")
        return o
    }

    fun encodePairing(o: JSONObject): String = PREFIX + b64u(o.toString().toByteArray(Charsets.UTF_8))

    /** Cloud relay websocket URL for a pairing, or null when the pairing is same-Wi-Fi only. */
    fun cloudUrl(pairing: JSONObject): String? {
        val url: String
        val key: String
        if (!pairing.has("relay")) { url = DEFAULT_RELAY_URL; key = DEFAULT_RELAY_KEY }
        else {
            val r = pairing.optJSONObject("relay") ?: return null
            url = r.optString("u"); key = r.optString("k")
            if (url.isEmpty()) return null
        }
        return url.replaceFirst("http", "ws").trimEnd('/') + "/realtime/v1/websocket?apikey=" + java.net.URLEncoder.encode(key, "UTF-8") + "&vsn=1.0.0"
    }
}

class Keys(secret: String) {
    val room: String
    private val key: ByteArray

    init {
        val s = Proto.unb64u(secret)
        val md = MessageDigest.getInstance("SHA-256")
        room = Proto.hex(md.digest("setu-room-v1".toByteArray(Charsets.UTF_8) + s)).substring(0, 32)
        key = md.digest("setu-key-v1".toByteArray(Charsets.UTF_8) + s)
    }

    fun seal(o: JSONObject): JSONObject {
        val n = Proto.rand(12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, n))
        c.updateAAD(room.toByteArray(Charsets.UTF_8))
        return JSONObject().put("n", Proto.b64(n)).put("c", Proto.b64(c.doFinal(o.toString().toByteArray(Charsets.UTF_8))))
    }

    fun open(env: JSONObject?): JSONObject? {
        if (env == null) return null
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, Proto.unb64(env.getString("n"))))
            c.updateAAD(room.toByteArray(Charsets.UTF_8))
            JSONObject(String(c.doFinal(Proto.unb64(env.getString("c"))), Charsets.UTF_8))
        } catch (e: Exception) { null }
    }
}

/** Phoenix-channels client: the protocol of Supabase Realtime and of the PC app's LAN relay. */
class Relay(
    private val http: OkHttpClient, val url: String, topic: String, val kind: String,
    private val exec: ScheduledExecutorService, private val canConnect: () -> Boolean,
    private val onMsg: (JSONObject, Relay) -> Unit, private val onUp: (Relay) -> Unit,
) : WebSocketListener() {
    private val topic = "realtime:$topic"
    private var ws: WebSocket? = null
    private var ref = 0
    private var joinRef = ""
    private var retry = 0
    private var stopped = false
    private var hb: ScheduledFuture<*>? = null
    private var again: ScheduledFuture<*>? = null
    @Volatile var open = false
    var lastPing = 0L
    val pingEvery = if (kind == "lan") 10_000L else 45_000L

    fun connect() {
        if (stopped) return
        open = false
        if (!canConnect()) { scheduleRetry(); return }
        try { ws = http.newWebSocket(Request.Builder().url(url).build(), this) }
        catch (e: Exception) { ws = null; scheduleRetry() }
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        exec.execute {
            if (webSocket !== ws) return@execute
            joinRef = (++ref).toString()
            val cfg = JSONObject().put("broadcast", JSONObject().put("self", false).put("ack", false)).put("presence", JSONObject().put("key", "")).put("private", false)
            webSocket.send(JSONObject().put("topic", topic).put("event", "phx_join").put("ref", joinRef).put("payload", JSONObject().put("config", cfg)).toString())
            hb?.cancel(false)
            hb = exec.scheduleAtFixedRate({
                ws?.send(JSONObject().put("topic", "phoenix").put("event", "heartbeat").put("payload", JSONObject()).put("ref", (++ref).toString()).toString())
            }, 25, 25, TimeUnit.SECONDS)
        }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        exec.execute {
            if (webSocket !== ws) return@execute
            val m = try { JSONObject(text) } catch (e: Exception) { return@execute }
            when (m.optString("event")) {
                "broadcast" -> {
                    val p = m.optJSONObject("payload")
                    if (p != null && p.optString("event") == "sig") p.optJSONObject("payload")?.let { onMsg(it, this) }
                }
                "phx_reply" -> if (m.optString("ref") == joinRef) {
                    if (m.optJSONObject("payload")?.optString("status") == "ok") { retry = 0; open = true; onUp(this) }
                    else webSocket.close(1000, null)
                }
                "phx_error", "phx_close" -> if (m.optString("topic") == topic) webSocket.cancel()
            }
        }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { down(webSocket) }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { down(webSocket) }

    private fun down(w: WebSocket) {
        exec.execute {
            if (w !== ws) return@execute
            open = false; hb?.cancel(false); ws = null
            scheduleRetry()
        }
    }

    private fun scheduleRetry() {
        if (stopped) return
        again?.cancel(false)
        val cap = if (kind == "lan") 60_000L else 20_000L
        val delay = minOf(cap, 1000L shl minOf(retry++, 6))
        again = exec.schedule({ connect() }, delay, TimeUnit.MILLISECONDS)
    }

    /** Reconnect right away, e.g. after the network changed. */
    fun kick() {
        exec.execute {
            if (open || stopped) return@execute
            again?.cancel(false); retry = 0
            ws?.cancel(); ws = null
            connect()
        }
    }

    fun send(payload: JSONObject): Boolean {
        if (!open) return false
        val frame = JSONObject().put("topic", topic).put("event", "broadcast").put("ref", (++ref).toString())
            .put("payload", JSONObject().put("type", "broadcast").put("event", "sig").put("payload", payload))
        return ws?.send(frame.toString()) ?: false
    }

    fun close() {
        stopped = true; open = false
        hb?.cancel(false); again?.cancel(false)
        try { ws?.close(1000, null) } catch (e: Exception) {}
        ws = null
    }
}

class Rtc(ctx: Context) {
    val egl: EglBase = EglBase.create()
    val factory: PeerConnectionFactory

    init {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx.applicationContext).createInitializationOptions())
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
    }
}

interface Sink {
    fun write(b: ByteArray, off: Int, len: Int)
    /** Called once. Returns extra fields for the confirmation (for example the final path). */
    fun end(ok: Boolean): JSONObject?
}

class Reply(val r: JSONObject = JSONObject(), val stream: InputStream? = null, val sink: Sink? = null)

interface Api {
    fun handle(method: String, p: JSONObject, peer: Peer): Reply
    fun onInput(ev: JSONObject, peer: Peer)
    fun onVideoEnded(peer: Peer)
    fun caps(): JSONObject
}

private class Recv(val sink: Sink, val size: Long, val notify: Boolean) { var got = 0L; var dead = false }

open class SdpAdapter : SdpObserver {
    override fun onCreateSuccess(desc: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) { Log.w(TAG, "sdp create failed: $error") }
    override fun onSetFailure(error: String?) { Log.w(TAG, "sdp set failed: $error") }
}

/** One pairing = one room. Holds the relays and the peers (normally just the laptop). */
class Room(
    private val ctx: Context, val pairing: JSONObject, private val selfId: String, private val selfName: String,
    val api: Api, val rtc: Rtc, private val http: OkHttpClient, private val onChange: () -> Unit,
) {
    val exec: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    val pool: ExecutorService = Executors.newCachedThreadPool()
    val bulkExec: ExecutorService = Executors.newSingleThreadExecutor()
    val keys = Keys(pairing.getString("s"))
    val peers = ConcurrentHashMap<String, Peer>()
    private val boot = Proto.hex(Proto.rand(4))
    private val relays = CopyOnWriteArrayList<Relay>()
    private val seen = LinkedHashSet<String>()
    private var ticker: ScheduledFuture<*>? = null

    val relayOpen: Boolean get() = relays.any { it.open }

    fun start() {
        exec.execute {
            val lan = pairing.optJSONArray("lan") ?: JSONArray()
            for (i in 0 until lan.length()) addLan(lan.optString(i))
            Proto.cloudUrl(pairing)?.let { addRelay(it, "cloud") }
            ticker = exec.scheduleAtFixedRate({ try { tick() } catch (e: Exception) { Log.w(TAG, "tick", e) } }, 3, 3, TimeUnit.SECONDS)
        }
    }

    private fun onWifi(): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    private fun addLan(host: String) { if (host.isNotEmpty()) addRelay("ws://$host/relay?vsn=1.0.0", "lan") }

    private fun addRelay(url: String, kind: String) {
        if (relays.any { it.url == url }) return
        val canConnect: () -> Boolean = if (kind == "lan") ({ onWifi() }) else ({ true })
        val r = Relay(http, url, "setu-" + keys.room, kind, exec, canConnect, { p, rel -> onRelay(p, rel) }, { rel -> announce("hello", rel); onChange() })
        relays.add(r); r.connect()
    }

    fun networkChanged() { for (r in relays) r.kick() }

    private fun wire(obj: JSONObject, only: Relay? = null): Boolean {
        val env = JSONObject().put("e", keys.seal(obj))
        var sent = false
        for (r in relays) { if (only != null && r !== only) continue; if (r.send(env)) sent = true }
        return sent
    }

    fun send(to: String, obj: JSONObject): Boolean = wire(obj.put("from", selfId).put("to", to).put("mid", Proto.mid()))

    private fun announce(t: String, rel: Relay?) {
        rel?.lastPing = System.currentTimeMillis()
        wire(JSONObject().put("t", t).put("from", selfId).put("to", "*").put("mid", Proto.mid()).put("name", selfName).put("role", "phone")
            .put("caps", api.caps()).put("x", JSONObject()).put("boot", boot), rel)
    }

    fun announceNow() { exec.execute { for (r in relays) if (r.open) announce("ping", r) } }

    private fun tick() {
        val now = System.currentTimeMillis()
        var changed = false
        for (r in relays) if (r.open && now - r.lastPing >= r.pingEvery) announce("ping", r)
        for (p in peers.values) {
            val on = now - p.seenLan < 25_000 || now - p.seenCloud < 110_000
            if (on != p.online) { p.online = on; changed = true; if (!on) p.linkDown() }
        }
        if (changed) onChange()
    }

    private fun onRelay(payload: JSONObject, rel: Relay) {
        val m = keys.open(payload.optJSONObject("e")) ?: return
        val from = m.optString("from")
        if (from.isEmpty() || from == selfId) return
        val to = m.optString("to")
        if (to != "*" && to != selfId) return
        val p = peers.getOrPut(from) { Peer(this, from) }
        val now = System.currentTimeMillis()
        if (rel.kind == "lan") p.seenLan = now else p.seenCloud = now
        val mid = m.optString("mid")
        if (!seen.add(mid)) return
        if (seen.size > 600) { val iter = seen.iterator(); iter.next(); iter.remove() }
        var changed = !p.online
        p.online = true
        when (m.optString("t")) {
            "hello", "ping" -> {
                val name = m.optString("name", p.name)
                val role = m.optString("role")
                if (name != p.name || role != p.role) { p.name = name; p.role = role; changed = true }
                val b = m.optString("boot")
                if (b.isNotEmpty() && p.boot.isNotEmpty() && b != p.boot) p.linkDown()
                if (b.isNotEmpty()) p.boot = b
                if (role == "pc") updateLan(m.optJSONObject("x")?.optJSONArray("lan"))
                if (m.optString("t") == "hello") announce("ping", rel)
            }
            "bye" -> { p.seenLan = 0; p.seenCloud = 0; p.online = false; p.linkDown(); changed = true }
            "rpc" -> m.optJSONObject("d")?.let { p.onRpc(it, true) }
            else -> p.onSignal(m)
        }
        if (changed) onChange()
    }

    /** The laptop tells us its current Wi-Fi addresses in every hello, so a changed IP heals itself. */
    private fun updateLan(lan: JSONArray?) {
        if (lan == null || lan.length() == 0) return
        val hosts = (0 until lan.length()).map { lan.optString(it) }.filter { it.isNotEmpty() }
        val old = pairing.optJSONArray("lan")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
        if (hosts == old) return
        pairing.put("lan", JSONArray(hosts))
        for (r in relays.toList()) if (r.kind == "lan" && hosts.none { r.url == "ws://$it/relay?vsn=1.0.0" }) { r.close(); relays.remove(r) }
        for (h in hosts) addLan(h)
        onChange()
    }

    fun pc(): Peer? = peers.values.firstOrNull { it.role == "pc" && it.online } ?: peers.values.firstOrNull { it.role == "pc" }

    fun close() {
        exec.execute {
            wire(JSONObject().put("t", "bye").put("from", selfId).put("to", "*").put("mid", Proto.mid()))
            ticker?.cancel(false)
            for (p in peers.values) p.linkDown()
            for (r in relays) r.close()
            exec.shutdown(); pool.shutdown(); bulkExec.shutdown()
        }
    }
}

class Peer(val room: Room, val id: String) {
    @Volatile var name = id
    @Volatile var role = ""
    @Volatile var online = false
    @Volatile var linkUp = false
    var seenLan = 0L
    var seenCloud = 0L
    var boot = ""

    private var pc: PeerConnection? = null
    private var ctl: DataChannel? = null
    private var bulk: DataChannel? = null
    private var input: DataChannel? = null
    private var videoTx: RtpTransceiver? = null
    private var sid = ""
    private var remoteSet = false
    private val iceQ = ArrayList<IceCandidate>()
    private val rid = AtomicInteger()
    private val xidGen = AtomicInteger()
    private val pending = ConcurrentHashMap<Int, CompletableFuture<JSONObject>>()
    private val recv = ConcurrentHashMap<Long, Recv>()
    private val doneWait = ConcurrentHashMap<Long, CompletableFuture<JSONObject>>()
    @Volatile private var linkWait: CompletableFuture<Boolean>? = null
    @Volatile private var localTrack: VideoTrack? = null
    private var discCheck: ScheduledFuture<*>? = null

    // ---------- RPC
    private fun rpcSend(d: JSONObject, linkOnly: Boolean = false, relayOnly: Boolean = false): Boolean {
        val c = ctl
        if (!relayOnly && c != null && c.state() == DataChannel.State.OPEN) {
            return c.send(DataChannel.Buffer(ByteBuffer.wrap(d.toString().toByteArray(Charsets.UTF_8)), false))
        }
        if (linkOnly) return false
        return room.send(id, JSONObject().put("t", "rpc").put("d", d))
    }

    /** Blocking request to the other device. Call from a worker thread. */
    fun request(m: String, p: JSONObject = JSONObject(), timeoutMs: Long = 15_000, link: Boolean = false): JSONObject {
        if (link) ensureLink()
        val n = rid.incrementAndGet()
        val f = CompletableFuture<JSONObject>()
        pending[n] = f
        if (!rpcSend(JSONObject().put("k", "req").put("id", n).put("m", m).put("p", p), link)) {
            pending.remove(n); throw IOException(if (online) "Not connected" else "$name is offline")
        }
        val d = try { f.get(timeoutMs, TimeUnit.MILLISECONDS) } catch (e: Exception) { pending.remove(n); throw IOException("No reply from $name") }
        if (!d.optBoolean("ok")) throw IOException(d.optString("e", "Failed"))
        return d.optJSONObject("r") ?: JSONObject()
    }

    fun notify(m: String, p: JSONObject = JSONObject()): Boolean = rpcSend(JSONObject().put("k", "evt").put("m", m).put("p", p))

    fun onRpc(d: JSONObject, viaRelay: Boolean) {
        when (d.optString("k")) {
            "res" -> pending.remove(d.optInt("id"))?.complete(d)
            "evt" -> if (d.optString("m") == "xfer.done") {
                val p = d.optJSONObject("p") ?: JSONObject()
                doneWait.remove(p.optLong("xid"))?.complete(p)
            }
            "req" -> room.pool.execute {
                val p = d.optJSONObject("p") ?: JSONObject()
                val xid = p.optLong("xid")
                val reply: Reply
                try {
                    reply = room.api.handle(d.optString("m"), p, this)
                    if (reply.sink != null) recv[xid] = Recv(reply.sink, if (p.has("size")) p.optLong("size") else -1L, true)
                    rpcSend(JSONObject().put("k", "res").put("id", d.optInt("id")).put("ok", true).put("r", reply.r), false, viaRelay)
                } catch (e: Throwable) {
                    Log.w(TAG, "rpc ${d.optString("m")} failed", e)
                    rpcSend(JSONObject().put("k", "res").put("id", d.optInt("id")).put("ok", false).put("e", e.message ?: e.javaClass.simpleName), false, viaRelay)
                    return@execute
                }
                if (reply.stream != null) try { pump(xid, reply.stream, null) } catch (e: Exception) { Log.w(TAG, "stream failed", e) }
            }
        }
    }

    // ---------- bulk frames: [u32 transfer id][u8 flag 0=data 1=end 2=error][payload]
    private fun frame(xid: Long, flag: Int, data: ByteArray?, len: Int): DataChannel.Buffer {
        val b = ByteBuffer.allocate(5 + len)
        b.putInt(xid.toInt()); b.put(flag.toByte())
        if (data != null && len > 0) b.put(data, 0, len)
        b.flip()
        return DataChannel.Buffer(b, true)
    }

    private fun drain(dc: DataChannel) {
        while (dc.bufferedAmount() > HIGH) {
            if (dc.state() != DataChannel.State.OPEN) throw IOException("Connection lost")
            Thread.sleep(8)
        }
        if (dc.state() != DataChannel.State.OPEN) throw IOException("Connection lost")
    }

    private fun pump(xid: Long, input: InputStream, progress: ((Long) -> Unit)?) {
        val dc = bulk ?: throw IOException("Connection lost")
        val buf = ByteArray(CHUNK)
        var sent = 0L
        try {
            input.use {
                while (true) {
                    val n = it.read(buf)
                    if (n < 0) break
                    if (n == 0) continue
                    drain(dc)
                    if (!dc.send(frame(xid, 0, buf, n))) throw IOException("Connection lost")
                    sent += n; progress?.invoke(sent)
                }
            }
            dc.send(frame(xid, 1, null, 0))
        } catch (e: Exception) {
            try { val msg = (e.message ?: "Failed").toByteArray(Charsets.UTF_8); dc.send(frame(xid, 2, msg, msg.size)) } catch (e2: Exception) {}
            throw e
        }
    }

    private fun onBulk(b: ByteArray) {
        if (b.size < 5) return
        val xid = ByteBuffer.wrap(b, 0, 4).int.toLong() and 0xffffffffL
        val flag = b[4].toInt()
        room.bulkExec.execute {
            val r = recv[xid] ?: return@execute
            if (r.dead) return@execute
            try {
                if (flag == 0) { r.got += b.size - 5; r.sink.write(b, 5, b.size - 5); return@execute }
                recv.remove(xid)
                val ok = flag == 1 && (r.size < 0 || r.got == r.size)
                val err = if (ok) null else if (flag == 2) String(b, 5, b.size - 5, Charsets.UTF_8) else "File arrived incomplete"
                val fin = try { r.sink.end(ok) } catch (e: Exception) { null }
                if (r.notify) {
                    val p = fin ?: JSONObject()
                    p.put("xid", xid).put("ok", ok); if (err != null) p.put("e", err)
                    notify("xfer.done", p)
                }
            } catch (e: Exception) { failRecv(xid, r, e.message ?: "Could not save the file") }
        }
    }

    private fun failRecv(xid: Long, r: Recv, why: String) {
        if (r.dead) return
        r.dead = true; recv.remove(xid)
        try { r.sink.end(false) } catch (e: Exception) {}
        if (r.notify) notify("xfer.done", JSONObject().put("xid", xid).put("ok", false).put("e", why))
    }

    /** Blocking upload of a stream to the other device (for example fs.write on the laptop). */
    fun push(m: String, p: JSONObject, input: InputStream, size: Long, progress: ((Long) -> Unit)? = null): JSONObject {
        ensureLink()
        val xid = xidGen.incrementAndGet().toLong()
        val info = request(m, p.put("size", size).put("xid", xid), 20_000, true)
        val fin = CompletableFuture<JSONObject>()
        doneWait[xid] = fin
        try {
            pump(xid, input, progress)
            val d = try { fin.get(60, TimeUnit.SECONDS) } catch (e: Exception) { throw IOException("No confirmation from $name") }
            if (!d.optBoolean("ok")) throw IOException(d.optString("e", "The laptop could not save the file"))
            if (d.has("path")) info.put("path", d.optString("path"))
            return info
        } finally { doneWait.remove(xid) }
    }

    // ---------- link (WebRTC). The laptop always makes the offer; we ask for one when we need the link.
    fun ensureLink() {
        if (linkUp) return
        if (!online) throw IOException("$name is offline")
        var w = linkWait
        if (w == null) {
            w = CompletableFuture()
            linkWait = w
            room.send(id, JSONObject().put("t", "link-req"))
        }
        try { w.get(25, TimeUnit.SECONDS) }
        catch (e: Exception) { if (linkWait === w) linkWait = null; throw IOException("Could not open a direct connection to $name") }
    }

    fun onSignal(m: JSONObject) {
        try {
            when (m.optString("t")) {
                "offer" -> onOffer(m)
                "ice" -> {
                    val conn = pc ?: return
                    if (m.optString("sid") != sid) return
                    val c = m.optJSONObject("c") ?: return
                    val cand = IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.optString("candidate"))
                    if (remoteSet) conn.addIceCandidate(cand) else iceQ.add(cand)
                }
                "link-close" -> if (m.optString("sid") == sid) linkDown()
            }
        } catch (e: Exception) { Log.w(TAG, "signal ${m.optString("t")}", e) }
    }

    private fun iceServers(arr: JSONArray?): List<PeerConnection.IceServer> {
        val out = ArrayList<PeerConnection.IceServer>()
        if (arr != null) for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val urls = ArrayList<String>()
            val u = o.opt("urls")
            if (u is JSONArray) for (j in 0 until u.length()) urls.add(u.optString(j)) else if (u is String) urls.add(u)
            if (urls.isEmpty()) continue
            val b = PeerConnection.IceServer.builder(urls)
            if (o.has("username")) b.setUsername(o.optString("username"))
            if (o.has("credential")) b.setPassword(o.optString("credential"))
            out.add(b.createIceServer())
        }
        if (out.isEmpty()) out.add(PeerConnection.IceServer.builder(listOf("stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302")).createIceServer())
        return out
    }

    private fun onOffer(m: JSONObject) {
        closePc()
        val mySid = m.optString("sid")
        sid = mySid
        val cfg = PeerConnection.RTCConfiguration(iceServers(m.optJSONArray("ice")))
        cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        cfg.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        val conn = room.rtc.factory.createPeerConnection(cfg, object : PeerConnection.Observer {
            override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
            override fun onAddStream(s: MediaStream?) {}
            override fun onRemoveStream(s: MediaStream?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver?, streams: Array<out MediaStream>?) {}
            override fun onIceCandidate(c: IceCandidate?) {
                if (c == null) return
                room.exec.execute {
                    if (sid == mySid) room.send(id, JSONObject().put("t", "ice").put("sid", mySid)
                        .put("c", JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)))
                }
            }
            override fun onDataChannel(dc: DataChannel?) { if (dc != null) room.exec.execute { if (sid == mySid) bind(dc, mySid) } }
            override fun onConnectionChange(s: PeerConnection.PeerConnectionState?) {
                room.exec.execute {
                    if (sid != mySid) return@execute
                    discCheck?.cancel(false)
                    if (s == PeerConnection.PeerConnectionState.FAILED) linkDown()
                    else if (s == PeerConnection.PeerConnectionState.DISCONNECTED) discCheck = room.exec.schedule({
                        if (sid == mySid && pc?.connectionState() != PeerConnection.PeerConnectionState.CONNECTED) linkDown()
                    }, 8, TimeUnit.SECONDS)
                }
            }
        }) ?: throw IOException("Could not create the connection")
        pc = conn
        conn.setRemoteDescription(object : SdpAdapter() {
            override fun onSetSuccess() {
                room.exec.execute {
                    if (sid != mySid || pc !== conn) return@execute
                    remoteSet = true
                    for (t in conn.transceivers) if (t.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) {
                        t.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV)
                        videoTx = t
                        localTrack?.let { tr -> t.sender.setTrack(tr, false) }
                    }
                    conn.createAnswer(object : SdpAdapter() {
                        override fun onCreateSuccess(desc: SessionDescription?) {
                            if (desc == null) return
                            conn.setLocalDescription(object : SdpAdapter() {
                                override fun onSetSuccess() {
                                    room.exec.execute {
                                        if (sid != mySid) return@execute
                                        room.send(id, JSONObject().put("t", "answer").put("sid", mySid).put("sdp", desc.description))
                                        for (c in iceQ) conn.addIceCandidate(c)
                                        iceQ.clear()
                                    }
                                }
                            }, desc)
                        }
                    }, MediaConstraints())
                }
            }
        }, SessionDescription(SessionDescription.Type.OFFER, m.optString("sdp")))
    }

    private fun bind(dc: DataChannel, mySid: String) {
        val label = dc.label()
        when (label) { "ctl" -> ctl = dc; "bulk" -> bulk = dc; "input" -> input = dc; else -> return }
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) {}
            override fun onStateChange() {
                room.exec.execute {
                    if (sid != mySid) return@execute
                    checkUp()
                    if (label == "ctl" && dc.state() == DataChannel.State.CLOSED) linkDown()
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer?) {
                if (buffer == null) return
                val b = ByteArray(buffer.data.remaining())
                buffer.data.get(b)
                try {
                    when (label) {
                        "ctl" -> onRpc(JSONObject(String(b, Charsets.UTF_8)), false)
                        "bulk" -> onBulk(b)
                        "input" -> room.api.onInput(JSONObject(String(b, Charsets.UTF_8)), this@Peer)
                    }
                } catch (e: Exception) { Log.w(TAG, "channel $label", e) }
            }
        })
        checkUp()
    }

    private fun checkUp() {
        if (linkUp) return
        val all = listOf(ctl, bulk, input)
        if (all.all { it != null && it.state() == DataChannel.State.OPEN }) {
            linkUp = true
            linkWait?.complete(true); linkWait = null
        }
    }

    /** Runs on the room thread (or any non-WebRTC thread). */
    fun linkDown() {
        if (pc == null && linkWait == null) return
        closePc()
        linkWait?.completeExceptionally(IOException("Connection lost")); linkWait = null
        for ((xid, r) in recv.entries.toList()) failRecv(xid, r, "Connection lost")
        for ((xid, w) in doneWait.entries.toList()) { doneWait.remove(xid); w.complete(JSONObject().put("ok", false).put("e", "Connection lost")) }
        if (localTrack != null) { localTrack = null; room.api.onVideoEnded(this) }
    }

    private fun closePc() {
        val conn = pc
        pc = null; linkUp = false; remoteSet = false; sid = ""; videoTx = null
        iceQ.clear(); discCheck?.cancel(false)
        val chans = listOf(ctl, bulk, input)
        ctl = null; bulk = null; input = null
        if (conn != null) room.pool.execute {
            for (c in chans) try { c?.unregisterObserver(); c?.dispose() } catch (e: Exception) {}
            try { conn.dispose() } catch (e: Exception) { Log.w(TAG, "dispose", e) }
        }
    }

    fun setVideo(track: VideoTrack?) {
        localTrack = track
        room.exec.execute { try { videoTx?.sender?.setTrack(track, false) } catch (e: Exception) { Log.w(TAG, "setTrack", e) } }
    }

    companion object {
        const val CHUNK = 48 * 1024
        const val HIGH = 4L * 1024 * 1024
    }
}
