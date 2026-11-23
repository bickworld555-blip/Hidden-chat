package io.github.bickworld555.hiddenchat.call

/**
 * How a native WebRTC call hands its locally-produced signaling out, and reports media state, to whatever transports
 * it. Today the call's SDP and ICE travel as the WebSocket's `call:signal` ({ type, callId, mode, signal }, see
 * src/callEngine.js); this interface keeps the media engine (NativeCall) independent of that transport, so the same
 * engine can be driven by the socket now and by a fully-native signaller later. The transport wiring is a later
 * Step 4 increment — this is the seam it will plug into.
 */
interface NativeCallSignaling {
    /** A local offer or answer this device produced (`type` is "offer"/"answer"): send it to the other side. */
    fun onLocalDescription(type: String, sdp: String)

    /** A local ICE candidate this device gathered: send it to the other side. */
    fun onLocalIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String)

    /** The peer connection is established (media is flowing). */
    fun onConnected()

    /** The call ended at the media layer: `reason` is "failed", "disconnected" or "closed". */
    fun onClosed(reason: String)

    /** A remote audio track arrived (the other person can be heard). */
    fun onRemoteAudio()
}
