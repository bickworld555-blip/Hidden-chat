package io.github.bickworld555.hiddenchat.call

import android.content.Context
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * The camera half of a native video call: a Camera2 capturer feeding a libwebrtc [VideoTrack]. Created only for a
 * video call. Rendering (a local preview and the remote video) needs a surface from the UI — with the WebView UI that
 * is a native SurfaceView overlay, a later increment — so this covers CAPTURE + the sending track; the track's frames
 * are also exposed to a renderer through [track]'s addSink when the UI provides one.
 */
class VideoCapture private constructor(
    private val capturer: CameraVideoCapturer,
    private val surfaceHelper: SurfaceTextureHelper,
    private val source: VideoSource,
    val track: VideoTrack,
) {
    private var capturing = false

    fun start(width: Int = 1280, height: Int = 720, fps: Int = 30) {
        if (capturing) return
        capturer.startCapture(width, height, fps)
        capturing = true
    }

    /** Front/back switch, like the WebView path's camera flip. */
    fun switchCamera() = capturer.switchCamera(null)

    fun stop() {
        if (capturing) {
            try { capturer.stopCapture() } catch (ignored: InterruptedException) { /* stopping anyway */ }
            capturing = false
        }
        try { capturer.dispose() } catch (ignored: Throwable) { /* already gone */ }
        try { source.dispose() } catch (ignored: Throwable) { /* already gone */ }
        try { surfaceHelper.dispose() } catch (ignored: Throwable) { /* already gone */ }
    }

    companion object {
        /** Builds a front-camera capturer + video track over the shared factory, or null when there is no camera. */
        fun create(context: Context, factory: PeerConnectionFactory): VideoCapture? {
            val enumerator = Camera2Enumerator(context)
            val names = enumerator.deviceNames
            val front = names.firstOrNull { enumerator.isFrontFacing(it) } ?: names.firstOrNull() ?: return null
            val capturer = enumerator.createCapturer(front, null) ?: return null
            val surfaceHelper = SurfaceTextureHelper.create("hm-capture", WebrtcEngine.eglBase.eglBaseContext)
            val source = factory.createVideoSource(false)
            capturer.initialize(surfaceHelper, context.applicationContext, source.capturerObserver)
            val track = factory.createVideoTrack("hm-video", source)
            return VideoCapture(capturer, surfaceHelper, source, track)
        }
    }
}
