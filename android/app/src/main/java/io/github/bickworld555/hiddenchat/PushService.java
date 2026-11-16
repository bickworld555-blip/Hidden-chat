package io.github.bickworld555.hiddenchat;

import android.util.Log;
import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;

/**
 * Firebase push listener, the counterpart of WhatsApp's GcmListenerService: the app sleeps with no socket open, and
 * a high-priority push wakes it when something arrives.
 *
 * Pushes are wake-ups with ids only (server/push.mjs pushBody): no text, names or photos. The notification names
 * the chat from what the app saved on this phone (RelaySession names), shows "New message" (the content is opened
 * by the app itself), and the delivery receipt goes back over HTTP: no connection, no foreground service. An incoming call rings
 * at once, then a short foreground "sync" (MessagingService) connects to collect the caller's offer so Accept,
 * Decline and Message work, and to notice the caller hanging up.
 */
public class PushService extends FirebaseMessagingService {
    private static final String TAG = "PushService";
    /** How long the phone stays connected after a call push (the ring lasts at most about a minute). */
    private static final long CALL_SYNC_MS = 60_000;

    @Override
    public void onNewToken(@NonNull String token) {
        PushRegistration.register(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        JSONObject body = PushRegistration.decrypt(this, message.getData().get("enc"), message.getData().get("iv"));
        RelaySession session = RelaySession.read(this);
        if (body == null || session == null) return;
        NotificationChannels.ensure(this);
        String type = body.optString("t");
        try {
            switch (type) {
                case "msg": onDirectMessage(session, body); break;
                case "gmsg": onGroupMessage(session, body); break;
                case "react": onReaction(session, body); break;
                case "call": onCall(session, body); break;
                case "call_end": onCallEnd(body); break;
                case "missed": onMissedCall(body); break;
                case "xwake": onXmppWake(session, body); break;
                default: Log.i(TAG, "push of unknown type " + type);
            }
        } catch (RuntimeException failed) {
            Log.w(TAG, "push " + type + " not handled", failed);
        }
    }

    /** A call that rang while this phone was offline: "Missed voice call" with Call back, as soon as it reconnects. */
    private void onMissedCall(JSONObject body) {
        String from = body.optString("from");
        Alerts.missedCallWhileAway(this, body.optString("callId"), from, RelaySession.userName(this, from, "Hidden Messenger"), "video".equals(body.optString("mode")));
    }

    /**
     * The call this phone was rung for by push ended unanswered: still ringing here, it becomes a missed call
     * (notification and call log). Declined on another of my devices, it just stops.
     */
    private void onCallEnd(JSONObject body) {
        if ("declined".equals(body.optString("reason"))) Alerts.cancelIncomingCall(this, body.optString("callId"));
        else Alerts.missedCall(this);
    }

    /**
     * Firebase keeps up to 100 pushes for an offline phone; past that it drops them and says so here. Nothing is lost
     * (the messages wait on the server), but the person must be told to open the app.
     */
    @Override
    public void onDeletedMessages() {
        RelaySession session = RelaySession.read(this);
        if (session == null) return;
        NotificationChannels.ensure(this);
        Alerts.showMessage(this, NotificationChannels.messageChannel(this, false, session.messageSound),
            "Hidden Messenger", "You have new messages", "hm-missed-while-away", "", 0);
    }

    private void onDirectMessage(RelaySession session, JSONObject body) {
        String id = body.optString("id");
        String from = body.optString("from");
        if (!session.mutedChats.contains(from)) {
            String tag = "chat:" + from;
            Alerts.showMessage(this, NotificationChannels.messageChannel(this, false, session.messageSound),
                RelaySession.userName(this, from, "Hidden Messenger"), MessagePreview.of("e2e2:"), tag, tag, 0, id,
                null, Avatars.pathFor(from));
        }
        // The phone has it: one tick becomes two for the sender, as with an open connection.
        PushRegistration.markDelivered(this, id);
    }

    /**
     * A message waits on the XMPP core for this phone (server/xmpp.mjs). The notification is the one an encrypted
     * message gets today (the sender's name, "New message": the content stays sealed until the app opens it), and a
     * running app reconnects at once to collect it. The phone is online and has been told: the server sends the
     * senders their delivery receipts (two grey ticks), as markDelivered does for messages through the server.
     */
    private void onXmppWake(RelaySession session, JSONObject body) {
        String from = body.optString("from");
        boolean running = HiddenNativePlugin.emitXmppWake();
        String groupId = body.optString("groupId");
        if (groupId.isEmpty()) PushRegistration.confirmXmppWake(this);
        if (running) {
            // The app's code is alive (its screen is in the background): like WhatsApp's push service, keep the process
            // awake while it connects, decrypts and stores what waits, sends delivery receipts from this phone and
            // posts the notification with the real text (src/xmpp/session.js backgroundFetch). If it has not posted
            // one for this conversation in time, the sealed notice below appears instead.
            // A short service (WakeKeeper), not MessagingService's dataSync sync: Android 15 refuses dataSync once the
            // app's daily cap is used, which froze the fetch on the S23. The old path only if the short one is refused.
            if (!WakeKeeper.keep(this, BACKGROUND_FETCH_MS)) MessagingService.startSync(this, BACKGROUND_FETCH_MS);
            final String tag = !groupId.isEmpty() ? "group:" + groupId : from.isEmpty() ? "xmpp-wake" : "chat:" + from;
            final long pushedAt = android.os.SystemClock.elapsedRealtime();
            final android.content.Context app = getApplicationContext();
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (Alerts.postedSince(tag, pushedAt)) return;
                RelaySession current = RelaySession.read(app);
                if (current != null) showSealedWake(app, current, from, groupId);
            }, FALLBACK_NOTICE_MS);
            return;
        }
        // No app screen: the background page does the same work in a hidden WebView (BackgroundHost). The sealed
        // notice still appears if it has not posted the real one in time (or could not start).
        BackgroundHost.start(this);
        if (BackgroundHost.isRunning()) {
            final String tag = !groupId.isEmpty() ? "group:" + groupId : from.isEmpty() ? "xmpp-wake" : "chat:" + from;
            final long pushedAt = android.os.SystemClock.elapsedRealtime();
            final android.content.Context app = getApplicationContext();
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (Alerts.postedSince(tag, pushedAt)) return;
                RelaySession current = RelaySession.read(app);
                if (current != null) showSealedWake(app, current, from, groupId);
            }, HEADLESS_FALLBACK_MS);
            Log.i(TAG, "xmpp wake-up while the app is closed: background page started");
            return;
        }
        showSealedWake(this, session, from, groupId);
        Log.i(TAG, "xmpp wake-up while the app is closed: collected when it opens");
    }

    // A cold start of the background page (process, WebView, connection) takes longer than a living app.
    private static final long HEADLESS_FALLBACK_MS = 12_000;

    // How long a living app gets to fetch in the background, and when the sealed notice stands in for it.
    private static final long BACKGROUND_FETCH_MS = 20_000;
    private static final long FALLBACK_NOTICE_MS = 8_000;

    /** The sealed notice (sender's name, "🔒 Message"): the app is closed, or did not post the real one in time. */
    private static void showSealedWake(android.content.Context context, RelaySession session, String from, String groupId) {
        if (!groupId.isEmpty()) {
            // A group message: the group's notification, as for "gmsg" pushes.
            if (session.mutedGroups.contains(groupId)) return;
            String tag = "group:" + groupId;
            Alerts.showMessage(context, NotificationChannels.messageChannel(context, true, session.groupSound),
                RelaySession.groupName(context, groupId, "Group"), MessagePreview.of("e2e2:"), tag, tag, 0, null, RelaySession.userName(context, from, ""), null);
            return;
        }
        if (!from.isEmpty() && session.mutedChats.contains(from)) return;
        String tag = from.isEmpty() ? "xmpp-wake" : "chat:" + from;
        Alerts.showMessage(context, NotificationChannels.messageChannel(context, false, session.messageSound),
            RelaySession.userName(context, from, "Hidden Messenger"), MessagePreview.of("e2e2:"), tag, tag, 0, null,
            null, from.isEmpty() ? null : Avatars.pathFor(from));
    }

    private void onGroupMessage(RelaySession session, JSONObject body) {
        String groupId = body.optString("groupId");
        if (session.mutedGroups.contains(groupId)) return;
        String tag = "group:" + groupId;
        Alerts.showMessage(this, NotificationChannels.messageChannel(this, true, session.groupSound),
            RelaySession.groupName(this, groupId, "Group"), MessagePreview.of("e2e2:"), tag, tag, 0, body.optString("id"),
            RelaySession.userName(this, body.optString("from"), ""), null);
    }

    private void onReaction(RelaySession session, JSONObject body) {
        String from = body.optString("from");
        if (session.mutedChats.contains(from)) return;
        // The emoji is end-to-end encrypted: the app shows it once opened.
        Alerts.showMessage(this, NotificationChannels.messageChannel(this, false, session.messageSound),
            RelaySession.userName(this, from, "Hidden Messenger"), "Reacted to your message", "reaction:" + body.optString("id"), "chat:" + from, 0, "react:" + body.optString("id"));
    }

    private void onCall(RelaySession session, JSONObject body) {
        String from = body.optString("from");
        // Ring now (full-screen call screen over the lock screen), then connect to fetch the offer.
        Alerts.showIncomingCall(this, body.optString("callId"), from, RelaySession.userName(this, from, "Hidden Messenger"),
            "video".equals(body.optString("mode")), session.ringtoneSound, from.isEmpty() ? null : Avatars.pathFor(from));
        // It rang here: tell the server, so the caller sees "Ringing" (onMessageReceived runs off the main thread).
        PushRegistration.confirmRinging(this, body.optString("callId"));
        MessagingService.startSync(this, CALL_SYNC_MS);
    }
}
