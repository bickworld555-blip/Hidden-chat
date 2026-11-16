package io.github.bickworld555.hiddenchat;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONObject;

/**
 * Processes messages on push when the app's process had no screen (swiped away, killed, or never opened since boot),
 * like WhatsApp's GcmFGService: a short foreground service runs the app's own background page
 * (background.html, src/background/main.js) in a hidden WebView at the app's origin, so it shares the app's
 * IndexedDB (the end-to-end keys). That page connects, decrypts, keeps each message in a Keystore-sealed inbox the app
 * imports when it opens, sends delivery receipts from this phone and posts the notification with the real text.
 *
 * One writer at a time: it starts only when no app screen exists; the app's screen stops it the moment it is created
 * (stopForApp, before the app's own code runs), and the app's code also waits for the "hm-e2e" lock the page holds.
 * The bridge is deliberately small: the session, Keystore seal/open, and posting a notification. No database access.
 */
public class BackgroundHost extends Service {
    private static final String TAG = "BackgroundHost";
    private static final int NOTIFICATION_ID = 1003;
    // The page's own limit is 15 s (src/background/main.js); this is the hard stop.
    private static final long HARD_STOP_MS = 30_000;
    // After the app's screen asks it to stop: time to finish the message in hand, then it is destroyed regardless.
    private static final long STOP_GRACE_MS = 3_000;
    private static final String PAGE = "https://localhost/background.html";

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static volatile BackgroundHost instance;
    private static volatile boolean running;

    private WebView web;

    /** Starts the background page for a push; nothing when the app's screen exists or it already runs. */
    static void start(Context context) {
        if (AppActivity.isAlive() || running) return;
        Context app = context.getApplicationContext();
        try {
            ContextCompat.startForegroundService(app, new Intent(app, BackgroundHost.class));
            running = true;
        } catch (RuntimeException notAllowed) {
            Log.w(TAG, "foreground service refused: the sealed notice stands in", notAllowed);
        }
    }

    static boolean isRunning() {
        return running;
    }

    /** The app's screen is being created: the page finishes the message in hand and stops; destroyed after the grace. */
    static void stopForApp() {
        BackgroundHost host = instance;
        if (host == null) return;
        main.post(() -> {
            if (host.web != null) host.web.evaluateJavascript("window.__hmBgStop && window.__hmBgStop()", null);
        });
        main.postDelayed(host::finish, STOP_GRACE_MS);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        running = true;
        NotificationChannels.ensure(this);
        Notification notice = new NotificationCompat.Builder(this, NotificationChannels.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle("Checking for new messages")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build();
        try {
            // Android 14+: a short service (made for a few seconds of work, no daily quota). "dataSync" is capped at
            // 6 h a day for the whole app on Android 15 and was refused once the app's other services had used it.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTIFICATION_ID, notice);
        } catch (RuntimeException refused) {
            Log.w(TAG, "could not go to the foreground", refused);
            finish();
            return START_NOT_STICKY;
        }
        // The app's screen appeared in the meantime: it does the work itself.
        if (AppActivity.isAlive()) { finish(); return START_NOT_STICKY; }
        if (web == null) open();
        main.postDelayed(this::finish, HARD_STOP_MS);
        return START_NOT_STICKY;
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void open() {
        Context app = getApplicationContext();
        // The app's files at the app's origin (Capacitor serves dist-android from assets/public at https://localhost).
        WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(app);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .setDomain("localhost")
            .addPathHandler("/", path -> assets.handle("public/" + path))
            .build();
        web = new WebView(app);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            // The page never navigates anywhere else.
            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(app), "HMBackground");
        web.loadUrl(PAGE);
    }

    private void finish() {
        main.removeCallbacksAndMessages(null);
        if (web != null) {
            WebView done = web;
            web = null;
            try { done.stopLoading(); } catch (RuntimeException ignored) { }
            try { done.removeJavascriptInterface("HMBackground"); } catch (RuntimeException ignored) { }
            try { done.destroy(); } catch (RuntimeException ignored) { }
        }
        running = false;
        if (instance == this) instance = null;
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (RuntimeException ignored) { }
        stopSelf();
    }

    // A short service's time is up (about 3 minutes; the page is done long before): stop at once.
    @Override
    public void onTimeout(int startId) {
        finish();
    }

    @Override
    public void onDestroy() {
        if (web != null) finish();
        running = false;
        if (instance == this) instance = null;
        super.onDestroy();
    }

    /** What the background page may ask of Android. Called on a WebView binder thread. */
    static final class Bridge {
        private final Context context;

        Bridge(Context context) { this.context = context; }

        /** { origin, token, userId, deviceId, lockedChats: [...] } of the signed-in account, or "" when signed out. */
        @JavascriptInterface
        public String session() {
            RelaySession session = RelaySession.read(context);
            String deviceId = RelaySession.deviceId(context);
            if (session == null || deviceId == null) return "";
            try {
                return new JSONObject()
                    .put("origin", session.origin)
                    .put("token", session.token)
                    .put("userId", session.userId)
                    .put("deviceId", deviceId)
                    .toString();
            } catch (Exception broken) {
                return "";
            }
        }

        /** Keystore-sealed text (SecureStore), or "" when the Keystore refuses. */
        @JavascriptInterface
        public String seal(String plain) {
            try { return SecureStore.seal(plain); } catch (Exception broken) { return ""; }
        }

        /**
         * The notification for a message the page opened: { kind: "chat" | "group", from, groupId?, body, messageId }.
         * Muted chats stay silent; a locked chat shows neither name nor text (src/chatLock.js).
         */
        @JavascriptInterface
        public boolean notify(String json) {
            try {
                JSONObject item = new JSONObject(json);
                RelaySession session = RelaySession.read(context);
                if (session == null) return false;
                String from = item.optString("from");
                String groupId = item.optString("groupId");
                boolean group = "group".equals(item.optString("kind")) && !groupId.isEmpty();
                String body = item.optString("body");
                String messageId = item.optString("messageId", null);
                NotificationChannels.ensure(context);
                if (group) {
                    if (session.mutedGroups.contains(groupId)) return true;
                    String tag = "group:" + groupId;
                    return Alerts.showMessage(context, NotificationChannels.messageChannel(context, true, session.groupSound),
                        RelaySession.groupName(context, groupId, "Group"), body, tag, tag, 0, messageId, RelaySession.userName(context, from, ""), null);
                }
                if (from.isEmpty() || session.mutedChats.contains(from)) return true;
                String tag = "chat:" + from;
                boolean locked = RelaySession.lockedChats(context).contains(from);
                return Alerts.showMessage(context, NotificationChannels.messageChannel(context, false, session.messageSound),
                    locked ? "Hidden Messenger" : RelaySession.userName(context, from, "Hidden Messenger"),
                    locked ? "New message" : body, tag, tag, 0, messageId, null, locked ? null : Avatars.pathFor(from));
            } catch (Exception broken) {
                return false;
            }
        }

        @JavascriptInterface
        public void log(String text) {
            Log.i(TAG, text == null ? "" : text.length() > 300 ? text.substring(0, 300) : text);
        }

        /** The page has finished (or will not run): the hidden WebView goes away. */
        @JavascriptInterface
        public void done(String reason) {
            Log.i(TAG, "done: " + reason);
            main.post(() -> { BackgroundHost host = instance; if (host != null) host.finish(); });
        }
    }
}
