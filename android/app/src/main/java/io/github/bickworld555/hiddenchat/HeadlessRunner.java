package io.github.bickworld555.hiddenchat;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONObject;

/**
 * Runs the app's background page (background.html, src/background/main.js) in a hidden WebView at the app's origin,
 * so it shares the app's IndexedDB (the end-to-end keys). That page connects, decrypts, keeps each message in a
 * Keystore-sealed inbox the app imports when it opens, sends delivery receipts from this phone and posts the
 * notification with the real text, then says it is done. Hosted by BackgroundHost (a push) or HeartbeatJob (the
 * hourly check), never both: one runner at a time, main thread only.
 *
 * One writer at a time on the keys: it starts only when no app screen exists; the app's screen stops it the moment
 * it is created (stopForApp, before the app's own code runs), and the app's code also waits for the "hm-e2e" lock the
 * page holds. The bridge is deliberately small: the session, Keystore sealing and posting a notification. No database.
 */
final class HeadlessRunner {
    private static final String TAG = "BackgroundHost";
    // The page's own limit is 15 s (src/xmpp/session.js FETCH_MAX_MS); this is the hard stop.
    private static final long HARD_STOP_MS = 30_000;
    // After the app's screen asks it to stop: time to finish the message in hand, then it is destroyed regardless.
    private static final long STOP_GRACE_MS = 3_000;
    private static final String PAGE = "https://localhost/background.html";

    /** Told once, with the page's reason ("done", "signed-out", "limit", "stopped-for-app", …). */
    interface Done {
        void done(String reason);
    }

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static WebView web;
    private static Done onDone;
    private static Context appContext;
    private static final Runnable hardStop = () -> finish("limit");

    private HeadlessRunner() { }

    static boolean isRunning() {
        return web != null;
    }

    /**
     * Starts the page (main thread). False when the app's screen exists or a page already runs; `done` is then never
     * called.
     */
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    static boolean start(Context context, Done done) {
        if (web != null || AppActivity.isAlive()) return false;
        appContext = context.getApplicationContext();
        onDone = done;
        // The app's files at the app's origin (Capacitor serves dist-android from assets/public at https://localhost).
        WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(appContext);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .setDomain("localhost")
            .addPathHandler("/", path -> assets.handle("public/" + path))
            .build();
        web = new WebView(appContext);
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
        web.addJavascriptInterface(new Bridge(appContext), "HMBackground");
        web.loadUrl(PAGE);
        main.postDelayed(hardStop, HARD_STOP_MS);
        return true;
    }

    /** The app's screen is being created: the page finishes the message in hand and stops; destroyed after the grace. */
    static void stopForApp() {
        main.post(() -> {
            if (web == null) return;
            web.evaluateJavascript("window.__hmBgStop && window.__hmBgStop()", null);
            main.postDelayed(() -> finish("stopped-for-app"), STOP_GRACE_MS);
        });
    }

    /** Ends the page now (main thread) and tells whoever started it. */
    static void finish(String reason) {
        main.removeCallbacks(hardStop);
        if (web == null) return;
        WebView done = web;
        web = null;
        try { done.stopLoading(); } catch (RuntimeException ignored) { }
        try { done.removeJavascriptInterface("HMBackground"); } catch (RuntimeException ignored) { }
        try { done.destroy(); } catch (RuntimeException ignored) { }
        if (appContext != null && "done".equals(reason)) FetchWake.markFetched(appContext);
        FetchWake.release();
        Done callback = onDone;
        onDone = null;
        if (callback != null) callback.done(reason);
    }

    /** What the background page may ask of Android. Called on a WebView binder thread. */
    static final class Bridge {
        private final Context context;

        Bridge(Context context) { this.context = context; }

        /** { origin, token, userId, deviceId } of the signed-in account, or "" when signed out. */
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
            main.post(() -> finish(reason == null ? "done" : reason));
        }
    }
}
