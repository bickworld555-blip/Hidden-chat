package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The service's own connection, used only while the app's screen (and its WebView socket) is gone — e.g. after
 * the user swipes the app away. It keeps the phone reachable: confirms delivery (two ticks), shows message
 * notifications, and rings incoming calls with Accept / Reject. It connects as "relay.background", so the server
 * never shows the user as online because of it. While the app is open the WebView handles everything instead.
 */
final class NativeRelay extends WebSocketListener {
    private static final long MAX_BACKOFF_MS = 30_000;
    private static final long PENDING_CALL_TTL_MS = 60_000;
    private static NativeRelay current;

    // The last incoming call this connection rang for, with the caller's ICE candidates, so that "Accept"
    // can hand it to the web app once it opens (the web app was not connected when the offer arrived).
    private static JSONObject pendingCall;
    private static final List<JSONObject> pendingIce = new ArrayList<>();
    private static long pendingAt;

    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build();
    private WebSocket socket;
    private boolean running;
    private int attempt;
    private ConnectivityManager.NetworkCallback networkCallback;

    private NativeRelay(Context context) {
        this.context = context.getApplicationContext();
    }

    static synchronized void start(Context context) {
        if (RelaySession.read(context) == null) return;
        if (current == null) current = new NativeRelay(context);
        current.begin();
    }

    static synchronized void stop() {
        if (current != null) current.end();
        current = null;
    }

    static synchronized boolean isRunning() {
        return current != null && current.running;
    }

    /** "Accept" tapped while the app was closed: the stored offer and candidates, or null when stale. */
    static synchronized JSONObject takePendingCall() {
        if (pendingCall == null || System.currentTimeMillis() - pendingAt > PENDING_CALL_TTL_MS) {
            clearPending();
            return null;
        }
        JSONObject result = new JSONObject();
        try {
            result.put("event", pendingCall);
            result.put("ice", new JSONArray(pendingIce));
        } catch (Exception ignored) {
            return null;
        }
        clearPending();
        return result;
    }

