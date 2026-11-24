package io.github.bickworld555.hiddenchat

import android.content.Context
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
 * onStart/onStop. UNVERIFIED: the server's behaviour with this extra per-device connection, and that a native-sealed
 * message delivers, must be validated on real devices before the native-UI flag is enabled.
 */
object NativeSendSocket {
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var open = false

    /** Opens the foreground send socket (idempotent); called when the native UI becomes visible. */
    @Synchronized
    fun start(context: Context) {
        if (socket != null) return
        val session = RelaySession.read(context.applicationContext) ?: return
        val url = session.websocketUrl() ?: return
        val token = session.token ?: return
        val request = Request.Builder()
            .url(url)
            .header("Sec-WebSocket-Protocol", "relay.auth.$token, relay.v1, relay.background, ${ClientVersion.SUBPROTOCOL}")
            .build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket == socket) open = true
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = drop(webSocket)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = drop(webSocket)
            // Write-only: the WebView's connection owns delivery + acks, so incoming events are ignored here.
        })
    }

    /** Closes the socket (idempotent); called when the native UI is no longer visible. */
    @Synchronized
    fun stop() {
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
        if (webSocket == socket) { open = false; socket = null }
    }
}
