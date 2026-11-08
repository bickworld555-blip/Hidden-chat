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

    private Alerts() {}

    static PendingIntent openIntent(Context context, String open, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPEN, open == null ? "" : open);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** A message on the direct_messages or group_messages channel, showing its text; tapping opens that chat. */
    static boolean showMessage(Context context, String channel, String title, String body, String tag, String open) {
        String channelId = NotificationChannels.GROUP_MESSAGES.equals(channel) ? NotificationChannels.GROUP_MESSAGES : NotificationChannels.DIRECT_MESSAGES;
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setSound(NotificationChannels.rawSound(context, NotificationChannels.soundFor(channelId)));
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
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, NotificationChannels.INCOMING_CALLS)
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
            builder.setSound(NotificationChannels.rawSound(context, R.raw.incoming_call_ringtone));
            builder.setVibrate(new long[] { 0, 800, 600, 800, 600 });
        }
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(context).notify(CALL_TAG, CALL_NOTIFICATION_ID, notification);
            return true;
        } catch (SecurityException missingPermission) {
            return false;
        }
    }

    static void cancelIncomingCall(Context context) {
        NotificationManagerCompat.from(context).cancel(CALL_TAG, CALL_NOTIFICATION_ID);
    }
}