    /** "Message" on a ringing call while the app was closed: send the quick reply to the caller first. */
    static synchronized boolean replyToPendingCall(String callId, String text) {
        if (pendingCall == null || current == null || current.socket == null || text == null || text.trim().isEmpty()) return false;
        if (callId != null && !callId.isEmpty() && !callId.equals(pendingCall.optString("callId"))) return false;
        try {
            JSONObject message = new JSONObject()
                .put("id", UUID.randomUUID().toString())
                .put("receiverId", pendingCall.optString("from"))
                .put("content", text.trim());
            current.socket.send(new JSONObject().put("type", "message:send").put("message", message).toString());
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** "Reject" tapped while the app was closed: tell the caller through this connection. */
    static synchronized boolean declinePendingCall(String callId) {
        if (pendingCall == null || current == null || current.socket == null) return false;
        String pendingId = pendingCall.optString("callId");
        if (callId != null && !callId.isEmpty() && !callId.equals(pendingId)) return false;
        try {
            JSONObject end = new JSONObject()
                .put("type", "call:signal")
                .put("targetId", pendingCall.optString("from"))
                .put("callId", pendingId)
                .put("mode", pendingCall.optString("mode", "audio"))
                .put("signalId", UUID.randomUUID().toString())
                .put("signal", new JSONObject().put("type", "end").put("reason", "ended"));
            current.socket.send(end.toString());
        } catch (Exception ignored) {
            return false;
        }
        clearPending();
        return true;
    }

    private static void clearPending() {
        pendingCall = null;
        pendingIce.clear();
        pendingAt = 0;
    }

    private synchronized void begin() {
        if (running) return;
        running = true;
        attempt = 0;
        watchNetwork();
        connect();
    }

    private synchronized void end() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        if (socket != null) socket.close(1000, "App opened");
        socket = null;
        if (networkCallback != null) {
            ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
            try { manager.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) { }
            networkCallback = null;
        }
    }

    private synchronized void connect() {
        if (!running || socket != null) return;
        RelaySession session = RelaySession.read(context);
        if (session == null) {
            end();
            return;
        }
        Request request = new Request.Builder()
            .url(session.websocketUrl())
            .header("Sec-WebSocket-Protocol", "relay.auth." + session.token + ", relay.v1, relay.background")
            .build();
        socket = client.newWebSocket(request, this);
    }

    private synchronized void scheduleReconnect() {
        if (!running) return;
        long delay = Math.min(MAX_BACKOFF_MS, 1000L << Math.min(attempt, 5));
        attempt += 1;
        handler.postDelayed(this::connect, delay);
    }

    /** Reconnect at once when the network comes back instead of waiting out the backoff. */
    private void watchNetwork() {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    synchronized (NativeRelay.this) {
                        if (!running || socket != null) return;
                        handler.removeCallbacksAndMessages(null);
                        attempt = 0;
                        connect();
                    }
                });
            }
        };
        try { manager.registerDefaultNetworkCallback(networkCallback); } catch (Exception ignored) { networkCallback = null; }
    }

    @Override
    public void onOpen(WebSocket webSocket, Response response) {
        synchronized (this) {
            if (webSocket == socket) attempt = 0;
        }
    }

    @Override
    public void onMessage(WebSocket webSocket, String text) {
        synchronized (this) {
            if (webSocket != socket) return;
        }
        try {
            handle(new JSONObject(text));
        } catch (Exception malformed) {
            // Ignore events this version does not understand.
        }
    }

    @Override
    public void onClosing(WebSocket webSocket, int code, String reason) {
        webSocket.close(code, null);
        onGone(webSocket, code);
    }

    @Override
    public void onClosed(WebSocket webSocket, int code, String reason) {
        onGone(webSocket, code);
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable error, Response response) {
        onGone(webSocket, response != null && response.code() == 401 ? 4001 : 1006);
    }

    private void onGone(WebSocket webSocket, int code) {
        synchronized (this) {
            if (webSocket != socket) return;
            socket = null;
            if (code == 4001) {
                // Signed out (here or from another device) or the token no longer works: stop for good.
                RelaySession.clear(context);
                end();
                handler.post(() -> MessagingService.stop(context));
                return;
            }
        }
        scheduleReconnect();
    }

    private void send(JSONObject event) {
        WebSocket target;
        synchronized (this) {
            target = socket;
        }
        if (target != null) target.send(event.toString());
    }

    private void handle(JSONObject event) throws Exception {
        RelaySession session = RelaySession.read(context);
        if (session == null) return;
        String type = event.optString("type");
        if ("message:new".equals(type)) {
            JSONObject message = event.optJSONObject("message");
            if (message == null) return;
            String sender = message.optString("senderId");
            if (!session.userId.equals(message.optString("receiverId")) || session.userId.equals(sender)) return;
            if ("sent".equals(message.optString("status"))) {
                send(new JSONObject().put("type", "message:delivered").put("messageIds", new JSONArray().put(message.optString("id"))));
            }
            if (session.mutedChats.contains(sender)) return;
            String name = message.optString("senderName");
            String title = name.isEmpty() ? "@" + message.optString("senderUsername", "someone") : name;
            String tag = "chat:" + sender;
            Alerts.showMessage(context, session.phoneMessageSound ? NotificationChannels.DIRECT_MESSAGES_PHONE : NotificationChannels.DIRECT_MESSAGES,
                title, MessagePreview.of(message.optString("content")), tag, tag, Alerts.nextCount(tag));
        } else if ("group:message".equals(type)) {
            JSONObject message = event.optJSONObject("message");
            if (message == null || session.userId.equals(message.optString("senderId"))) return;
            String groupId = message.optString("groupId");
            if (session.mutedGroups.contains(groupId)) return;
            String senderName = event.optString("senderName", "");
            String body = MessagePreview.of(message.optString("content"));
            String tag = "group:" + groupId;
            Alerts.showMessage(context, session.phoneGroupSound ? NotificationChannels.GROUP_MESSAGES_PHONE : NotificationChannels.GROUP_MESSAGES,
                event.optString("groupName", "Group"), senderName.isEmpty() ? body : senderName + ": " + body, tag, tag, Alerts.nextCount(tag));
        } else if ("message:reaction".equals(type)) {
            // Someone reacted to a message I sent: a notification like WhatsApp's "Reacted ❤️ to: …".
            String reactor = event.optString("userId");
            String emoji = event.optString("emoji", "");
            if (emoji.isEmpty() || event.isNull("emoji") || !session.userId.equals(event.optString("messageSenderId")) || session.userId.equals(reactor)) return;
            if (session.mutedChats.contains(reactor)) return;
            String preview = MessagePreview.of(event.optString("messageContent"));
            String body = "Reacted " + emoji + (preview.isEmpty() ? " to your message" : " to: \u201C" + preview + "\u201D");
            Alerts.showMessage(context, session.phoneMessageSound ? NotificationChannels.DIRECT_MESSAGES_PHONE : NotificationChannels.DIRECT_MESSAGES,
                event.optString("reactorName", "Reaction"), body, "reaction:" + event.optString("messageId"), "chat:" + reactor);
        } else if ("call:signal".equals(type)) {
            handleCallSignal(event);
        } else if ("call:invite".equals(type)) {
            synchronized (NativeRelay.class) {
                pendingCall = event;
                pendingIce.clear();
                pendingAt = System.currentTimeMillis();
            }
            Alerts.showIncomingCall(context, "", callerName(event), "video".equals(event.optString("mode")), session.phoneRingtone, callerAvatar(event));
        }
    }

    private void handleCallSignal(JSONObject event) {
        JSONObject signal = event.optJSONObject("signal");
        if (signal == null) return;
        String callId = event.optString("callId");
        String signalType = signal.optString("type");
        synchronized (NativeRelay.class) {
            if ("offer".equals(signalType) && (pendingCall == null || !callId.equals(pendingCall.optString("callId")))) {
                pendingCall = event;
                pendingIce.clear();
                pendingAt = System.currentTimeMillis();
                RelaySession current = RelaySession.read(context);
                Alerts.showIncomingCall(context, callId, callerName(event), "video".equals(event.optString("mode")), current != null && current.phoneRingtone, callerAvatar(event));
                return;
            }
            if (pendingCall == null || !callId.equals(pendingCall.optString("callId"))) return;
            if ("ice".equals(signalType)) {
                if (pendingIce.size() < 64) pendingIce.add(event);
            } else if ("end".equals(signalType)) {
                // The caller gave up (or another device answered): stop ringing.
                clearPending();
                Alerts.cancelIncomingCall(context);
            }
        }
    }

    private static String callerAvatar(JSONObject event) {
        JSONObject from = event.optJSONObject("fromUser");
        String avatar = from == null || from.isNull("avatar") ? "" : from.optString("avatar");
        return avatar.isEmpty() ? null : avatar;
    }

    private static String callerName(JSONObject event) {
        JSONObject from = event.optJSONObject("fromUser");
        if (from == null) return "Hidden Messenger";
        String name = from.optString("name");
        return name.isEmpty() ? "@" + from.optString("username", "someone") : name;
    }
}
