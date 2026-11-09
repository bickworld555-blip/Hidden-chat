package io.github.bickworld555.hiddenchat;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;

/**
 * Message and incoming-call notifications, shared by the web app (through HiddenNativePlugin) and the
 * service's own connection (NativeRelay) so both look and behave the same.
 */
final class Alerts {
    static final String EXTRA_OPEN = "hm_open";
    static final String EXTRA_CALL_ID = "hm_call_id";
    static final String EXTRA_CALL = "hm_call";
    static final String ACTION_ACCEPT = "io.github.bickworld555.hiddenchat.CALL_ACCEPT";
    static final String ACTION_SHOW_CALL = "io.github.bickworld555.hiddenchat.CALL_SHOW";
    private static final String CALL_TAG = "incoming_call";
    private static final int CALL_NOTIFICATION_ID = 2001;

    // Unread count per conversation notification, shared by the WebView and the background connection.
    private static final java.util.Map<String, Integer> counts = new java.util.HashMap<>();

    private Alerts() {}

    static synchronized int nextCount(String tag) {
        Integer previous = counts.get(tag);
        return previous == null ? 1 : previous + 1;
    }

    static PendingIntent openIntent(Context context, String open, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPEN, open == null ? "" : open);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** A message on the direct_messages or group_messages channel, showing its text; tapping opens that chat. */
    static boolean showMessage(Context context, String channel, String title, String body, String tag, String open) {
        return showMessage(context, channel, title, body, tag, open, 0);
    }

    /** `count` is this chat's unread total: shown on the notification and, on most launchers, the app icon badge. */
    static boolean showMessage(Context context, String channel, String title, String body, String tag, String open, int count) {
        String channelId = NotificationChannels.isMessageChannel(channel) ? channel : NotificationChannels.DIRECT_MESSAGES;
        String key = tag == null || tag.isEmpty() ? channelId : tag;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(title == null || title.isEmpty() ? "Hidden Messenger" : title)
            .setContentText(body == null ? "" : body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body == null ? "" : body))
            .setContentIntent(openIntent(context, open, key.hashCode()))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        // No count from the caller (groups, reactions): continue this conversation's running count.
        int unread = count > 0 ? count : nextCount(key);
        builder.setNumber(unread);
        synchronized (Alerts.class) { counts.put(key, unread); }
        if (unread > 1) builder.setSubText(unread + " new messages");
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setSound(NotificationChannels.isPhoneSound(channelId)
                ? SystemSounds.defaultUri(false)
                : NotificationChannels.rawSound(context, NotificationChannels.soundFor(channelId)));
            builder.setDefaults(NotificationCompat.DEFAULT_VIBRATE);
        }
        try {
            NotificationManagerCompat.from(context).notify(key, 1, builder.build());
            return true;
        } catch (SecurityException missingPermission) {
            return false;
        }
    }

    /** Heads-up / full-screen incoming call with Accept and Reject; the ringtone repeats until it is handled. */
    static boolean showIncomingCall(Context context, String callId, String caller, boolean video) {
        return showIncomingCall(context, callId, caller, video, false);
    }

    /** `phoneRingtone`: ring with this phone's default ringtone (the in-app "Default" choice). */
    static boolean showIncomingCall(Context context, String callId, String caller, boolean video, boolean phoneRingtone) {
        String id = callId == null ? "" : callId;
        Intent show = new Intent(context, MainActivity.class)
            .setAction(ACTION_SHOW_CALL)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_CALL, true)
            .putExtra(EXTRA_CALL_ID, id);
        Intent accept = new Intent(context, MainActivity.class)
            .setAction(ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_CALL, true)
            .putExtra(EXTRA_CALL_ID, id);
        Intent reject = new Intent(context, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_REJECT)
            .putExtra(EXTRA_CALL_ID, id);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent showIntent = PendingIntent.getActivity(context, 3001, show, flags);
        PendingIntent acceptIntent = PendingIntent.getActivity(context, 3002, accept, flags);
        PendingIntent rejectIntent = PendingIntent.getBroadcast(context, 3003, reject, flags);

        String name = caller == null || caller.isEmpty() ? "Hidden Messenger" : caller;
        Person person = new Person.Builder().setName(name).setImportant(true).build();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, phoneRingtone ? NotificationChannels.INCOMING_CALLS_PHONE : NotificationChannels.INCOMING_CALLS)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(name)
            .setContentText(video ? "Incoming video call" : "Incoming voice call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(showIntent)
            .setFullScreenIntent(showIntent, true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, rejectIntent, acceptIntent).setIsVideo(video));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setSound(phoneRingtone ? SystemSounds.defaultUri(true) : NotificationChannels.rawSound(context, R.raw.incoming_call_ringtone));
            builder.setVibrate(new long[] { 0, 800, 600, 800, 600 });
        }
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(context).notify(CALL_TAG, CALL_NOTIFICATION_ID, notification);
            ringing = true;
            // App on screen (or in the background): light the screen and show the call over the lock screen now.
            MainActivity.callWindowChanged();
            return true;
        } catch (SecurityException missingPermission) {
            return false;
        }
    }

    /** The chat was read: its notification (and its share of the icon badge) goes away. */
    static void cancelMessage(Context context, String tag) {
        if (tag == null || tag.isEmpty()) return;
        synchronized (Alerts.class) { counts.remove(tag); }
        NotificationManagerCompat.from(context).cancel(tag, 1);
    }

    static void cancelAllMessages(Context context) {
        android.app.NotificationManager manager = context.getSystemService(android.app.NotificationManager.class);
        synchronized (Alerts.class) { counts.clear(); }
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        for (android.service.notification.StatusBarNotification posted : manager.getActiveNotifications()) {
            if (posted.getId() == 1) manager.cancel(posted.getTag(), posted.getId());
        }
    }

    static void cancelIncomingCall(Context context) {
        NotificationManagerCompat.from(context).cancel(CALL_TAG, CALL_NOTIFICATION_ID);
        ringing = false;
        MainActivity.callWindowChanged();
    }

    private static volatile boolean ringing;
    private static volatile boolean appRinging;

    /**
     * An incoming call is ringing: its full-screen notification is up, or the app itself shows the ringing call.
     * The second matters on the lock screen: once the app is in front it withdraws the notification, and if that
     * also ended "show over the lock screen" the app would drop behind the lock screen, post the notification
     * again, come back, and flash in a loop.
     */
    static boolean isRinging() {
        return ringing || appRinging;
    }

    static void setAppRinging(boolean value) {
        appRinging = value;
        MainActivity.callWindowChanged();
    }
}
