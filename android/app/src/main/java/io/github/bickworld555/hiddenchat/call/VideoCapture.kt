package io.github.bickworld555.hiddenchat.call

import android.content.Context
import android.hardware.camera2.CameraManager
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * The camera half of a native video call: a Camera2 capturer feeding a libwebrtc [VideoTrack]. Created only for a
 * video call. Rendering (a local preview and the remote video) needs a surface from the UI — with the WebView UI that
 * is a native SurfaceView overlay ([NativeCallVideoView]) — so this covers CAPTURE + the sending track; the track's
 * frames are also exposed to a renderer through [track]'s addSink when the UI provides one.
 */
class VideoCapture private constructor(
    private val appContext: Context,
    private val enumerator: Camera2Enumerator,
    private val capturer: CameraVideoCapturer,
    private val surfaceHelper: SurfaceTextureHelper,
    private val source: VideoSource,
    val track: VideoTrack,
    @Volatile private var frontFacing: Boolean,
) {
    private var capturing = false

    /** Whether the live camera is the front one (the self view mirrors only the front camera). */
    fun isFront(): Boolean = frontFacing

    fun start(width: Int = 1280, height: Int = 720, fps: Int = 30) {
        if (capturing) return
        capturer.startCapture(width, height, fps)
        capturing = true
    }

    /** Front/back switch; reports the new facing (front=true) through [onDone] once the switch completes. */
    fun switchCamera(onDone: (Boolean) -> Unit) {
        capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                frontFacing = isFrontCamera
                onDone(isFrontCamera)
            }
            override fun onCameraSwitchError(error: String?) { onDone(frontFacing) }
        })
    }

    /**
     * Best-effort flash/torch toggle via CameraManager on the current camera id. Only the back camera has a flash on
     * most phones, and some devices refuse torch while the camera is open (held by the capturer); failures are
     * swallowed and reported as false. Not yet verified on a device.
     */
    fun setTorch(on: Boolean): Boolean {
        val id = currentCameraId() ?: return false
        return try {
            val manager = appContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            manager.setTorchMode(id, on)
            true
        } catch (ignored: Throwable) {
            false
        }
    }

    /** Whether the current camera advertises a flash unit (for torchAvailable on the JS side). */
    fun hasTorch(): Boolean {
        val id = currentCameraId() ?: return false
        return try {
            val manager = appContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val flash = manager.getCameraCharacteristics(id)
                .get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE)
            flash == true
        } catch (ignored: Throwable) {
            false
        }
    }

    private fun currentCameraId(): String? {
        val names = enumerator.deviceNames
        return names.firstOrNull { enumerator.isFrontFacing(it) == frontFacing } ?: names.firstOrNull()
    }

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
            val app = context.applicationContext
            val enumerator = Camera2Enumerator(app)
            val names = enumerator.deviceNames
            val front = names.firstOrNull { enumerator.isFrontFacing(it) }
            val chosen = front ?: names.firstOrNull() ?: return null
            val capturer = enumerator.createCapturer(chosen, null) ?: return null
            val surfaceHelper = SurfaceTextureHelper.create("hm-capture", WebrtcEngine.eglBase.eglBaseContext)
            val source = factory.createVideoSource(false)
            capturer.initialize(surfaceHelper, app, source.capturerObserver)
            val track = factory.createVideoTrack("hm-video", source)
            return VideoCapture(app, enumerator, capturer, surfaceHelper, source, track, front != null)
        }
    }
}
