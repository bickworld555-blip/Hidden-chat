package io.github.bickworld555.hiddenchat

import android.content.Context
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.NativeFetchHandler
import io.github.bickworld555.hiddenchat.core.crypto.CryptoCores
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The SINGLE foreground relay connection owned by the native UI (migration checklist item 1), when the socket-owner
 * sub-flag is on. Unlike [NativeSendSocket] (write-only, `relay.background`), this connects ONLINE — the same
 * subprotocols the WebView's RealtimeClient uses (`relay.auth.<token>, relay.v1, relay.client.N`, i.e. WITHOUT
 * `relay.background`) — so the server shows the user online through it and routes live delivery here.
 *
 * It owns the pieces the WebView socket used to:
 *  - RECEIVE + DECRYPT + PERSIST + ACK incoming messages itself, through the already-verified native path
 *    ([NativeFetchHandler] → [NativeDelivery.persist] seal-before-ack → `message:delivered` + `queue:ack`). It decrypts
 *    exactly once (the Double Ratchet is stateful — only ONE consumer may advance it), so the WebView must NOT also
 *    receive while this owns the socket; the WebView picks the plaintext up from the native inbox without re-decrypting.
 *  - PRESENCE: sends `client:state {visibility, idle}` so the account reads as online, and a periodic `client:ping`.
 *  - SEND: outgoing `message:send` ([sendMessage]).
 *  - Every OTHER incoming frame (calls, receipts, typing, reactions, presence updates, errors) is handed to [sink]
 *    for the WebView to keep handling — native does not yet own those features (later checklist items).
 *
 * SAFETY: gated behind the default-off `hm_native_ui/socket_owner` pref AND [NativeFlag.active] (a native core must be
 * installed to decrypt). It is INERT until that sub-flag is turned on, which must only happen after two-real-device
 * verification — receive/decrypt/ack is crypto-critical. Reconnects with backoff while wanted.
 */
object NativeForegroundSocket {
    /** Where non-message frames go while this owns the socket — wired to the WebView so its feature logic still runs. */
    fun interface FrameSink {
        fun forward(frameJson: String)
    }

