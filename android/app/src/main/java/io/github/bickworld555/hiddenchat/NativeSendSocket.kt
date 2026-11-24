package io.github.bickworld555.hiddenchat

import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * The native UI's own relay connection while it is in the FOREGROUND (Step 5), so [NativeSend] can put a sealed
 * message on the wire without the WebView owning the socket. [NativeRelay] only runs while the whole app is gone (and
 * the WebView keeps its own socket while visible), so neither is available to the native UI; this fills that gap.
 *
 * Connects as `relay.background` — a secondary, non-"online" channel — and is WRITE-ONLY: it only sends message:send
 * and ignores incoming events, leaving message delivery and acknowledgement to the WebView's connection (so this never
 * swallows a message without acking it). Started/stopped by [io.github.bickworld555.hiddenchat.ui.NativeUiActivity]'s
 * onStart/onStop. While it is wanted (started and not yet stopped) it reconnects on its own after a drop — a network
 * change or server restart — so it does not stay down until the Activity restarts. UNVERIFIED: the server's behaviour
 * with this extra per-device connection, and that a native-sealed message delivers, must be validated on real devices
 * before the native-UI flag is enabled.
 */
object NativeSendSocket {
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val reconnects = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "native-send-reconnect").apply { isDaemon = true }
    }

    @Volatile private var socket: WebSocket? = null
    @Volatile private var open = false
    @Volatile private var wanted = false
    @Volatile private var reconnectScheduled = false
    private var attempt = 0
    private var appContext: Context? = null

    /** Opens the foreground send socket (idempotent); called when the native UI becomes visible. */
    @Synchronized
    fun start(context: Context) {
        wanted = true
        appContext = context.applicationContext
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
            .header("Sec-WebSocket-Protocol", "relay.auth.$token, relay.v1, relay.background, ${ClientVersion.SUBPROTOCOL}")
            .build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = opened(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = drop(webSocket)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = drop(webSocket)
            // Write-only: the WebView's connection owns delivery + acks, so incoming events are ignored here.
        })
    }

    @Synchronized
    private fun opened(webSocket: WebSocket) {
        if (webSocket == socket) { open = true; attempt = 0 }
    }

    /** Closes the socket and stops reconnecting (idempotent); called when the native UI is no longer visible. */
    @Synchronized
    fun stop() {
        wanted = false
        open = false
        try { socket?.close(1000, "native ui backgrounded") } catch (ignored: Throwable) { /* already gone */ }
        socket = null
    }

    /** Whether a sealed message can go out over this socket right now. */
    fun canSend(): Boolean = open && socket != null

    /** Puts a (natively sealed) message on the wire as message:send; true when the socket accepted it. */
    @Synchronized
    fun sendMessage(message: JSONObject): Boolean {
        val current = socket ?: return false
        if (!open) return false
        return try {
            current.send(JSONObject().put("type", "message:send").put("message", message).toString())
        } catch (ignored: Throwable) {
            false
        }
    }

    @Synchronized
    private fun drop(webSocket: WebSocket) {
        if (webSocket != socket) return
        open = false
        socket = null
        if (wanted) scheduleReconnect()
    }

    // Reconnect with backoff while the socket is still wanted: 1s, doubling to a 30s cap. A single pending attempt at a
    // time; `wanted` is re-checked when it fires, so a stop() between scheduling and firing cancels it.
    @Synchronized
    private fun scheduleReconnect() {
        if (reconnectScheduled || !wanted) return
        reconnectScheduled = true
        val delay = minOf(30_000L, 1_000L shl minOf(attempt, 5))
        attempt++
        reconnects.schedule({ reconnectNow() }, delay, TimeUnit.MILLISECONDS)
    }

    @Synchronized
    private fun reconnectNow() {
        reconnectScheduled = false
        if (wanted && socket == null) connect()
    }
}
