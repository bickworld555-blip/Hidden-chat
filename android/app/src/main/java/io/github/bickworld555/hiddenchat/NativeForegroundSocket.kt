package io.github.bickworld555.hiddenchat

import android.content.Context
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.NativeFetchHandler
import io.github.bickworld555.hiddenchat.core.NativeInbox
import io.github.bickworld555.hiddenchat.core.crypto.CryptoCores
import io.github.bickworld555.hiddenchat.core.store.NativeStore
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
    private const val REACTION_PREFIX = "reaction:" // the sealed reaction's inner is {c:"reaction:<emoji>"} (web src/e2e)

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
        if (!owns(app)) { android.util.Log.w("NFS", "start: not owner (socket_owner off or no native core)"); return }
        val session = RelaySession.read(app) ?: run { android.util.Log.w("NFS", "start: no session"); return }
        val user = session.userId ?: run { android.util.Log.w("NFS", "start: no userId"); return }
        val device = RelaySession.deviceId(app) ?: run { android.util.Log.w("NFS", "start: no deviceId"); return }
        appContext = app
        meUser = user
        meDevice = device
        wanted = true
        android.util.Log.i("NFS", "start: owner ok, user=$user device=$device socket=${socket != null}")
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
        android.util.Log.i("NFS", "connect: opening online socket to $url")
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
        NativeTyping.clear() // the native UI is going away; drop any lingering "typing…" so it can't reappear stale
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
        android.util.Log.i("NFS", "onOpened: online socket OPEN")
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
            // Checklist item 4: a direct peer's "typing…"/"recording…" — reflect it in the native UI (NativeTyping) AND
            // keep forwarding so the WebView's state stays consistent for when it resumes. Groups are not shown natively
            // yet (they carry groupId); the WebView still handles those.
            "presence:typing" -> {
                val from = Json.string(event["userId"])
                if (from != null && Json.string(event["groupId"]) == null) {
                    val active = (event["active"] as? Boolean) == true
                    NativeTyping.note(from, if (!active) null else if (Json.string(event["kind"]) == "recording") "recording" else "typing")
                }
                sink?.forward(text)
            }
            // Checklist item 4 (read-receipt ticks): a delivery/read receipt for one of OUR sent messages. Raise its
            // status in the native store (ticks move forward only) AND forward so the WebView stays consistent.
            "message:status" -> {
                val ctx = appContext
                val id = Json.string(event["messageId"])
                val status = Json.string(event["status"])
                if (ctx != null && id != null && status != null) io.github.bickworld555.hiddenchat.core.store.NativeStore.get(ctx)?.raiseStatusById(id, status)
                sink?.forward(text)
            }
            "message:played" -> {
                val ctx = appContext
                val id = Json.string(event["messageId"])
                if (ctx != null && id != null) io.github.bickworld555.hiddenchat.core.store.NativeStore.get(ctx)?.raiseStatusById(id, "read")
                sink?.forward(text)
            }
            "message:reaction" -> onReaction(event)
            "message:edited" -> onEdited(event)
            "message:deleted" -> onDeleted(event)
            "chat:disappearing" -> {
                // Item 4 disappearing: the peer set (or cleared) this chat's timer; record it so our next send carries `ex`.
                val peer = Json.string(event["peerId"])
                val seconds = Json.safeInteger(event["seconds"])
                if (peer != null && seconds != null) appContext?.let { NativeStore.get(it)?.setDisappearSeconds(peer, seconds) }
                sink?.forward(text)
            }
            // Every other frame (call:*, message:ack, message:read, message:reaction, presence:update, error,
            // xmpp:wake, …) stays the WebView's job for now — hand it over untouched.
            else -> sink?.forward(text)
        }
    }

    // Decrypt ONCE, durably persist, THEN acknowledge — never ack what was not kept (the ratchet already advanced).
    // No system notification here: the user is in the foreground native UI, which shows the message from NativeStore.
    private fun onIncomingMessage(event: Map<String, Any?>) {
        val core = CryptoCores.current() ?: run { android.util.Log.w("NFS", "incoming: no core"); return }
        val context = appContext ?: return
        val delivery = NativeFetchHandler.handle(core, meUser, meDevice, event) ?: return
        android.util.Log.i("NFS", "incoming id=${delivery.messageId} opened=${delivery.opened} err=${delivery.error}")
        if (!delivery.opened) { sink?.forward(Json.stringify(event)); return } // can't decrypt → leave to the app, not acked
        // updateChatList=true: native owns the socket now, so it must refresh the chat-list preview/time/unread itself
        // (the WebView mirror is suspended). The conversation + unread already update via addMessage inside persist.
        if (!NativeDelivery.persist(context, event, delivery, updateChatList = true)) { android.util.Log.w("NFS", "incoming: persist failed"); return }
        // A message arriving clears the sender's "typing…" in the native UI (store.js does the same on message:new).
        if (delivery.groupId == null) NativeTyping.note(delivery.senderId, null)
        sendRawFrame(Json.stringify(Json.obj("type" to "message:delivered", "messageIds" to listOf(delivery.messageId))))
        sendRawFrame(Json.stringify(Json.obj("type" to "queue:ack", "messageIds" to listOf(delivery.messageId), "eventIds" to emptyList<String>())))
    }

    // Item 4 reactions (RECEIVE): a reaction is an envelope sealed with the SAME ratchet as a message (web sealDirect),
    // so opening it advances the ratchet — exactly ONE consumer may. Native (the socket owner) opens it here, applies
    // it, and forwards the OPENED emoji so the WebView never re-opens it. Since native and the WebView share ONE core
    // when native E2E is active, there is no ratchet desync even if an open is attempted twice (the second fails).
    private fun onReaction(event: Map<String, Any?>) {
        val context = appContext ?: return
        val messageId = Json.string(event["messageId"]) ?: return
        val reactorId = Json.string(event["userId"]) ?: return
        val raw = event["emoji"]
        val opened: String? = when {
            raw == null -> null // removal
            raw is String && NativeInbox.isEnvelope(raw) -> {
                val core = CryptoCores.current() ?: run { sink?.forward(Json.stringify(event)); return } // no core: leave to the WebView
                try {
                    val plaintext = NativeInbox.openDirect(core, meUser, meDevice, reactorId, raw)
                    val c = Json.string(Json.map(Json.parse(plaintext))?.get("c"))
                    if (c != null && c.startsWith(REACTION_PREFIX)) c.substring(REACTION_PREFIX.length).ifEmpty { null } else null
                } catch (failed: Throwable) {
                    android.util.Log.w("NFS", "reaction open failed id=$messageId: ${failed.message}")
                    sink?.forward(Json.stringify(event)); return // could not open: leave the raw reaction to the WebView
                }
            }
            raw is String -> raw // already plain (a short emoji, not sealed)
            else -> null
        }
        NativeStore.get(context)?.addReaction(messageId, reactorId, opened)
        // Forward the OPENED reaction (plain emoji or null) so the WebView applies it without decrypting again.
        sink?.forward(Json.stringify(Json.obj("type" to "message:reaction", "messageId" to messageId, "userId" to reactorId, "emoji" to opened)))
    }

    // Item 4 edit: message:edited carries the SEALED new text (ratchet-advancing), like a message. A PEER's edit is
    // opened here (exactly once; native owns the socket) and applied; the opened text is forwarded so the WebView does
    // not re-open it. My OWN edit echo is sealed to the peer + my OTHER devices, never this one, so it cannot be opened
    // here — it was already applied locally at send time, so it is just forwarded for the WebView.
    private fun onEdited(event: Map<String, Any?>) {
        val messageId = Json.string(event["messageId"]) ?: return
        val senderId = Json.string(event["senderId"]) ?: return
        val content = event["content"]
        if (senderId != meUser && content is String && NativeInbox.isEnvelope(content)) {
            val core = CryptoCores.current()
            if (core != null) {
                try {
                    val plaintext = NativeInbox.openDirect(core, meUser, meDevice, senderId, content)
                    val newText = Json.string(Json.map(Json.parse(plaintext))?.get("c"))
                    if (newText != null) {
                        appContext?.let { NativeStore.get(it)?.editMessageText(messageId, MessagePreview.of(newText)) }
                        // Forward the OPENED edit so the WebView applies it without decrypting again.
                        sink?.forward(Json.stringify(Json.obj("type" to "message:edited", "messageId" to messageId, "senderId" to senderId, "content" to newText, "editedAt" to event["editedAt"])))
                        return
                    }
                } catch (failed: Throwable) {
                    android.util.Log.w("NFS", "edit open failed id=$messageId: ${failed.message}")
                }
            }
        }
        sink?.forward(Json.stringify(event)) // own edit, or unopenable: leave to the WebView (native already applied own edits)
    }

    // Item 4 delete-for-everyone: no ciphertext — just render the placeholder natively and forward for the WebView.
    private fun onDeleted(event: Map<String, Any?>) {
        val messageId = Json.string(event["messageId"]) ?: return
        if (Json.string(event["scope"]) == "everyone") appContext?.let { NativeStore.get(it)?.markDeleted(messageId) }
        sink?.forward(Json.stringify(event))
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
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            android.util.Log.w("NFS", "onFailure code=${response?.code} msg=${t.message}")
            drop(webSocket)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            android.util.Log.w("NFS", "onClosed code=$code reason=$reason")
            drop(webSocket)
        }
    }
}
