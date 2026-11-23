package io.github.bickworld555.hiddenchat.call

import android.app.Activity
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * The on-screen half of a native video call: a native overlay, above the WebView, that draws the remote video
 * full-screen with the local camera in a corner — the same arrangement the WebView path draws with its two `<video>`
 * elements (CallGrid). The WebView keeps the whole call UI (header, controls, swap/minimise gestures); this only paints
 * the two live pictures, because libwebrtc frames cannot reach a WebView `<video>`.
 *
 * libwebrtc renderers are GL surfaces and must be created, attached and released on the main thread; the plugin drives
 * this from the Activity while [NativeCall] (a worker) owns the tracks. One instance per video call.
 *
 * KNOWN LIMITS (first cut, off by default): the overlay fills the call stage and does not yet track the WebView's
 * draggable self-tile, minimise/picture-in-picture window, or group grid; it is shown for a connected one-to-one video
 * call and hidden otherwise. Geometry that follows the WebView layout is a follow-up. Not yet verified on a device with
 * a second video peer (the emulator cannot complete call media).
 */
class NativeCallVideoView private constructor(
    private val activity: Activity,
    private val root: FrameLayout,
    private val remoteRenderer: SurfaceViewRenderer,
    private val localRenderer: SurfaceViewRenderer,
) {
    @Volatile private var remoteTrack: VideoTrack? = null
    @Volatile private var localTrack: VideoTrack? = null
    @Volatile private var released = false

    /** The sink the call feeds the remote video into (set as [NativeCall.remoteVideoSink]). */
    fun remoteSink(): org.webrtc.VideoSink = remoteRenderer

    /** Show the local camera preview (the corner tile) once the capture track exists. */
    fun showLocal(track: VideoTrack?) = activity.runOnUiThread {
        if (released) return@runOnUiThread
        localTrack?.let { try { it.removeSink(localRenderer) } catch (ignored: Throwable) {} }
        localTrack = track
        if (track != null) {
            localRenderer.visibility = android.view.View.VISIBLE
            try { track.addSink(localRenderer) } catch (ignored: Throwable) {}
        } else {
            localRenderer.visibility = android.view.View.GONE
        }
    }

    /** Remote picture arrived; bind it to the full-screen renderer. */
    fun showRemote(track: VideoTrack?) = activity.runOnUiThread {
        if (released) return@runOnUiThread
        remoteTrack?.let { try { it.removeSink(remoteRenderer) } catch (ignored: Throwable) {} }
        remoteTrack = track
        if (track != null) try { track.addSink(remoteRenderer) } catch (ignored: Throwable) {}
    }

    @Volatile private var mirrored = true  // starts on the front camera

    /** Camera flipped front/back: the local preview mirrors only the front camera, like the WebView self-view. */
    fun toggleLocalMirror() = activity.runOnUiThread {
        if (released) return@runOnUiThread
        mirrored = !mirrored
        localRenderer.setMirror(mirrored)
    }

    /** Take the overlay down and release both GL surfaces (idempotent). */
    fun detach() = activity.runOnUiThread {
        if (released) return@runOnUiThread
        released = true
        remoteTrack?.let { try { it.removeSink(remoteRenderer) } catch (ignored: Throwable) {} }
        localTrack?.let { try { it.removeSink(localRenderer) } catch (ignored: Throwable) {} }
        remoteTrack = null
        localTrack = null
        try { (root.parent as? ViewGroup)?.removeView(root) } catch (ignored: Throwable) {}
        try { remoteRenderer.release() } catch (ignored: Throwable) {}
        try { localRenderer.release() } catch (ignored: Throwable) {}
    }

    companion object {
        private const val LOCAL_W_DP = 108
        private const val LOCAL_H_DP = 160
        private const val LOCAL_MARGIN_DP = 16

        /** Builds the overlay and adds it over the Activity's content, on the main thread. */
        fun attach(activity: Activity): NativeCallVideoView {
            val egl = WebrtcEngine.eglBase.eglBaseContext
            val density = activity.resources.displayMetrics.density
            fun dp(value: Int) = (value * density).toInt()

            val root = FrameLayout(activity)
            // Transparent: this layer sits BEHIND the (made-transparent) WebView, so the WebView's call controls draw
            // on top of the native picture. The remote renderer's own surface fills it where there is video.
            root.setBackgroundColor(android.graphics.Color.TRANSPARENT)

            val remote = SurfaceViewRenderer(activity).apply {
                init(egl, null)
                setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                setEnableHardwareScaler(true)
                // Default z-order: the surface composites BELOW the window, so the transparent WebView shows it through.
            }
            root.addView(remote, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

            val local = SurfaceViewRenderer(activity).apply {
                init(egl, null)
                setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                setZOrderMediaOverlay(true)   // the corner preview draws above the remote surface (still below the WebView)
                setEnableHardwareScaler(true)
                setMirror(true)               // front camera by default
                visibility = android.view.View.GONE
            }
            root.addView(local, FrameLayout.LayoutParams(dp(LOCAL_W_DP), dp(LOCAL_H_DP), Gravity.TOP or Gravity.END).apply {
                topMargin = dp(LOCAL_MARGIN_DP)
                marginEnd = dp(LOCAL_MARGIN_DP)
            })

            // Index 0 puts the overlay beneath the Capacitor WebView in the content view.
            val content = activity.findViewById<ViewGroup>(android.R.id.content)
            content.addView(root, 0, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            return NativeCallVideoView(activity, root, remote, local)
        }
    }
}
