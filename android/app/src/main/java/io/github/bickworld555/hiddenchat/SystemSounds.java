package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.util.HashMap;
import java.util.Map;

/**
 * Plays the phone's own default sounds — whatever the user chose in Android's sound settings (Samsung, Xiaomi,
 * Pixel… each has its own) — for the in-app "Default" tone choice: the default ringtone for incoming calls and the
 * default notification sound for messages.
 */
final class SystemSounds {
    private static final Map<String, Ringtone> playing = new HashMap<>();

    private SystemSounds() {}

    static Uri defaultUri(boolean ringtone) {
        return ringtone ? Settings.System.DEFAULT_RINGTONE_URI : Settings.System.DEFAULT_NOTIFICATION_URI;
    }

    static synchronized boolean play(Context context, String key, boolean ringtone, boolean loop) {
        stop(key);
        Ringtone sound = RingtoneManager.getRingtone(context.getApplicationContext(), defaultUri(ringtone));
        if (sound == null) return false;
        sound.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(ringtone ? AudioAttributes.USAGE_NOTIFICATION_RINGTONE : AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        if (loop && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) sound.setLooping(true);
        sound.play();
        playing.put(key, sound);
        return true;
    }

    static synchronized void stop(String key) {
        Ringtone sound = playing.remove(key);
        if (sound != null && sound.isPlaying()) sound.stop();
    }

    static synchronized void stopAll() {
        for (Ringtone sound : playing.values()) if (sound.isPlaying()) sound.stop();
        playing.clear();
    }
}
