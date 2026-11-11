package io.github.bickworld555.hiddenchat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Android notification channels. Each message kind has its own sound: Android fixes a channel's sound
 * when the channel is first created, so change an id here if a sound file changes after release.
 */
final class NotificationChannels {
    static final String DIRECT_MESSAGES = "direct_messages";
    static final String GROUP_MESSAGES = "group_messages";
    static final String INCOMING_CALLS = "incoming_calls";
    static final String CONNECTION = "connection";
    // The ongoing call (timer and Hang up): visible in the shade but silent.
    static final String ONGOING_CALL = "ongoing_call";
    // Files being sent ("Sending 2 files · 45%"): quiet, with a progress bar.
    static final String UPLOADS = "uploads";
    // "Missed voice call" / "2 missed calls" with Call back and Message.
    static final String MISSED_CALLS = "missed_calls";
    // The same three with the phone's own default sounds, for the in-app "Default" tone choice.
    static final String DIRECT_MESSAGES_PHONE = "direct_messages_phone";
    static final String GROUP_MESSAGES_PHONE = "group_messages_phone";
    static final String INCOMING_CALLS_PHONE = "incoming_calls_phone";

    // A sound picked from the phone's own list ("Standard ringtones") gets a channel of its own, named by this prefix
    // and the sound's hash; only the current pick for each kind is kept.
    private static final String PICKED = "_pick_";
    // The sound each picked channel was made with, for Android 7 (no channels: the sound goes on each notification).
    private static final Map<String, Uri> pickedSounds = new HashMap<>();

    static boolean isMessageChannel(String channel) {
        return channel != null && (channel.startsWith(DIRECT_MESSAGES) || channel.startsWith(GROUP_MESSAGES));
    }

    private NotificationChannels() {}

    static Uri rawSound(Context context, int resource) {
        return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.getPackageName() + "/" + resource);
    }

    /** The channel for a message alert with a SoundChoice (app tone, phone default or a picked phone sound). */
    static String messageChannel(Context context, boolean group, String sound) {
        String base = group ? GROUP_MESSAGES : DIRECT_MESSAGES;
        if (sound.isEmpty()) return base;
        if (SoundChoice.PHONE_DEFAULT.equals(sound)) return group ? GROUP_MESSAGES_PHONE : DIRECT_MESSAGES_PHONE;
        return pickedChannel(context, base, sound, group ? "Group Messages" : "Direct Messages", false);
    }

    /** The channel for a ringing call with a SoundChoice. */
    static String callChannel(Context context, String sound) {
        if (sound.isEmpty()) return INCOMING_CALLS;
        if (SoundChoice.PHONE_DEFAULT.equals(sound)) return INCOMING_CALLS_PHONE;
        return pickedChannel(context, INCOMING_CALLS, sound, "Incoming Calls", true);
    }

    /** The sound a channel plays: what Android 7 needs on each notification (channels arrived with Android 8). */
    static Uri soundOf(Context context, String channel) {
        if (DIRECT_MESSAGES_PHONE.equals(channel) || GROUP_MESSAGES_PHONE.equals(channel)) return SystemSounds.defaultUri(false);
        if (INCOMING_CALLS_PHONE.equals(channel)) return SystemSounds.defaultUri(true);
        synchronized (pickedSounds) {
            Uri picked = pickedSounds.get(channel);
            if (picked != null) return picked;
        }
        if (channel.startsWith(GROUP_MESSAGES)) return rawSound(context, R.raw.group_message);
        if (channel.startsWith(INCOMING_CALLS)) return rawSound(context, R.raw.incoming_call_ringtone);
        return rawSound(context, R.raw.normal_message);
    }

    private static AudioAttributes attributes(boolean ringtone) {
        return new AudioAttributes.Builder()
            .setUsage(ringtone ? AudioAttributes.USAGE_NOTIFICATION_RINGTONE : AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    private static String pickedChannel(Context context, String base, String sound, String name, boolean ringtone) {
        String id = base + PICKED + Integer.toHexString(sound.hashCode());
        Uri uri = Uri.parse(sound);
        synchronized (pickedSounds) { pickedSounds.put(id, uri); }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return id;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return base;
        if (manager.getNotificationChannel(id) == null) {
            NotificationChannel channel = new NotificationChannel(id, name + " (chosen sound)", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(ringtone ? "Ringing calls, with the ringtone you chose" : "Messages, with the sound you chose");
            channel.setSound(uri, attributes(ringtone));
            channel.enableVibration(true);
            if (ringtone) {
                channel.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
                channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
            }
            manager.createNotificationChannel(channel);
        }
        // Earlier picks for this kind are no longer used.
        for (NotificationChannel existing : manager.getNotificationChannels()) {
            String other = existing.getId();
            if (other.startsWith(base + PICKED) && !other.equals(id)) manager.deleteNotificationChannel(other);
        }
        return id;
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

        NotificationChannel ongoingCall = new NotificationChannel(ONGOING_CALL, "Ongoing calls", NotificationManager.IMPORTANCE_DEFAULT);
        ongoingCall.setDescription("The call in progress, with a Hang up button");
        ongoingCall.setSound(null, null);
        ongoingCall.enableVibration(false);
        ongoingCall.setShowBadge(false);
        ongoingCall.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        NotificationChannel directPhone = new NotificationChannel(DIRECT_MESSAGES_PHONE, "Direct Messages (phone sound)", NotificationManager.IMPORTANCE_HIGH);
        directPhone.setDescription("Messages from one person, with this phone's default notification sound");
        directPhone.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, message);
        directPhone.enableVibration(true);

        NotificationChannel groupPhone = new NotificationChannel(GROUP_MESSAGES_PHONE, "Group Messages (phone sound)", NotificationManager.IMPORTANCE_HIGH);
        groupPhone.setDescription("Messages in groups, with this phone's default notification sound");
        groupPhone.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, message);
        groupPhone.enableVibration(true);

        NotificationChannel callsPhone = new NotificationChannel(INCOMING_CALLS_PHONE, "Incoming Calls (phone ringtone)", NotificationManager.IMPORTANCE_HIGH);
        callsPhone.setDescription("Ringing calls, with this phone's default ringtone");
        callsPhone.setSound(android.provider.Settings.System.DEFAULT_RINGTONE_URI, ringtone);
        callsPhone.enableVibration(true);
        callsPhone.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
        callsPhone.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        NotificationChannel uploads = new NotificationChannel(UPLOADS, "Sending files", NotificationManager.IMPORTANCE_LOW);
        uploads.setDescription("Shown while photos, videos and files are being sent");
        uploads.setSound(null, null);
        uploads.setShowBadge(false);

        NotificationChannel missed = new NotificationChannel(MISSED_CALLS, "Missed calls", NotificationManager.IMPORTANCE_HIGH);
        missed.setDescription("Calls you did not answer, with Call back and Message");
        missed.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, message);
        missed.enableVibration(true);

        manager.createNotificationChannels(Arrays.asList(direct, group, calls, connection, ongoingCall, directPhone, groupPhone, callsPhone, uploads, missed));
    }
}
