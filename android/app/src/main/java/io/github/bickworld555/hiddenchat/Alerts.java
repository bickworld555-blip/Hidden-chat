package io.github.bickworld555.hiddenchat;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;

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
        return showMessage(context, channel, title, body, tag, open, count, messageId, null, null);
    }

    static boolean showMessage(Context context, String channel, String title, String body, String tag, String open, int count) {
        return showMessage(context, channel, title, body, tag, open, count, null, null, null);
    }

    // The last lines of each conversation's notification, shown stacked like WhatsApp's ("jo" / "shakil").
    private static final class Line {
        final String sender;
        final CharSequence text;
        final long at;
        Line(String sender, CharSequence text, long at) { this.sender = sender; this.text = text; this.at = at; }
    }
    private static final java.util.Map<String, java.util.ArrayList<Line>> history = new java.util.HashMap<>();
    private static final int HISTORY_LINES = 7;

    /**
     * A conversation notification: the chat's photo and name with its latest lines (a group shows each sender),
     * and Reply / Mark as read / Mute. `count` is this chat's unread total (0: continue the running count), shown
     * on the notification and, on most launchers, the app icon badge. `sender` names the person in a group (null
     * for one-to-one chats); `avatar` is the server path of the photo to show (null: none).
     */
    static boolean showMessage(Context context, String channel, String title, String body, String tag, String open, int count,
                               String messageId, String sender, String avatar) {
        if (!firstNotice(messageId)) return true;
        String channelId = NotificationChannels.isMessageChannel(channel) ? channel : NotificationChannels.DIRECT_MESSAGES;
        String key = tag == null || tag.isEmpty() ? channelId : tag;
        String name = title == null || title.isEmpty() ? "Hidden Messenger" : title;
        boolean group = channelId.startsWith(NotificationChannels.GROUP_MESSAGES);
        java.util.ArrayList<Line> lines;
        int unread;
        synchronized (Alerts.class) {
            java.util.ArrayList<Line> kept = history.get(key);
            if (kept == null) { kept = new java.util.ArrayList<>(); history.put(key, kept); }
            kept.add(new Line(sender, body == null ? "" : body, System.currentTimeMillis()));
            while (kept.size() > HISTORY_LINES) kept.remove(0);
            lines = new java.util.ArrayList<>(kept);
            unread = count > 0 ? count : nextCount(key);
            counts.put(key, unread);
        }
        android.graphics.Bitmap photo = Avatars.circle(context, avatar);
        Person chat = new Person.Builder().setName(name).setKey(key)
            .setIcon(photo == null ? null : androidx.core.graphics.drawable.IconCompat.createWithBitmap(photo)).build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(new Person.Builder().setName("You").build());
        if (group) style.setConversationTitle(name).setGroupConversation(true);
        for (Line line : lines) {
            Person from = group && line.sender != null && !line.sender.isEmpty() ? new Person.Builder().setName(line.sender).build() : chat;
            style.addMessage(line.text, line.at, from);
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(name)
            .setContentText(body == null ? "" : body)
            .setStyle(style)
            .setContentIntent(openIntent(context, open, key.hashCode()))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        builder.setNumber(unread);
        if (photo != null) builder.setLargeIcon(photo);
        addMessageActions(context, builder, key, open);
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
     * list). `callerId`: who is calling (for "Call back" if it is missed). `avatar`: the caller's profile photo path on
     * the server (shown on the call screen and the missed-call notification), or null.
     */
    static boolean showIncomingCall(Context context, String callId, String callerId, String caller, boolean video, String ringtoneSound, String avatar) {
        String id = callId == null ? "" : callId;
        ringingCaller = new MissedCaller(callerId, caller, video, avatar);
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
    // "Reply" (typed right in the notification) for one-to-one chats; "Mark as read" and "Mute" for every conversation.
    private static void addMessageActions(Context context, NotificationCompat.Builder builder, String tag, String open) {
        if (open == null || open.isEmpty()) return;
        if (open.startsWith("chat:")) {
            Intent reply = new Intent(context, MessageActionReceiver.class)
                .setAction(MessageActionReceiver.ACTION_REPLY)
                .putExtra(EXTRA_OPEN, open)
                .putExtra(MessageActionReceiver.EXTRA_TAG, tag);
            // Mutable: Android writes the typed text into it.
            int mutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
            PendingIntent replyIntent = PendingIntent.getBroadcast(context, tag.hashCode() * 31 + 1, reply, mutable | PendingIntent.FLAG_UPDATE_CURRENT);
            RemoteInput input = new RemoteInput.Builder(MessageActionReceiver.KEY_TEXT).setLabel("Reply").build();
            builder.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_hidden, "Reply", replyIntent)
                .addRemoteInput(input)
                .setAllowGeneratedReplies(true)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setShowsUserInterface(false)
                .build());
        }
        Intent read = new Intent(context, MessageActionReceiver.class)
            .setAction(MessageActionReceiver.ACTION_READ)
            .putExtra(EXTRA_OPEN, open)
            .putExtra(MessageActionReceiver.EXTRA_TAG, tag);
        PendingIntent readIntent = PendingIntent.getBroadcast(context, tag.hashCode() * 31 + 2, read, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        builder.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_hidden, "Mark as read", readIntent)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build());
        Intent mute = new Intent(context, MessageActionReceiver.class)
            .setAction(MessageActionReceiver.ACTION_MUTE)
            .putExtra(EXTRA_OPEN, open)
            .putExtra(MessageActionReceiver.EXTRA_TAG, tag);
        PendingIntent muteIntent = PendingIntent.getBroadcast(context, tag.hashCode() * 31 + 3, mute, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        builder.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_hidden, "Mute", muteIntent)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MUTE)
            .setShowsUserInterface(false)
            .build());
    }

    /** A reply typed in a notification while the app was closed: it is end-to-end encrypted by the app, so it waits. */
    static void showReplyWaiting(Context context, String tag, String open, String text) {
        if (tag == null || tag.isEmpty()) return;
        synchronized (Alerts.class) { counts.remove(tag); }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, NotificationChannels.UPLOADS)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle("Reply not sent yet")
            .setContentText("Open Hidden Messenger to send it: " + text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText("Open Hidden Messenger to send it securely:\n" + text))
            .setContentIntent(openIntent(context, open, tag.hashCode()))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try {
            NotificationManagerCompat.from(context).notify(tag, 1, builder.build());
        } catch (SecurityException missingPermission) {
            // Notifications were turned off meanwhile: the reply still waits in the queue.
        }
    }

    static void cancelMessage(Context context, String tag) {
        if (tag == null || tag.isEmpty()) return;
        synchronized (Alerts.class) { counts.remove(tag); history.remove(tag); }
        NotificationManagerCompat.from(context).cancel(tag, 1);
    }

    static void cancelAllMessages(Context context) {
        android.app.NotificationManager manager = context.getSystemService(android.app.NotificationManager.class);
        synchronized (Alerts.class) { counts.clear(); history.clear(); }
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        for (android.service.notification.StatusBarNotification posted : manager.getActiveNotifications()) {
            if (posted.getId() == 1) manager.cancel(posted.getTag(), posted.getId());
        }
    }

    /** The caller gave up (a push says so): stop ringing if it is still this call, and say it was missed. */
    static void cancelIncomingCall(Context context, String callId) {
        if (!ringing || callId == null || !(callId.equals(ringingCallId) || ringingCallId == null || ringingCallId.isEmpty())) return;
        missedCall(context);
    }

    // Who is ringing now, so a call that stops ringing unanswered can be shown as missed.
    private static final class MissedCaller {
        final String id;
        final String name;
        final boolean video;
        final String avatar;
        MissedCaller(String id, String name, boolean video, String avatar) { this.id = id; this.name = name; this.video = video; this.avatar = avatar; }
    }
    private static volatile MissedCaller ringingCaller;
    private static final java.util.Map<String, Integer> missedCounts = new java.util.HashMap<>();
    static final String EXTRA_CALL_BACK = "hm_call_back";
    static final String EXTRA_CALL_BACK_MODE = "hm_call_back_mode";

    /**
     * The caller hung up (or the call timed out) while this phone was still ringing: stop ringing and post
     * "Missed voice call" / "2 missed calls" with the caller's photo, Call back and Message, like WhatsApp.
     * Calls declined or answered here are not missed (ringing has already stopped by then).
     */
    static void missedCall(Context context) {
        MissedCaller caller = ringingCaller;
        boolean wasRinging = ringing;
        cancelIncomingCall(context);
        if (!wasRinging || caller == null || caller.id == null || caller.id.isEmpty()) return;
        final Context app = context.getApplicationContext();
        // The photo is fetched from the network: never on the thread that delivered the event.
        new Thread(() -> postMissedCall(app, caller), "missed-call").start();
    }

    private static void postMissedCall(Context context, MissedCaller caller) {
        String tag = "missed:" + caller.id;
        int count;
        synchronized (Alerts.class) {
            Integer previous = missedCounts.get(tag);
            count = previous == null ? 1 : previous + 1;
            missedCounts.put(tag, count);
        }
        String name = caller.name == null || caller.name.isEmpty() ? "Hidden Messenger" : caller.name;
        String text = count > 1 ? count + " missed calls" : caller.video ? "Missed video call" : "Missed voice call";
        String open = "chat:" + caller.id;
        Intent back = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_CALL_BACK, caller.id)
            .putExtra(EXTRA_CALL_BACK_MODE, caller.video ? "video" : "audio");
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent callBack = PendingIntent.getActivity(context, tag.hashCode() * 31 + 7, back, flags);
        android.graphics.Bitmap photo = Avatars.circle(context, caller.avatar != null ? caller.avatar : Avatars.pathFor(caller.id));
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, NotificationChannels.MISSED_CALLS)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(name)
            .setContentText(text)
            .setContentIntent(openIntent(context, open, tag.hashCode()))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setNumber(count)
            .addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_hidden, "Call back", callBack).build())
            .addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_hidden, "Message", openIntent(context, open, tag.hashCode() * 31 + 8)).build());
        if (photo != null) builder.setLargeIcon(photo);
        try {
            NotificationManagerCompat.from(context).notify(tag, 1, builder.build());
        } catch (SecurityException missingPermission) {
            // Notifications are off: the call log in the app still lists it.
        }
    }

    /** The missed-call notification for this person is gone (opened, called back or the chat was read). */
    static void clearMissedCalls(Context context, String callerId) {
        String tag = "missed:" + callerId;
        synchronized (Alerts.class) { missedCounts.remove(tag); }
        NotificationManagerCompat.from(context).cancel(tag, 1);
    }

    static void cancelIncomingCall(Context context) {
        NotificationManagerCompat.from(context).cancel(CALL_TAG, CALL_NOTIFICATION_ID);
        ringing = false;
        ringingCallId = null;
        lastCallScreen = null;
        releaseScreen();
        IncomingCallActivity.dismiss();
        ringingCaller = null;
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