    private const val PING_INTERVAL_MS = 20_000L

    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "native-fg-socket").apply { isDaemon = true }
    }

    @Volatile private var sink: FrameSink? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var open = false
    @Volatile private var wanted = false
    @Volatile private var reconnectScheduled = false
    @Volatile private var visibility = "visible"
    @Volatile private var idle = false
    private var attempt = 0
    private var pingTask: ScheduledFuture<*>? = null
    private var appContext: Context? = null
    private var meUser: String = ""
    private var meDevice: String = ""

    /** Whether this device is configured to let native own the foreground socket (sub-flag on AND a native core). */
    fun owns(context: Context): Boolean =
        context.getSharedPreferences("hm_native_ui", Context.MODE_PRIVATE).getBoolean("socket_owner", false) &&
            NativeFlag.active(context)

    /** Where to hand non-message frames; set by the plugin so the WebView keeps handling calls/receipts/typing/etc. */
    fun setSink(sink: FrameSink?) { this.sink = sink }

    /** Whether the native socket is connected and online right now. */
    fun isOnline(): Boolean = open && socket != null

    /**
     * Opens the online socket (idempotent). A no-op unless this device owns the socket. `meUser`/`meDevice` are read
     * from the session for the decrypt path. Called once the WebView has confirmed its own socket is closed.
     */
    @Synchronized
    fun start(context: Context) {
        val app = context.applicationContext
        if (!owns(app)) return
        val session = RelaySession.read(app) ?: return
        val user = session.userId ?: return
        val device = RelaySession.deviceId(app) ?: return
        appContext = app
        meUser = user
        meDevice = device
        wanted = true
        if (socket == null) connect()
    }

    @Synchronized
    private fun connect() {
        if (socket != null) return
        val context = appContext ?: return
        val session = RelaySession.read(context) ?: return
        val url = session.websocketUrl() ?: return
        val token = session.token ?: return
        val request = Request.Builder()
            .url(url)
            // Online subprotocols — no relay.background, so the server marks the account online through this socket.
            .header("Sec-WebSocket-Protocol", "relay.auth.$token, relay.v1, ${ClientVersion.SUBPROTOCOL}")
            .build()
        socket = client.newWebSocket(request, Listener())
    }

    /** Updates presence (the native Activity's lifecycle maps to visibility/idle) and pushes it if connected. */
    @Synchronized
    fun setPresence(visible: Boolean, idle: Boolean) {
        this.visibility = if (visible) "visible" else "hidden"
        this.idle = idle
        if (open) sendPresence()
    }

    /** Puts a (natively sealed) outgoing message on the wire as message:send; true when the socket accepted it. */
    @Synchronized
    fun sendMessage(message: org.json.JSONObject): Boolean {
        val current = socket ?: return false
        if (!open) return false
        return try {
            current.send(org.json.JSONObject().put("type", "message:send").put("message", message).toString())
        } catch (ignored: Throwable) {
            false
        }
    }

    /** Forwards a raw frame (JSON) the WebView produced over this socket (used when send routing is wired later). */
    @Synchronized
    fun sendRawFrame(frameJson: String): Boolean {
        val current = socket ?: return false
        if (!open) return false
        return try { current.send(frameJson); true } catch (ignored: Throwable) { false }
    }

    /** Closes the socket and stops reconnecting (idempotent); called when the native UI is no longer foreground. */
    @Synchronized
    fun stop() {
        wanted = false
        open = false
        pingTask?.cancel(false); pingTask = null
        try { socket?.close(1000, "native ui backgrounded") } catch (ignored: Throwable) { /* already gone */ }
        socket = null
    }

    private fun sendPresence() {
        try { socket?.send(Json.stringify(Json.obj("type" to "client:state", "visibility" to visibility, "idle" to idle))) } catch (ignored: Throwable) { }
    }

    @Synchronized
    private fun onOpened(webSocket: WebSocket) {
        if (webSocket != socket) return
        open = true
        attempt = 0
        sendPresence()
        pingTask?.cancel(false)
        pingTask = scheduler.scheduleWithFixedDelay({ ping() }, PING_INTERVAL_MS, PING_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun ping() {
        synchronized(this) {
            if (!open) return
            try { socket?.send(Json.stringify(Json.obj("type" to "client:ping"))) } catch (ignored: Throwable) { }
        }
    }

    private fun onFrame(text: String) {
        val event = try { Json.map(Json.parse(text)) } catch (malformed: Exception) { null } ?: return
        when (Json.string(event["type"])) {
            "pong", "connection:ready" -> { /* liveness / handshake — nothing to forward */ }
            "message:new", "group:message" -> onIncomingMessage(event)
            // Every other frame (call:*, message:ack, message:read, typing:*, message:reaction, presence:*, error,
            // xmpp:wake, …) stays the WebView's job for now — hand it over untouched.
            else -> sink?.forward(text)
        }
    }

    // Decrypt ONCE, durably persist, THEN acknowledge — never ack what was not kept (the ratchet already advanced).
    // No system notification here: the user is in the foreground native UI, which shows the message from NativeStore.
    private fun onIncomingMessage(event: Map<String, Any?>) {
        val core = CryptoCores.current() ?: return
        val context = appContext ?: return
        val delivery = NativeFetchHandler.handle(core, meUser, meDevice, event) ?: return
        if (!delivery.opened) { sink?.forward(Json.stringify(event)); return } // can't decrypt → leave to the app, not acked
        if (!NativeDelivery.persist(context, event, delivery)) return
        sendRawFrame(Json.stringify(Json.obj("type" to "message:delivered", "messageIds" to listOf(delivery.messageId))))
        sendRawFrame(Json.stringify(Json.obj("type" to "queue:ack", "messageIds" to listOf(delivery.messageId), "eventIds" to emptyList<String>())))
    }

    @Synchronized
    private fun drop(webSocket: WebSocket) {
        if (webSocket != socket) return
        open = false
        socket = null
        pingTask?.cancel(false); pingTask = null
        if (wanted) scheduleReconnect()
    }

    @Synchronized
    private fun scheduleReconnect() {
        if (reconnectScheduled || !wanted) return
        reconnectScheduled = true
        val delay = minOf(30_000L, 1_000L shl minOf(attempt, 5))
        attempt++
        scheduler.schedule({ reconnectNow() }, delay, TimeUnit.MILLISECONDS)
    }

    @Synchronized
    private fun reconnectNow() {
        reconnectScheduled = false
        if (wanted && socket == null) connect()
    }

    private class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = onOpened(webSocket)
        override fun onMessage(webSocket: WebSocket, text: String) {
            synchronized(NativeForegroundSocket) { if (webSocket != socket) return }
            onFrame(text)
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = drop(webSocket)
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = drop(webSocket)
    }
}
