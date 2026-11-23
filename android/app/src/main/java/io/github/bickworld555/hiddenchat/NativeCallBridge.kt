package io.github.bickworld555.hiddenchat

import android.content.Context
import io.github.bickworld555.hiddenchat.call.NativeCall
import io.github.bickworld555.hiddenchat.call.NativeCallSignaling
import io.github.bickworld555.hiddenchat.core.Json
import org.webrtc.PeerConnection

/**
 * Bridges the app's call signaling (the socket's `call:signal`, src/callEngine.js) to the native WebRTC media engine
 * ([NativeCall]), and the call's audio route to [CallAudio]. The WebView still runs the call's signaling and UI and
 * registers the call with Telecom (setCallActive / MessagingService); this owns only the MEDIA — the microphone and
 * the SDP/ICE in and out.
 *
 * Locally produced SDP and ICE are emitted to the WebView as plugin events (callLocalDescription / callLocalIce) for
 * it to put on the wire as `call:signal`; remote SDP/ICE arrive back through the plugin methods. ICE servers are
 * fetched natively from /api/v1/rtc-config. Audio-only for now (video media is a later increment); `video` here only
 * chooses the earpiece-vs-loudspeaker route via CallAudio. Reached only behind NativeFlag (the plugin checks it).
 */
object NativeCallBridge {
    /** How the bridge hands call events back to the WebView (wired to the plugin's notifyListeners in load()). */
    fun interface Emitter {
        fun emit(event: String, data: Map<String, Any?>)
    }

    @Volatile
    var emitter: Emitter? = null

    private class Holder(val call: NativeCall, val video: Boolean)
    private val calls = HashMap<String, Holder>()

    @Synchronized private fun put(callId: String, holder: Holder) { calls[callId] = holder }
    @Synchronized private fun get(callId: String): Holder? = calls[callId]
    @Synchronized private fun take(callId: String): Holder? = calls.remove(callId)

    private fun emit(event: String, data: Map<String, Any?>) {
        emitter?.emit(event, data)
    }

    /** Outgoing call: fetch ICE, build the call, make the offer (emitted as callLocalDescription). Off the main thread. */
    fun start(context: Context, callId: String, video: Boolean) {
        val app = context.applicationContext
        Thread({
            val holder = Holder(NativeCall(app, iceServers(app), signaling(app, callId, video), video), video)
            put(callId, holder)
            holder.call.createOffer()
        }, "native-call-start").start()
    }

    /** Incoming call: fetch ICE, build the call, apply the remote offer and answer it (callLocalDescription). */
    fun acceptOffer(context: Context, callId: String, video: Boolean, sdp: String) {
        val app = context.applicationContext
        Thread({
            val holder = Holder(NativeCall(app, iceServers(app), signaling(app, callId, video), video), video)
            put(callId, holder)
            holder.call.acceptOffer(sdp)
        }, "native-call-accept").start()
    }

    /** The other side answered our offer. */
    fun acceptAnswer(callId: String, sdp: String) { get(callId)?.call?.acceptAnswer(sdp) }

    /** A remote ICE candidate arrived over `call:signal`. */
    fun remoteIce(callId: String, sdpMid: String?, sdpMLineIndex: Int, candidate: String) {
        get(callId)?.call?.addRemoteIceCandidate(sdpMid, sdpMLineIndex, candidate)
    }

    fun mic(callId: String, enabled: Boolean) { get(callId)?.call?.setMicrophoneEnabled(enabled) }

    /** End a call (hang up, decline, the other side left, a system hang-up relayed through the WebView). */
    fun end(context: Context, callId: String) {
        take(callId)?.let { holder ->
            holder.call.close()
            try { CallAudio.stop(context.applicationContext) } catch (ignored: Throwable) { /* nothing to release */ }
        }
    }

    private fun signaling(app: Context, callId: String, video: Boolean): NativeCallSignaling = object : NativeCallSignaling {
        override fun onLocalDescription(type: String, sdp: String) =
            emit("callLocalDescription", mapOf("callId" to callId, "type" to type, "sdp" to sdp))

        override fun onLocalIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String) =
            emit("callLocalIce", mapOf("callId" to callId, "sdpMid" to sdpMid, "sdpMLineIndex" to sdpMLineIndex, "candidate" to candidate))

        override fun onConnected() {
            // Media is flowing: put the call on the earpiece (voice) or loudspeaker (video), like the WebView path.
            try { CallAudio.start(app, video) } catch (ignored: Throwable) { /* route stays as-is */ }
            emit("callState", mapOf("callId" to callId, "state" to "connected"))
        }

        override fun onClosed(reason: String) {
            if (take(callId) != null) try { CallAudio.stop(app) } catch (ignored: Throwable) { /* already released */ }
            emit("callState", mapOf("callId" to callId, "state" to "closed", "reason" to reason))
        }

        override fun onRemoteAudio() = emit("callRemoteAudio", mapOf("callId" to callId))
    }

    /** The account's ICE servers (STUN + TURN-REST), fetched natively from the same endpoint the WebView uses. */
    private fun iceServers(context: Context): List<PeerConnection.IceServer> {
        val server = NativeServer.from(context) ?: return emptyList()
        val config = server.getJson("/api/v1/rtc-config") ?: return emptyList()
        val list = Json.list(config["iceServers"]) ?: return emptyList()
        val triples = list.mapNotNull { item ->
            val entry = Json.map(item) ?: return@mapNotNull null
            val urls = when (val raw = entry["urls"]) {
                is List<*> -> raw.mapNotNull { it?.toString() }
                is String -> listOf(raw)
                else -> return@mapNotNull null
            }
            if (urls.isEmpty()) null else Triple(urls, Json.string(entry["username"]), Json.string(entry["credential"]))
        }
        return NativeCall.iceServers(triples)
    }
}
