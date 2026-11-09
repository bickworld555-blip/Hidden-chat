package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import java.util.List;

/**
 * Where call audio plays. Voice calls start on the earpiece (or a connected headset) like a phone call, video calls
 * on the loudspeaker; the speaker button switches. While a voice call is on the earpiece, the proximity sensor turns
 * the screen off against the user's ear. The WebView's WebRTC stack may route audio itself when the microphone
 * starts, so the chosen route is re-applied shortly after and whenever Android reports a change.
 */
final class CallAudio {
    private static boolean active;
    private static boolean speaker;
    private static boolean video;
    private static PowerManager.WakeLock proximity;
    private static ToneGenerator ringback;
    private static AudioManager.OnCommunicationDeviceChangedListener listener;
    private static final Handler handler = new Handler(Looper.getMainLooper());

    private CallAudio() {}

    static synchronized boolean isSpeaker() {
        return speaker;
    }

    /** A call started (or its mode changed): default route for that kind of call. */
    static synchronized void start(Context context, boolean isVideo) {
        boolean wasActive = active;
        active = true;
        if (!wasActive || isVideo != video) speaker = isVideo;
        video = isVideo;
        apply(context);
        // WebRTC may switch the route itself when it opens the microphone; put ours back.
        handler.postDelayed(() -> reapply(context), 600);
        handler.postDelayed(() -> reapply(context), 2000);
        watch(context);
    }

    static synchronized void setSpeaker(Context context, boolean on) {
        speaker = on;
        if (active) apply(context);
    }

    /**
     * The "tuu… tuu…" while an outgoing call rings, on the call stream like a phone call: it plays wherever the call
     * plays (earpiece, headset or loudspeaker) and follows the Speaker button. Web audio would always use the loudspeaker.
     */
    static synchronized boolean startRingback() {
        stopRingback();
        try {
            ringback = new ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80);
            if (!ringback.startTone(ToneGenerator.TONE_SUP_RINGTONE)) {
                stopRingback();
                return false;
            }
            return true;
        } catch (RuntimeException unavailable) {
            ringback = null;
            return false;
        }
    }

    static synchronized void stopRingback() {
        if (ringback == null) return;
        try {
            ringback.stopTone();
        } catch (RuntimeException ignored) {
            // Already released.
        }
        ringback.release();
        ringback = null;
    }

    static synchronized void stop(Context context) {
        stopRingback();
        if (!active) return;
        active = false;
        handler.removeCallbacksAndMessages(null);
        AudioManager audio = context.getSystemService(AudioManager.class);
        if (audio != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (listener != null) audio.removeOnCommunicationDeviceChangedListener(listener);
                listener = null;
                audio.clearCommunicationDevice();
            } else {
                audio.setSpeakerphoneOn(false);
            }
            audio.setMode(AudioManager.MODE_NORMAL);
        }
        releaseProximity();
    }

    private static synchronized void reapply(Context context) {
        if (active) apply(context);
    }

    private static void apply(Context context) {
        AudioManager audio = context.getSystemService(AudioManager.class);
        if (audio == null) return;
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo target = pick(audio.getAvailableCommunicationDevices(), speaker);
            if (target != null && !target.equals(audio.getCommunicationDevice())) audio.setCommunicationDevice(target);
            android.util.Log.i("CallAudio", "route " + (speaker ? "speaker" : "earpiece/headset") + " -> " + (target == null ? "none" : target.getType()));
        } else {
            audio.setSpeakerphoneOn(speaker && !audio.isWiredHeadsetOn() && !audio.isBluetoothScoOn());
            android.util.Log.i("CallAudio", "route " + (speaker ? "speaker" : "earpiece/headset"));
        }
        updateProximity(context);
    }

    /** Loudspeaker when asked; otherwise a headset if one is connected, else the earpiece. */
    private static AudioDeviceInfo pick(List<AudioDeviceInfo> devices, boolean wantSpeaker) {
        AudioDeviceInfo earpiece = null;
        AudioDeviceInfo loudspeaker = null;
        AudioDeviceInfo headset = null;
        for (AudioDeviceInfo device : devices) {
            switch (device.getType()) {
                case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: earpiece = device; break;
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: loudspeaker = device; break;
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                case AudioDeviceInfo.TYPE_BLE_HEADSET:
                    if (headset == null) headset = device;
                    break;
                default: break;
            }
        }
        if (wantSpeaker) return loudspeaker != null ? loudspeaker : earpiece;
        if (headset != null) return headset;
        return earpiece != null ? earpiece : loudspeaker;
    }

    private static void watch(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || listener != null) return;
        AudioManager audio = context.getSystemService(AudioManager.class);
        if (audio == null) return;
        listener = (device) -> {
            synchronized (CallAudio.class) {
                if (!active || device == null) return;
                AudioDeviceInfo wanted = pick(audio.getAvailableCommunicationDevices(), speaker);
                if (wanted != null && wanted.getType() != device.getType()) handler.postDelayed(() -> reapply(context), 150);
            }
        };
        audio.addOnCommunicationDeviceChangedListener(context.getMainExecutor(), listener);
    }

    private static void updateProximity(Context context) {
        boolean wanted = active && !speaker && !video;
        if (wanted) {
            if (proximity == null) {
                PowerManager power = context.getSystemService(PowerManager.class);
                if (power == null || !power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
                proximity = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "HiddenMessenger:call");
            }
            if (!proximity.isHeld()) proximity.acquire(4 * 60 * 60 * 1000L);
        } else {
            releaseProximity();
        }
    }

    private static void releaseProximity() {
        if (proximity != null && proximity.isHeld()) proximity.release();
    }
}
