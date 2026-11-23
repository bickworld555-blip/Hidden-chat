package io.github.bickworld555.hiddenchat.call

import android.content.Context
import org.webrtc.PeerConnectionFactory

/**
 * One camera for a whole call, shared across every peer connection of a group (mesh) video call — the native mirror of
 * the WebView path's single [createCallMediaSource]. A phone cannot open the same camera twice, so each [NativeCall] of
 * a group call must add the SAME [VideoCapture.track] to its peer connection rather than open its own; libwebrtc allows
 * one track on many peer connections. Reference-counted: the camera opens on the first video call and closes when the
 * last one ends. Audio needs no equivalent — the factory's single audio device module already serves every call.
 *
 * (The microphone is likewise shared implicitly through the shared AudioDeviceModule; only the camera needs this.)
 */
object SharedCapture {
    private var capture: VideoCapture? = null
    private var refs = 0

    /** The shared camera, created (and started) on first use; increments the reference count. Null if there is no camera. */
    @Synchronized
    fun acquire(context: Context, factory: PeerConnectionFactory): VideoCapture? {
        if (capture == null) capture = VideoCapture.create(context, factory)?.also { it.start() }
        if (capture != null) refs++
        return capture
    }

    /** The shared camera if one is open, for flip / torch / enable toggles (which affect every peer at once). */
    @Synchronized
    fun current(): VideoCapture? = capture

    /** Drops one reference; stops and releases the camera when the last video call ends. */
    @Synchronized
    fun release() {
        if (refs > 0) refs--
        if (refs == 0) {
            try { capture?.stop() } catch (ignored: Throwable) { /* already gone */ }
            capture = null
        }
    }
}
