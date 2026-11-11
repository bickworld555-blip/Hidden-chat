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

    // Messages already notified (by id): the push and a connection may both deliver the same message.
    private static final java.util.LinkedHashSet<String> notifiedIds = new java.util.LinkedHashSet<>();

    /** True the first time a message id is seen; later copies (from another delivery path) are dropped. */
    static synchronized boolean firstNotice(String messageId) {
        if (messageId == null || messageId.isEmpty()) return true;
        if (!notifiedIds.add(messageId)) return false;
        if (notifiedIds.size() > 300) {
            java.util.Iterator<String> oldest = notifiedIds.iterator();
            oldest.next();
            oldest.remove();
        }
        return true;
    }

    /** As showMessage, once per message id however many ways the message arrives (push, connection, the app). */
    static boolean showMessage(Context context, String channel, String title, String body, String tag, String open, int count, String messageId) {
        if (!firstNotice(messageId)) return true;
        return showMessage(context, channel, title, body, tag, open, count);
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
            builder.setSound(NotificationChannels.soundOf(context, channelId));
            builder.setDefaults(NotificationCompat.DEFAULT_VIBRATE);
        }
        try {
            NotificationManagerCompat.from(context).notify(key, 1, builder.build());
            return true;
        } catch (SecurityException missingPermission) {
            return false;
        }
    }

    /**
     * Heads-up / full-screen incoming call with Accept and Reject; the ringtone repeats until it is handled.
     * `ringtoneSound`: a SoundChoice (the app's ringtone, the phone's default or a ringtone picked from the phone's
     * list). `avatar`: the caller's profile photo path on the server (shown on the call screen), or null.
     */
    static boolean showIncomingCall(Context context, String callId, String caller, boolean video, String ringtoneSound, String avatar) {
        String id = callId == null ? "" : callId;
        // Already ringing for this call (the push rang first, then the connection brought the offer): keep ringing.
        if (ringing && !id.isEmpty() && id.equals(ringingCallId)) return true;
        String name = caller == null || caller.isEmpty() ? "Hidden Messenger" : caller;
        // The full-screen call is a native screen: it shows the moment the phone lights up, without waiting for the
        // app's web screen to load (which left a black screen over the lock screen while the ringtone played).
        Intent show = IncomingCallActivity.intent(context, id, name, video, avatar);
        lastCallScreen = show;
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

        Person person = new Person.Builder().setName(name).setImportant(true).build();
        String channelId = NotificationChannels.callChannel(context, SoundChoice.parse(ringtoneSound));
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
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
            builder.setSound(NotificationChannels.soundOf(context, channelId));
            builder.setVibrate(new long[] { 0, 800, 600, 800, 600 });
        }
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(context).notify(CALL_TAG, CALL_NOTIFICATION_ID, notification);
            ringing = true;
            ringingCallId = id;
            // Android hears about it too (headset / car / watch can answer; call waiting with SIM calls).
            TelecomCalls.incoming(context, id, name, video);
            MainActivity.callRinging(context);
            wakeScreen(context);
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

    /** The caller gave up (a push says so): stop ringing if it is still this call. */
    static void cancelIncomingCall(Context context, String callId) {
        if (!ringing || callId == null || !(callId.equals(ringingCallId) || ringingCallId == null || ringingCallId.isEmpty())) return;
        cancelIncomingCall(context);
    }

    static void cancelIncomingCall(Context context) {
        NotificationManagerCompat.from(context).cancel(CALL_TAG, CALL_NOTIFICATION_ID);
        ringing = false;
        ringingCallId = null;
        lastCallScreen = null;
        releaseScreen();
        IncomingCallActivity.dismiss();
        MainActivity.callWindowChanged();
        TelecomCalls.ringingStopped();
    }

    private static volatile Intent lastCallScreen;

    /**
     * Android's Telecom asks for the ringing call's screen (ConnectionService.onShowIncomingCallUi): on a locked or
     * dark phone open it directly too, besides the notification's full-screen intent. Where Android does not let a
     * background app open a screen this is ignored, and the full-screen notification shows it as before.
     */
    static void showCallScreenIfAway(Context context) {
        Intent show = lastCallScreen;
        if (show == null || !ringing) return;
        android.app.KeyguardManager keyguard = context.getSystemService(android.app.KeyguardManager.class);
        android.os.PowerManager power = context.getSystemService(android.os.PowerManager.class);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        boolean dark = power != null && !power.isInteractive();
        if (!locked && !dark) return; // phone in use: the heads-up call banner, like WhatsApp
        try {
            context.startActivity(new Intent(show));
        } catch (RuntimeException blocked) {
            // Not allowed here: the full-screen notification does it.
        }
    }

    private static android.os.PowerManager.WakeLock screenLock;

    private static final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    /**
     * Makes sure the screen lights while a call rings. Normally the full-screen call screen does that itself, but
     * Android 14+ turns "full-screen notifications" off for apps installed outside the Play Store, and some phone
     * makers ignore them: then the phone only rang with a dark screen. With the screen on, the lock screen shows the
     * call with its Decline and Answer buttons. Without the permission it wakes at once; with it, only if the screen
     * is still dark a moment later (waking first would make Android show a small banner instead of the call screen).
     */
    private static void wakeScreen(Context context) {
        Context app = context.getApplicationContext();
        android.app.NotificationManager notifications = app.getSystemService(android.app.NotificationManager.class);
        boolean fullScreenAllowed = Build.VERSION.SDK_INT < 34 || notifications == null || notifications.canUseFullScreenIntent();
        if (!fullScreenAllowed) {
            holdScreenOn(app);
            return;
        }
        main.postDelayed(() -> {
            android.os.PowerManager power = app.getSystemService(android.os.PowerManager.class);
            if (ringing && power != null && !power.isInteractive()) holdScreenOn(app);
        }, 2000);
    }

    /** Screen on until the call stops ringing (at the latest after a minute). */
    @SuppressWarnings("deprecation")
    private static synchronized void holdScreenOn(Context context) {
        android.os.PowerManager power = context.getSystemService(android.os.PowerManager.class);
        if (power == null) return;
        if (screenLock == null) {
            screenLock = power.newWakeLock(android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                | android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP | android.os.PowerManager.ON_AFTER_RELEASE, "HiddenMessenger:ringing");
            screenLock.setReferenceCounted(false);
        }
        screenLock.acquire(60 * 1000L);
    }

    private static synchronized void releaseScreen() {
        if (screenLock != null && screenLock.isHeld()) screenLock.release();
    }

    private static volatile boolean ringing;
    private static volatile String ringingCallId;
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
        if (!value) TelecomCalls.ringingStopped();
    }
}
