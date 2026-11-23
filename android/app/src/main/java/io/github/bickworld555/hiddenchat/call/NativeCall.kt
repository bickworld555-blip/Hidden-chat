package io.github.bickworld555.hiddenchat.call

import android.content.Context
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoSink
import org.webrtc.VideoTrack

/**
 * One native WebRTC call — audio for now. Builds a [PeerConnection] over the shared [WebrtcEngine] factory with the
 * given ICE servers, publishes a local microphone track, and relays SDP, ICE and media state through [signaling].
 * This mirrors the per-call logic src/callEngine.js runs in the WebView. Video (camera capture + a renderer) is the
 * next increment; this class is the seam the live call flow and Telecom (CallConnectionService) will drive.
 */
class NativeCall(
    context: Context,
    iceServers: List<PeerConnection.IceServer>,
    private val signaling: NativeCallSignaling,
    private val video: Boolean = false,
) {
    private val appContext = context.applicationContext
    private val factory = WebrtcEngine.factory(context)

    // The remote camera track, kept so a renderer that attaches AFTER the track arrives (the UI overlay is built when
    // the call connects, which can be after onAddTrack) still gets the picture.
    @Volatile private var remoteVideoTrack: VideoTrack? = null
    // The camera is shared across every peer of a group (mesh) call ([SharedCapture]); this call only holds a reference
    // to it while it is a video call, and releases that on close. `videoCapture` is the shared instance while held.
    private var holdsVideo = false
    private val videoCapture: VideoCapture? get() = if (holdsVideo) SharedCapture.current() else null

    /**
     * A UI renderer for the remote video (a native SurfaceView overlay over the WebView). Setting it binds the remote
     * track already received, if any; clearing it unbinds. Set on the main thread by the plugin when the overlay opens.
     */
    var remoteVideoSink: VideoSink? = null
        set(value) {
            val previous = field
            val track = remoteVideoTrack
            if (previous != null && track != null) try { track.removeSink(previous) } catch (ignored: Throwable) { /* gone */ }
            field = value
            if (value != null && track != null) try { track.addSink(value) } catch (ignored: Throwable) { /* gone */ }
        }

    private val observer = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) =
            signaling.onLocalIceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.sdp)

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            when (newState) {
                PeerConnection.PeerConnectionState.CONNECTED -> signaling.onConnected()
                PeerConnection.PeerConnectionState.FAILED -> signaling.onClosed("failed")
                PeerConnection.PeerConnectionState.DISCONNECTED -> signaling.onClosed("disconnected")
                PeerConnection.PeerConnectionState.CLOSED -> signaling.onClosed("closed")
                else -> { /* new / connecting */ }
            }
        }

        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
            when (val track = receiver.track()) {
                is VideoTrack -> {
                    remoteVideoTrack = track
                    remoteVideoSink?.let { try { track.addSink(it) } catch (ignored: Throwable) { /* gone */ } }
                    signaling.onRemoteVideo()
                }
                else -> if (track?.kind() == "audio") signaling.onRemoteAudio()
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() {}
    }

    private val connection: PeerConnection? = factory.createPeerConnection(
        PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // Keep gathering after the first candidates, like the WebView path, so a network switch can re-gather.
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        },
        observer,
    )

    private var localAudio: AudioTrack? = null

    // libwebrtc drops addIceCandidate calls made before setRemoteDescription. The JS side can flush remote candidates
    // before the native (async) setRemoteDescription completes, so buffer them here until the remote description lands.
    @Volatile private var remoteReady = false
    private val pendingRemote = java.util.Collections.synchronizedList(ArrayList<IceCandidate>())

    private fun flushRemoteCandidates() {
        remoteReady = true
        synchronized(pendingRemote) {
            for (candidate in pendingRemote) connection?.addIceCandidate(candidate)
            pendingRemote.clear()
        }
    }

    init {
        val source = factory.createAudioSource(MediaConstraints())
        val track = factory.createAudioTrack("hm-audio", source)
        localAudio = track
        connection?.addTrack(track, listOf("hm-stream"))
        if (video) acquireVideo()
    }

    // Acquire the shared camera and publish its track on this connection once. Used both for an initial video call and
    // for a voice→video upgrade; a group call's peers all add the SAME shared track.
    private fun acquireVideo(): VideoCapture? {
        if (holdsVideo) return SharedCapture.current()
        val capture = SharedCapture.acquire(appContext, factory) ?: return null
        holdsVideo = true
        connection?.addTrack(capture.track, listOf("hm-stream"))
        return capture
    }

    /** The local camera track (video calls only), for a local-preview renderer. */
    fun localVideoTrack(): VideoTrack? = videoCapture?.track

    /** Front/back camera flip; reports the new facing (front=true) through [onDone] once it completes. */
    fun switchCamera(onDone: (Boolean) -> Unit) {
        val capture = videoCapture
        if (capture == null) onDone(true) else capture.switchCamera(onDone)
    }

    /** Turn the camera off/on (the track stays, so no renegotiation), like the WebView path's `track.enabled`. */
    fun setCameraEnabled(enabled: Boolean) { videoCapture?.track?.setEnabled(enabled) }

    /** Best-effort flash/torch toggle on the current camera (usually only the back camera). */
    fun setTorch(on: Boolean): Boolean = videoCapture?.setTorch(on) ?: false

    /** Whether the current camera advertises a controllable flash. */
    fun torchAvailable(): Boolean = videoCapture?.hasTorch() ?: false

    /**
     * Voice → video upgrade: create and publish a camera track on the existing connection if there is none yet. The
     * caller then [renegotiate]s so the new m-line reaches the other side. Returns the local track for the preview.
     */
    fun addVideoTrack(): VideoTrack? = acquireVideo()?.track

    /** Mute/unmute the microphone (the track stays, so no renegotiation). */
    fun setMicrophoneEnabled(enabled: Boolean) {
        localAudio?.setEnabled(enabled)
    }

    /** Outgoing call: make the offer, set it as the local description, hand it to signaling. */
    fun createOffer() {
        val pc = connection ?: return
        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                pc.setLocalDescription(SimpleSdpObserver(), description)
                signaling.onLocalDescription(description.type.canonicalForm(), description.description)
            }
        }, MediaConstraints())
    }

    /** Incoming call: apply the remote offer, answer it, hand the answer to signaling. */
    fun acceptOffer(sdp: String) {
        val pc = connection ?: return
        pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                flushRemoteCandidates()
                pc.createAnswer(object : SimpleSdpObserver() {
                    override fun onCreateSuccess(description: SessionDescription) {
                        pc.setLocalDescription(SimpleSdpObserver(), description)
                        signaling.onLocalDescription(description.type.canonicalForm(), description.description)
                    }
                }, MediaConstraints())
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    /** The other side answered our offer. */
    fun acceptAnswer(sdp: String) {
        connection?.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() { flushRemoteCandidates() }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    /** A remote ICE candidate arrived over signaling; buffered until the remote description is set. */
    fun addRemoteIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String) {
        val ice = IceCandidate(sdpMid, sdpMLineIndex, candidate)
        if (remoteReady) connection?.addIceCandidate(ice) else pendingRemote.add(ice)
    }

    /** A later offer on the SAME connection: ICE restart (network switch) or a voice→video upgrade's new m-line. */
    fun renegotiate(iceRestart: Boolean) {
        val pc = connection ?: return
        val constraints = MediaConstraints().apply {
            if (iceRestart) mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
        }
        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                pc.setLocalDescription(SimpleSdpObserver(), description)
                signaling.onLocalDescription(description.type.canonicalForm(), description.description)
            }
        }, constraints)
    }

    /** Glare: drop our just-made local offer so the other side's crossing offer can be applied instead. */
    fun rollback() {
        connection?.setLocalDescription(SimpleSdpObserver(), SessionDescription(SessionDescription.Type.ROLLBACK, ""))
    }

    /** A snapshot of the connection's WebRTC stats, flattened to plain maps for the JS quality/telemetry readers. */
    fun getStats(onReport: (List<Map<String, Any?>>) -> Unit) {
        val pc = connection
        if (pc == null) { onReport(emptyList()); return }
        pc.getStats { report ->
            val out = ArrayList<Map<String, Any?>>(report.statsMap.size)
            for ((id, stat) in report.statsMap) {
                val row = HashMap<String, Any?>()
                row["id"] = id
                row["type"] = stat.type
                row["timestamp"] = stat.timestampUs / 1000.0
                for ((key, value) in stat.members) row[key] = statValue(value)
                out.add(row)
            }
            onReport(out)
        }
    }

    // WebRTC stat members include BigInteger counters and arrays; coerce to JSON-safe primitives for the bridge.
    private fun statValue(value: Any?): Any? = when (value) {
        is java.math.BigInteger -> value.toLong()
        is java.math.BigDecimal -> value.toDouble()
        is Number, is String, is Boolean, null -> value
        else -> value.toString()
    }

    fun close() {
        if (holdsVideo) { try { SharedCapture.release() } catch (ignored: Throwable) { /* already gone */ }; holdsVideo = false }
        try { connection?.close() } catch (ignored: Throwable) { /* already gone */ }
        try { connection?.dispose() } catch (ignored: Throwable) { /* already gone */ }
        localAudio = null
    }

    /** No-op SDP observer; only the hooks a given step needs are overridden above. */
    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }

    companion object {
        /** libwebrtc ICE servers from the (urls, username, credential) triples the app's TURN endpoint returns. */
        fun iceServers(servers: List<Triple<List<String>, String?, String?>>): List<PeerConnection.IceServer> =
            servers.map { (urls, user, cred) ->
                PeerConnection.IceServer.builder(urls)
                    .apply {
                        if (user != null) setUsername(user)
                        if (cred != null) setPassword(cred)
                    }
                    .createIceServer()
            }
    }
}
