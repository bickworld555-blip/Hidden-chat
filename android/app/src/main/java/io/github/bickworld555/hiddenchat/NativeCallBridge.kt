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
 * fetched natively from /api/v1/rtc-config. `video` builds a camera track too ([NativeCall]/[VideoCapture]) and routes
 * audio to the loudspeaker; the remote picture and local preview are drawn by a native overlay the plugin attaches to
 * the Activity (NativeCallVideoView). Reached only behind NativeFlag (the plugin checks it).
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

    // Periodic remote-audio-level sampler for the speaking indicator (the native engine plays remote audio itself, so
    // the WebView has no stream to meter). One daemon scheduler; a per-call task polls getStats and emits callRemoteLevel.
    private val levelSamplers = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.ScheduledFuture<*>>()
    private val sampler: java.util.concurrent.ScheduledExecutorService by lazy {
        java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "native-call-levels").apply { isDaemon = true } }
    }

    private fun startLevelSampler(callId: String) {
        stopLevelSampler(callId)
        levelSamplers[callId] = sampler.scheduleWithFixedDelay({
            val call = get(callId)?.call ?: return@scheduleWithFixedDelay
            call.getStats { rows ->
                val audio = rows.firstOrNull { it["type"] == "inbound-rtp" && it["kind"] == "audio" }
                val level = (audio?.get("audioLevel") as? Number)?.toDouble() ?: 0.0
                emit("callRemoteLevel", mapOf("callId" to callId, "level" to level))
            }
        }, 300, 200, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    private fun stopLevelSampler(callId: String) { levelSamplers.remove(callId)?.cancel(false) }

    @Synchronized private fun put(callId: String, holder: Holder) { calls[callId] = holder }
    @Synchronized private fun get(callId: String): Holder? = calls[callId]
    @Synchronized private fun take(callId: String): Holder? = calls.remove(callId)

    /** The live native call, for the UI overlay to bind its video renderers to (null once the call is gone). */
    fun call(callId: String): NativeCall? = get(callId)?.call

    /** Front/back camera flip for a video call; reports the new facing (front=true) through [onDone]. */
    fun switchCamera(callId: String, onDone: (Boolean) -> Unit) {
        val call = get(callId)?.call
        if (call == null) onDone(true) else call.switchCamera(onDone)
    }

    /** Turn the local camera off/on (camera button), mirroring the WebView path's `track.enabled`. */
    fun setCamera(callId: String, enabled: Boolean) { get(callId)?.call?.setCameraEnabled(enabled) }

    /** Flash/torch toggle for a native video call (best-effort; usually back camera only). */
    fun setTorch(callId: String, on: Boolean): Boolean = get(callId)?.call?.setTorch(on) ?: false

    /** Whether the live call's current camera has a controllable flash. */
    fun torchAvailable(callId: String): Boolean = get(callId)?.call?.torchAvailable() ?: false

    /** Voice → video upgrade: publish a camera track on the existing call (caller then renegotiates). */
    fun addVideo(callId: String) { get(callId)?.call?.addVideoTrack() }

    /** A later offer on the same connection: ICE restart (network switch) or a voice→video upgrade. */
    fun renegotiate(callId: String, iceRestart: Boolean) { get(callId)?.call?.renegotiate(iceRestart) }

    /** Glare: roll back our just-made local offer so the other side's offer applies. */
    fun rollback(callId: String) { get(callId)?.call?.rollback() }

    /** A WebRTC stats snapshot (quality/telemetry), flattened to plain maps; empty list once the call is gone. */
    fun stats(callId: String, onReport: (List<Map<String, Any?>>) -> Unit) {
        val call = get(callId)?.call
        if (call == null) onReport(emptyList()) else call.getStats(onReport)
    }

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
        stopLevelSampler(callId)
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
            startLevelSampler(callId)
            emit("callState", mapOf("callId" to callId, "state" to "connected"))
        }

        override fun onClosed(reason: String) {
            stopLevelSampler(callId)
            if (take(callId) != null) try { CallAudio.stop(app) } catch (ignored: Throwable) { /* already released */ }
            emit("callState", mapOf("callId" to callId, "state" to "closed", "reason" to reason))
        }

        override fun onRemoteAudio() = emit("callRemoteAudio", mapOf("callId" to callId))

        override fun onRemoteVideo() = emit("callRemoteVideo", mapOf("callId" to callId))
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
