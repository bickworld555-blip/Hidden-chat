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
 * Messages, group messages and reactions carry their (encrypted) text, so the notification shows straight from the
 * push and the delivery receipt goes back over HTTP: no connection, no foreground service. An incoming call rings
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
                case "call_end": Alerts.cancelIncomingCall(this, body.optString("callId")); break;
                case "xwake": onXmppWake(session, body); break;
                default: Log.i(TAG, "push of unknown type " + type);
            }
        } catch (RuntimeException failed) {
            Log.w(TAG, "push " + type + " not handled", failed);
        }
    }

    private void onDirectMessage(RelaySession session, JSONObject body) {
        String id = body.optString("id");
        String from = body.optString("from");
        if (!session.mutedChats.contains(from)) {
            String tag = "chat:" + from;
            String avatar = body.isNull("avatar") ? null : body.optString("avatar", null);
            Alerts.showMessage(this, NotificationChannels.messageChannel(this, false, session.messageSound),
                body.optString("senderName", "New message"), MessagePreview.of(body.optString("content")), tag, tag, 0, id,
                null, avatar == null || avatar.isEmpty() ? Avatars.pathFor(from) : avatar);
        }
        // The phone has it: one tick becomes two for the sender, as with an open connection.
        PushRegistration.markDelivered(this, id);
    }

    /**
     * A message waits on the XMPP core for this phone (server/xmpp.mjs). The notification is the one an encrypted
     * message gets today (the sender's name, "New message": the content stays sealed until the app opens it), and a
     * running app reconnects at once to collect it. No delivery tick here: the app sends that receipt only once the
     * message is stored on the phone.
     */
    private void onXmppWake(RelaySession session, JSONObject body) {
        String from = body.optString("from");
        boolean running = HiddenNativePlugin.emitXmppWake();
        String groupId = body.optString("groupId");
        if (!groupId.isEmpty()) {
            // A group message: the group's notification, as for "gmsg" pushes.
            if (session.mutedGroups.contains(groupId)) return;
            String tag = "group:" + groupId;
            Alerts.showMessage(this, NotificationChannels.messageChannel(this, true, session.groupSound),
                body.optString("groupName", "Group"), MessagePreview.of("e2e2:"), tag, tag, 0, null, body.optString("senderName"), null);
            return;
        }
        if (!from.isEmpty() && session.mutedChats.contains(from)) return;
        String tag = from.isEmpty() ? "xmpp-wake" : "chat:" + from;
        String avatar = body.isNull("avatar") ? null : body.optString("avatar", null);
        Alerts.showMessage(this, NotificationChannels.messageChannel(this, false, session.messageSound),
            body.optString("senderName", "Hidden Messenger"), MessagePreview.of("e2e2:"), tag, tag, 0, null,
            null, avatar == null || avatar.isEmpty() ? (from.isEmpty() ? null : Avatars.pathFor(from)) : avatar);
        if (!running) Log.i(TAG, "xmpp wake-up while the app is closed: collected when it opens");
    }

    private void onGroupMessage(RelaySession session, JSONObject body) {
        String groupId = body.optString("groupId");
        if (session.mutedGroups.contains(groupId)) return;
        String preview = MessagePreview.of(body.optString("content"));
        String sender = body.optString("senderName");
        String tag = "group:" + groupId;
        Alerts.showMessage(this, NotificationChannels.messageChannel(this, true, session.groupSound),
            body.optString("groupName", "Group"), preview, tag, tag, 0, body.optString("id"), sender, null);
    }

    private void onReaction(RelaySession session, JSONObject body) {
        String from = body.optString("from");
        String emoji = body.optString("emoji");
        if (emoji.isEmpty() || session.mutedChats.contains(from)) return;
        String preview = MessagePreview.of(body.optString("content"));
        String text = "Reacted " + emoji + (preview.isEmpty() ? " to your message" : " to: “" + preview + "”");
        Alerts.showMessage(this, NotificationChannels.messageChannel(this, false, session.messageSound),
            body.optString("reactorName", "Reaction"), text, "reaction:" + body.optString("id"), "chat:" + from, 0, "react:" + body.optString("id") + ":" + emoji);
    }

    private void onCall(RelaySession session, JSONObject body) {
        String avatar = body.isNull("avatar") ? null : body.optString("avatar", null);
        // Ring now (full-screen call screen over the lock screen), then connect to fetch the offer.
        Alerts.showIncomingCall(this, body.optString("callId"), body.optString("from"), body.optString("callerName", "Hidden Messenger"),
            "video".equals(body.optString("mode")), session.ringtoneSound, avatar);
        MessagingService.startSync(this, CALL_SYNC_MS);
    }
}
