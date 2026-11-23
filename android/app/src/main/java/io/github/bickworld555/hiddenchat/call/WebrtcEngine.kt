package io.github.bickworld555.hiddenchat.call

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * The native WebRTC media engine (libwebrtc), the counterpart of the WebView's WebRTC stack (src/callEngine.js). One
 * [PeerConnectionFactory] for the whole process, built lazily on first use: libwebrtc must be initialized once, and
 * the factory is expensive. Audio is wired now; the EglBase and video codec factories are created here too so video
 * tracks (camera capture + rendering) can be added in the next increment without rebuilding the factory. Gated like
 * the rest of the native path and not yet wired into the live call flow.
 */
object WebrtcEngine {
    @Volatile private var initialized = false
    @Volatile private var cached: PeerConnectionFactory? = null

    /** The shared OpenGL context for video (encoder/decoder + rendering); created even in audio-only use so the
     * factory never has to be rebuilt when video arrives. */
    val eglBase: EglBase by lazy { EglBase.create() }

    @Synchronized
    fun factory(context: Context): PeerConnectionFactory {
        cached?.let { return it }
        val app = context.applicationContext
        if (!initialized) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions(),
            )
            initialized = true
        }
        val audioModule = JavaAudioDeviceModule.builder(app).createAudioDeviceModule()
        val factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
        cached = factory
        return factory
    }
}
