package io.github.bickworld555.hiddenchat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import java.util.Arrays;

/**
 * Android notification channels. Each message kind has its own sound: Android fixes a channel's sound
 * when the channel is first created, so change an id here if a sound file changes after release.
 */
final class NotificationChannels {
    static final String DIRECT_MESSAGES = "direct_messages";
    static final String GROUP_MESSAGES = "group_messages";
    static final String INCOMING_CALLS = "incoming_calls";
    static final String CONNECTION = "connection";

    private NotificationChannels() {}

    static Uri rawSound(Context context, int resource) {
        return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.getPackageName() + "/" + resource);
    }

    static int soundFor(String channel) {
        if (GROUP_MESSAGES.equals(channel)) return R.raw.group_message;
        if (INCOMING_CALLS.equals(channel)) return R.raw.incoming_call_ringtone;
        return R.raw.normal_message;
    }

    static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        AudioAttributes message = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        AudioAttributes ringtone = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();

        NotificationChannel direct = new NotificationChannel(DIRECT_MESSAGES, "Direct Messages", NotificationManager.IMPORTANCE_HIGH);
        direct.setDescription("Messages from one person");
        direct.setSound(rawSound(context, R.raw.normal_message), message);
        direct.enableVibration(true);

        NotificationChannel group = new NotificationChannel(GROUP_MESSAGES, "Group Messages", NotificationManager.IMPORTANCE_HIGH);
        group.setDescription("Messages in groups");
        group.setSound(rawSound(context, R.raw.group_message), message);
        group.enableVibration(true);

        NotificationChannel calls = new NotificationChannel(INCOMING_CALLS, "Incoming Calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Ringing voice and video calls");
        calls.setSound(rawSound(context, R.raw.incoming_call_ringtone), ringtone);
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
        calls.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        NotificationChannel connection = new NotificationChannel(CONNECTION, "Background connection", NotificationManager.IMPORTANCE_MIN);
        connection.setDescription("Shown while Hidden Messenger stays connected in the background");
        connection.setSound(null, null);
        connection.setShowBadge(false);

        manager.createNotificationChannels(Arrays.asList(direct, group, calls, connection));
    }
}
