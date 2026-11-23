package io.github.bickworld555.hiddenchat

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.NativeFetchHandler
import io.github.bickworld555.hiddenchat.core.crypto.CryptoCores
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The native relay.fetch: connect as a background device, take the messages waiting for this device, decrypt them
 * with the installed CryptoCore (NativeFetchHandler), post the notification, send the delivery receipt and the queue
 * ack, and end when the server goes quiet — the work src/background/relayFetch.js does in the WebView today, in Kotlin.
 *
 * Gated: {@link #start} is a no-op unless the native path is on (NativeBackground.enabled) and a core is installed, so
 * the WebView page (HeadlessRunner) stays the live path until this is verified on a device. Not yet wired into
 * PushService/BackgroundHost — that is the next increment.
 */
class NativeRelayFetch private constructor(private val context: Context, private val onDone: (String) -> Unit) : WebSocketListener() {
    private val client = OkHttpClient()
    private val main = Handler(Looper.getMainLooper())
    private var ready = false
    private var ended = false
    private var socket: WebSocket? = null
    private var meUser: String = ""
    private var meDevice: String = ""
    private val idle = Runnable { finish("quiet") }
    private val limit = Runnable { finish("limit") }

    private fun connect(session: RelaySession, deviceId: String?): Boolean {
        val token = session.token ?: return false
        meUser = session.userId ?: return false
        meDevice = deviceId ?: return false
        val request = Request.Builder()
            .url(session.websocketUrl())
            .header("Sec-WebSocket-Protocol", "relay.auth.$token, relay.v1, relay.background, relay.fetch, ${ClientVersion.SUBPROTOCOL}")
            .build()
        socket = client.newWebSocket(request, this)
        main.postDelayed(limit, MAX_MS)
        return true
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val event = try { Json.map(Json.parse(text)) } catch (e: Exception) { null } ?: return
        when (Json.string(event["type"])) {
            "connection:ready" -> { ready = true; armIdle() }
            "message:new", "group:message" -> { handle(webSocket, event); if (ready) armIdle() }
        }
    }

    private fun handle(webSocket: WebSocket, event: Map<String, Any?>) {
        val core = CryptoCores.current() ?: return
        val delivery = NativeFetchHandler.handle(core, meUser, meDevice, event) ?: return
        android.util.Log.i("NRF", "handled id=${delivery.messageId} opened=${delivery.opened} error=${delivery.error}")
        if (!delivery.opened) return // left for the app; the sealed "🔒 Message" notice already covers it, not acked
        // Store the decrypted message for the app to display BEFORE acking — never ack what was not durably kept.
        if (!NativeDelivery.persist(context, event, delivery)) return
        // The message is durably kept; the notification is presentation, so a failure there must not skip the ack and
        // leave it queued (and the ratchet already advanced). Best-effort, logged.
        try { NativeDelivery.notify(context, delivery) } catch (shown: Throwable) { android.util.Log.w("NRF", "notify failed", shown) }
        send(webSocket, Json.obj("type" to "message:delivered", "messageIds" to listOf(delivery.messageId)))
        send(webSocket, Json.obj("type" to "queue:ack", "messageIds" to listOf(delivery.messageId), "eventIds" to emptyList<String>()))
    }

    private fun send(webSocket: WebSocket, event: Map<String, Any?>) {
        try { webSocket.send(Json.stringify(event)) } catch (e: Exception) { /* closed */ }
    }

    private fun armIdle() {
        main.removeCallbacks(idle)
        main.postDelayed(idle, IDLE_MS)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { finish(if (ready) "quiet" else "offline") }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (!ready) finish("offline") }

    private fun finish(reason: String) {
        if (ended) return
        ended = true
        main.removeCallbacks(idle)
        main.removeCallbacks(limit)
        try { socket?.close(1000, "fetch done") } catch (e: Exception) { /* already closed */ }
        onDone(reason)
    }

    companion object {
        private const val IDLE_MS = 2500L
        private const val MAX_MS = 15000L

        /**
         * Starts a native fetch when the flag is on, a core is installed and a session exists. Returns false (a no-op)
         * otherwise, so the caller falls back to the WebView page. `onDone(reason)` fires once when the fetch ends.
         */
        fun start(context: Context, onDone: (String) -> Unit): Boolean {
            if (!NativeFlag.active(context)) return false
            if (CryptoCores.current() == null) return false
            val session = RelaySession.read(context) ?: return false
            return NativeRelayFetch(context.applicationContext, onDone).connect(session, RelaySession.deviceId(context))
        }
    }
}
