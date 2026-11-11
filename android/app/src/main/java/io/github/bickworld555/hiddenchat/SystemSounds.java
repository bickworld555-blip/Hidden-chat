package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The phone's own sounds (Samsung, Xiaomi, Pixel… each brand has its own): its default ringtone / notification
 * sound for the in-app "Default" choice, and its full list of ringtones and notification sounds for picking one.
 */
final class SystemSounds {
    private static final Map<String, Ringtone> playing = new HashMap<>();

    /** One sound from the phone's list. */
    static final class Sound {
        final String uri;
        final String title;

        Sound(String uri, String title) {
            this.uri = uri;
            this.title = title;
        }
    }

    private SystemSounds() {}

    static Uri defaultUri(boolean ringtone) {
        return ringtone ? Settings.System.DEFAULT_RINGTONE_URI : Settings.System.DEFAULT_NOTIFICATION_URI;
    }

    /** `sound` is a parsed SoundChoice other than "": "default" or a sound URI from list(). */
    static synchronized boolean play(Context context, String key, String sound, boolean ringtone, boolean loop) {
        stop(key);
        Uri uri = SoundChoice.PHONE_DEFAULT.equals(sound) ? defaultUri(ringtone) : Uri.parse(sound);
        Ringtone tone = RingtoneManager.getRingtone(context.getApplicationContext(), uri);
        if (tone == null) return false;
        tone.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(ringtone ? AudioAttributes.USAGE_NOTIFICATION_RINGTONE : AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        if (loop && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) tone.setLooping(true);
        tone.play();
        playing.put(key, tone);
        return true;
    }

    /** The phone's ringtones or notification sounds, in the order its own sound settings list them. */
    static List<Sound> list(Context context, boolean ringtone) {
        List<Sound> sounds = new ArrayList<>();
        RingtoneManager manager = new RingtoneManager(context.getApplicationContext());
        manager.setType(ringtone ? RingtoneManager.TYPE_RINGTONE : RingtoneManager.TYPE_NOTIFICATION);
        Cursor cursor = null;
        try {
            cursor = manager.getCursor();
            while (cursor.moveToNext()) {
                Uri uri = manager.getRingtoneUri(cursor.getPosition());
                String title = cursor.getString(RingtoneManager.TITLE_COLUMN_INDEX);
                if (uri != null && title != null && !title.isEmpty()) sounds.add(new Sound(uri.toString(), title));
            }
        } catch (RuntimeException unreadable) {
            // Some phones refuse the media query (storage being scanned, a restricted profile): no list, not a crash.
        } finally {
            if (cursor != null) cursor.close();
        }
        return sounds;
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
