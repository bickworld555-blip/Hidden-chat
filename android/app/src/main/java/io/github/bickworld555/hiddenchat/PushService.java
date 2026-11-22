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
        // P7: was it delivered at the priority it was sent with?
        PushStats.record(this, message, type);
        // One event, one handling (a retry, or the same event by another path). A wake-up is checked in
        // handleXmppWake, which the socket path shares.
        if (!"xwake".equals(type) && !PushDedup.firstTime(this, body.optString("pid"))) {
            Log.i(TAG, "repeated push " + type + " dropped");
            return;
        }
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
        // The sender's sealed preview, if there is one: the real text, at once.
        if (showPreview(this, session, from, id, body.optString("pv"))) {
            PushRegistration.markDelivered(this, id);
            return;
        }
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
        handleXmppWake(this, session, body);
    }

    /**
     * The wake-up itself, from Firebase (onXmppWake) or from the always-connected service's own connection (P5,
     * NativeRelay "xmpp:wake"): whichever comes first does the work; the other finds the fetch already running or done.
     */
    static void handleXmppWake(android.content.Context context, RelaySession session, JSONObject body) {
        // The same wake-up over Firebase and the socket (one push id): whichever came first did the work.
        if (!PushDedup.firstTime(context, body.optString("pid"))) {
            Log.i(TAG, "repeated wake-up dropped");
            return;
        }
        // Timings from the server (PUSH_TUNING, inside the encrypted push), within safe bounds; defaults otherwise.
        JSONObject cfg = body.optJSONObject("cfg");
        long fetchWakeMs = tuned(cfg, "w", FetchWake.FETCH_WAKE_MS, 5_000, 170_000);
        long backgroundFetchMs = tuned(cfg, "b", BACKGROUND_FETCH_MS, 5_000, 170_000);
        long fallbackMs = tuned(cfg, "f", FALLBACK_NOTICE_MS, 3_000, 60_000);
        long headlessFallbackMs = tuned(cfg, "h", HEADLESS_FALLBACK_MS, 5_000, 90_000);
        long fallbackMaxMs = tuned(cfg, "x", FALLBACK_MAX_MS, 5_000, 120_000);
        // P3: the CPU stays awake until the fetch says it is done (at most fetchWakeMs), without holding up the next
        // push (a call arriving meanwhile still rings at once).
        FetchWake.hold(context, fetchWakeMs);
        FetchWake.started();
        String from = body.optString("from");
        String groupId = body.optString("groupId");
        // The notification shows now, like WhatsApp's: the real text when the sender sealed a preview for this phone
        // (PreviewKey), else "New message" from this person (or group), replaced by the real line as soon as the app
        // has opened it (1-3 s later with the app closed or the phone locked).
        if (!groupId.isEmpty() || !showPreview(context, session, from, body.optString("id"), body.optString("pv"))) announceArriving(context, session, from, groupId);
        boolean running = HiddenNativePlugin.emitXmppWake();
        if (groupId.isEmpty()) PushRegistration.confirmXmppWake(context);
        if (running) {
            // The app's code is alive (its screen is in the background): like WhatsApp's push service, keep the process
            // awake while it connects, decrypts and stores what waits, sends delivery receipts from this phone and
            // posts the notification with the real text (src/xmpp/session.js backgroundFetch). If it has not posted
            // one for this conversation in time, the sealed notice below appears instead.
            // A short service (WakeKeeper), not MessagingService's dataSync sync: Android 15 refuses dataSync once the
            // app's daily cap is used, which froze the fetch on the S23. The old path only if the short one is refused.
            // It stops as soon as the fetch ends (FetchWake.finished), at the latest after backgroundFetchMs.
            if (!WakeKeeper.keep(context, backgroundFetchMs)) MessagingService.startSync(context, backgroundFetchMs);
            sealedUnlessHandled(context.getApplicationContext(), from, groupId, fallbackMs, fallbackMaxMs);
            return;
        }
        // No app screen: the background page does the same work in a hidden WebView (BackgroundHost). The sealed
        // notice still appears if it has not posted the real one in time (or could not start).
        BackgroundHost.start(context);
        if (BackgroundHost.isRunning() || HeadlessRunner.isRunning()) {
            sealedUnlessHandled(context.getApplicationContext(), from, groupId, headlessFallbackMs, fallbackMaxMs);
            Log.i(TAG, "xmpp wake-up while the app is closed: background page started");
            return;
        }
        FetchWake.finished(context, false);
        showSealedWake(context, session, from, groupId);
        Log.i(TAG, "xmpp wake-up while the app is closed: collected when it opens");
    }

    /**
     * "New message" at once for a conversation the person can be told about: not on screen in the app, not muted,
     * not a locked chat, and one whose name the app has shared (an unknown or hidden sender waits for the app, which
     * decides). A real line of this conversation shown in the last seconds (it came over the connection first) means
     * this push's message is probably on show already.
     */
    static void announceArriving(android.content.Context context, RelaySession session, String from, String groupId) {
        if (AppActivity.isVisible()) return;
        if (!groupId.isEmpty()) {
            String name = RelaySession.groupName(context, groupId, "");
            String tag = "group:" + groupId;
            if (name.isEmpty() || session.mutedGroups.contains(groupId) || Alerts.shownRecently(tag, ARRIVING_RECENT_MS)) return;
            Alerts.showArriving(context, NotificationChannels.messageChannel(context, true, session.groupSound), name, tag, tag,
                RelaySession.userName(context, from, ""), null);
            return;
        }
        if (from.isEmpty()) return;
        String name = RelaySession.userName(context, from, "");
        String tag = "chat:" + from;
        if (name.isEmpty() || session.mutedChats.contains(from) || RelaySession.lockedChats(context).contains(from)
            || Alerts.shownRecently(tag, ARRIVING_RECENT_MS)) return;
        Alerts.showArriving(context, NotificationChannels.messageChannel(context, false, session.messageSound), name, tag, tag,
            null, Avatars.pathFor(from));
    }

    private static final long ARRIVING_RECENT_MS = 5_000;

    /**
     * The real first words of a direct message, from the preview its sender sealed for this phone (src/e2e/preview.js),
     * under the same rules as "New message": not while the app is on screen, not for a muted or locked chat, and only
     * for a sender whose name the app has shared. The message id makes the app's own notification for the same message
     * (posted once it has opened it) a no-op, so it sounds once. False when nothing was shown.
     */
    static boolean showPreview(android.content.Context context, RelaySession session, String from, String messageId, String sealed) {
        if (sealed == null || sealed.isEmpty() || from == null || from.isEmpty() || messageId == null || messageId.isEmpty()) return false;
        if (AppActivity.isVisible()) return false;
        String name = RelaySession.userName(context, from, "");
        if (name.isEmpty() || session.mutedChats.contains(from) || RelaySession.lockedChats(context).contains(from)) return false;
        String text = PreviewKey.open(context, sealed, from);
        if (text == null) return false;
        String tag = "chat:" + from;
        Alerts.showMessage(context, NotificationChannels.messageChannel(context, false, session.messageSound), name, text, tag, tag, 0, messageId,
            null, Avatars.pathFor(from));
        Log.i(TAG, "preview shown from the push");
        return true;
    }

    /** A server-tuned duration from the push's `cfg`, clamped to [min, max]; `fallback` when absent. */
    static long tuned(JSONObject cfg, String key, long fallback, long min, long max) {
        if (cfg == null || !cfg.has(key)) return fallback;
        long value = cfg.optLong(key, fallback);
        return Math.max(min, Math.min(max, value));
    }

    // The latest the sealed notice waits while a fetch is still running (then it stands in after all).
    private static final long FALLBACK_MAX_MS = 25_000;
    // While a fetch runs, the sealed notice checks again this often.
    private static final long FALLBACK_RECHECK_MS = 2_000;

    // A cold start of the background page (process, WebView, connection) takes longer than a living app.
    private static final long HEADLESS_FALLBACK_MS = 12_000;

    // How long a living app gets to fetch in the background, and when the sealed notice stands in for it.
    private static final long BACKGROUND_FETCH_MS = 20_000;
    private static final long FALLBACK_NOTICE_MS = 8_000;

    /**
     * After `delayMs`, the sealed notice, only if the push's message was not handled meanwhile: no notification for the
     * conversation since the push (a message shown before its push counts, Alerts.showMessage), no fetch completed
     * since (it opened and notified everything waiting; nothing new means it was already shown, or is in a muted or
     * hidden chat), and the app not on screen (the person sees it arrive). One message, one notification.
     */
    private static void sealedUnlessHandled(android.content.Context app, String from, String groupId, long delayMs, long maxMs) {
        final String tag = !groupId.isEmpty() ? "group:" + groupId : from.isEmpty() ? "xmpp-wake" : "chat:" + from;
        final long pushedAt = android.os.SystemClock.elapsedRealtime();
        final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (Alerts.postedSince(tag, pushedAt) || FetchWake.completedSince(pushedAt) || AppActivity.isVisible()) return;
                // Still fetching and decrypting (a slow network, many messages): no sealed notice yet, it would stand
                // in for the real one about to be posted. Checked again until the fetch ends or maxMs has passed.
                if (FetchWake.inProgress() && android.os.SystemClock.elapsedRealtime() - pushedAt + FALLBACK_RECHECK_MS <= maxMs) {
                    main.postDelayed(this, FALLBACK_RECHECK_MS);
                    return;
                }
                RelaySession current = RelaySession.read(app);
                if (current != null) showSealedWake(app, current, from, groupId);
            }
        }, delayMs);
    }

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
        MessagingService.startCallSync(this, CALL_SYNC_MS);
    }
}
