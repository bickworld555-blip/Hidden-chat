package io.github.bickworld555.hiddenchat;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.JSArray;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native side of the Hidden Messenger shell: runtime permissions, the background connection service,
 * channel notifications for direct and group messages, and the incoming-call notification with
 * Accept / Reject actions. The web app calls it through Capacitor as "HiddenNative".
 */
@CapacitorPlugin(
    name = "HiddenNative",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        // Only Android 9 and older need this to save into Download/Hidden Messenger.
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }),
        // Asked only when a feature needs it, like WhatsApp: contacts for Invite a friend, location for sharing it,
        // Bluetooth to route call audio to a headset. Nothing else is requested.
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class HiddenNativePlugin extends Plugin {
    static final String EXTRA_OPEN = Alerts.EXTRA_OPEN;
    static final String EXTRA_CALL_ID = Alerts.EXTRA_CALL_ID;
    static final String ACTION_ACCEPT = Alerts.ACTION_ACCEPT;

    private static HiddenNativePlugin instance;

    @Override
    public void load() {
        instance = this;
        NotificationChannels.ensure(getContext());
        // A page that (re)loads starts without a call: one still marked live belonged to the page that went away.
        getBridge().addWebViewListener(new com.getcapacitor.WebViewListener() {
            @Override
            public void onPageStarted(android.webkit.WebView webView) {
                MessagingService.endOrphanedCall(getContext(), "page reloaded");
            }
        });
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnDestroy() {
        // The WebView is going away; events must not be queued for a bridge that no longer exists.
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        // Only a ringing or ongoing call may show over the lock screen; leaving the app otherwise ends that.
        if (!AppActivity.wantsCallWindow()) setCallWindow(false);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String open = intent.getStringExtra(EXTRA_OPEN);
        if (open != null) {
            JSObject data = new JSObject();
            data.put("open", open);
            notifyListeners("notificationOpen", data, true);
            intent.removeExtra(EXTRA_OPEN);
        }
        String callBack = intent.getStringExtra(Alerts.EXTRA_CALL_BACK);
        if (callBack != null && !callBack.isEmpty()) {
            // "Call back" on a missed-call notification: the app places the call (retained until it listens).
            JSObject data = new JSObject();
            data.put("peerId", callBack);
            data.put("mode", "video".equals(intent.getStringExtra(Alerts.EXTRA_CALL_BACK_MODE)) ? "video" : "audio");
            notifyListeners("callBack", data, true);
            Alerts.clearMissedCalls(getContext(), callBack);
            intent.removeExtra(Alerts.EXTRA_CALL_BACK);
        }
        if (SharedContent.isShare(intent)) {
            // Shared from another app's share sheet: the web app shows a chat picker. Retained until it listens.
            notifyListeners("shareReceived", SharedContent.read(getContext(), intent), true);
            intent.setAction(null);
        }
        if (ACTION_ACCEPT.equals(intent.getAction())) {
            TelecomCalls.answered();
            cancelCallNotification(getContext());
            JSObject extra = new JSObject();
            extra.put("cameraOff", intent.getBooleanExtra(IncomingCallActivity.EXTRA_CAMERA_OFF, false));
            emitCallAction("accept", intent.getStringExtra(EXTRA_CALL_ID), extra);
            intent.setAction(null);
        }
    }

    /** "reply" (with `text`) or "read" from a message notification; false when the app's screen is gone. */
    static boolean emitMessageAction(String action, String open, String text) {
        HiddenNativePlugin plugin = instance;
        if (plugin == null) return false;
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("open", open);
        data.put("text", text);
        plugin.notifyListeners("messageAction", data, true);
        return true;
    }

    /** Notification actions taken while the app's screen was gone: { actions: [{ action, open, text }] }. */
    @PluginMethod
    public void takeMessageActions(PluginCall call) {
        JSObject result = new JSObject();
        try {
            result.put("actions", new JSArray(MessageActionReceiver.take(getContext()).toString()));
        } catch (JSONException broken) {
            result.put("actions", new JSArray());
        }
        call.resolve(result);
    }

    /** Returns false when no WebView is listening (the app's screen is gone). */
    static boolean emitCallAction(String action, String callId) {
        return emitCallAction(action, callId, null);
    }

    /** `extra`: e.g. { cameraOff } for an accept, { text } for a quick reply. */
    static boolean emitCallAction(String action, String callId, JSObject extra) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("callId", callId);
        if (extra != null) for (java.util.Iterator<String> keys = extra.keys(); keys.hasNext();) {
            String key = keys.next();
            data.put(key, extra.opt(key));
        }
        HiddenNativePlugin plugin = instance;
        if (plugin == null) return false;
        plugin.notifyListeners("callAction", data, true);
        return true;
    }

    static void cancelCallNotification(Context context) {
        Alerts.cancelIncomingCall(context);
    }

    private void setCallWindow(boolean visibleOverLock) {
        if (!(getActivity() instanceof AppActivity)) return;
        AppActivity activity = (AppActivity) getActivity();
        // Never drop the lock-screen window while a call still rings or is in progress.
        activity.runOnUiThread(() -> activity.applyCallWindow(visibleOverLock || AppActivity.wantsCallWindow()));
    }

    private boolean granted(String alias) {
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    private JSObject state() {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED);
        result.put("camera", getPermissionState("camera") == PermissionState.GRANTED);
        result.put("contacts", granted("contacts"));
        // "Approximate" is enough to share a location.
        result.put("location", getContext().checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED);
        result.put("sdk", Build.VERSION.SDK_INT);
        // Android 14+ lets only allowed apps show ringing calls full screen on the lock screen (off by default for
        // apps not installed from the Play Store).
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        result.put("fullScreenCalls", Build.VERSION.SDK_INT < 34 || (notifications != null && notifications.canUseFullScreenIntent()));
        result.put("pictureInPicture", pictureInPictureAllowed(context));
        // Firebase push carries messages and calls (no always-on "Connected" service needed).
        result.put("push", PushRegistration.isActive(context));
        return result;
    }

    static boolean pictureInPictureAllowed(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        AppOpsManager ops = context.getSystemService(AppOpsManager.class);
        if (ops == null) return true;
        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, android.os.Process.myUid(), context.getPackageName())
            : ops.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, android.os.Process.myUid(), context.getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED || mode == AppOpsManager.MODE_DEFAULT;
    }

    /** Opens the system page for "show calls full screen" (Android 14+) or picture-in-picture for this app. */
    @PluginMethod
    public void openCallSettings(PluginCall call) {
        String which = call.getString("which", "");
        Context context = getContext();
        Uri pkg = Uri.parse("package:" + context.getPackageName());
        Intent intent;
        if ("fullScreen".equals(which) && Build.VERSION.SDK_INT >= 34) intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg);
        else if ("pictureInPicture".equals(which)) intent = new Intent("android.settings.PICTURE_IN_PICTURE_SETTINGS", pkg);
        else intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (android.content.ActivityNotFoundException missing) {
            context.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /**
     * How the phone is online, for Storage and data › Media auto-download: "wifi" (Wi-Fi or Ethernet), "mobile",
     * "roaming" (mobile data abroad) or "none". Needs only ACCESS_NETWORK_STATE (granted at install).
     */
    // Settings › Appearance › App icon: each icon is a launcher alias of AppActivity (AndroidManifest.xml).
    private static final String[][] APP_ICONS = { { "default", "MainActivity" }, { "midnight", "IconMidnight" }, { "teal", "IconTeal" } };

    private android.content.ComponentName iconComponent(String alias) {
        return new android.content.ComponentName(getContext().getPackageName(), AppActivity.class.getPackage().getName() + "." + alias);
    }

    /** The icon whose launcher entry is enabled ("default" when only the manifest's choice applies). */
    @PluginMethod
    public void getAppIcon(PluginCall call) {
        android.content.pm.PackageManager manager = getContext().getPackageManager();
        String current = "default";
        for (String[] icon : APP_ICONS) {
            int state = manager.getComponentEnabledSetting(iconComponent(icon[1]));
            if (state == android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED && !"default".equals(icon[0])) current = icon[0];
        }
        JSObject result = new JSObject();
        result.put("id", current);
        call.resolve(result);
    }

    /** Switches the launcher icon: the chosen alias is enabled first, then the others disabled, so one always shows. */
    @PluginMethod
    public void setAppIcon(PluginCall call) {
        String id = call.getString("id", "default");
        String chosen = null;
        for (String[] icon : APP_ICONS) if (icon[0].equals(id)) chosen = icon[1];
        if (chosen == null) {
            call.reject("Unknown app icon.");
            return;
        }
        android.content.pm.PackageManager manager = getContext().getPackageManager();
        manager.setComponentEnabledSetting(iconComponent(chosen), android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED, android.content.pm.PackageManager.DONT_KILL_APP);
        for (String[] icon : APP_ICONS) {
            if (icon[1].equals(chosen)) continue;
            manager.setComponentEnabledSetting(iconComponent(icon[1]), android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED, android.content.pm.PackageManager.DONT_KILL_APP);
        }
        JSObject result = new JSObject();
        result.put("id", id);
        call.resolve(result);
    }

    /** Settings › Storage and data › Proxy: { supported, host, port } as saved on this phone. */
    @PluginMethod
    public void getProxy(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", AppProxy.supported());
        result.put("host", AppProxy.host(getContext()));
        result.put("port", AppProxy.port(getContext()));
        call.resolve(result);
    }

    /** Saves and applies a proxy ({ host, port }), or removes it ({ host: "" }). The background connection picks it up when it reconnects. */
    @PluginMethod
    public void setProxy(PluginCall call) {
        String host = call.getString("host", "").trim();
        int port = call.getInt("port", 0);
        if (host.isEmpty()) {
            AppProxy.clear(getContext());
        } else if (!AppProxy.valid(host, port)) {
            call.reject("Enter a host name and a port between 1 and 65535.");
            return;
        } else if (!AppProxy.supported()) {
            call.reject("This phone's web view can't use a proxy. Update Android System WebView and try again.");
            return;
        } else {
            AppProxy.save(getContext(), host, port);
        }
        JSObject result = new JSObject();
        result.put("host", AppProxy.host(getContext()));
        result.put("port", AppProxy.port(getContext()));
        call.resolve(result);
    }

    /**
     * Media upload quality › Standard for videos: { path } (relative to the app's cache folder, written by the web
     * side) is re-encoded to { path, bytes } next to it. The input stays; the caller deletes both when done.
     */
    @PluginMethod
    public void compressVideo(PluginCall call) {
        String path = call.getString("path", "");
        java.io.File cache = getContext().getCacheDir();
        java.io.File input = new java.io.File(cache, path);
        try {
            if (path.isEmpty() || path.contains("..") || !input.getCanonicalPath().startsWith(cache.getCanonicalPath()) || !input.isFile()) {
                call.reject("No such video.");
                return;
            }
        } catch (java.io.IOException unreadable) {
            call.reject("No such video.");
            return;
        }
        java.io.File output = new java.io.File(input.getParentFile(), input.getName() + ".standard.mp4");
        VideoCompressor.compress(getContext(), input, output, call.getInt("shortSide", 720), call.getInt("bitrate", 2_000_000), new VideoCompressor.Done() {
            @Override
            public void ok(java.io.File file) {
                JSObject result = new JSObject();
                result.put("path", path + ".standard.mp4");
                result.put("bytes", file.length());
                call.resolve(result);
            }

            @Override
            public void fail(String reason) {
                call.reject(reason);
            }
        });
    }

    @PluginMethod
    public void networkState(PluginCall call) {
        JSObject result = new JSObject();
        String kind = "none";
        try {
            android.net.ConnectivityManager manager = (android.net.ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.NetworkCapabilities caps = manager == null ? null : manager.getNetworkCapabilities(manager.getActiveNetwork());
            if (caps != null) {
                if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) kind = "wifi";
                else if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) {
                    kind = caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING) ? "mobile" : "roaming";
                } else kind = "wifi"; // VPN over an unknown link, Bluetooth tethering…: treated like Wi-Fi
            }
        } catch (RuntimeException unavailable) {
            kind = "unknown";
        }
        result.put("kind", kind);
        call.resolve(result);
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }

    /** The app's theme: dark icons on the status and navigation bars for the light theme, light icons for dark. */
    @PluginMethod
    public void setSystemBarsTheme(PluginCall call) {
        boolean light = "light".equals(call.getString("theme", "dark"));
        getActivity().runOnUiThread(() -> {
            android.view.Window window = getActivity().getWindow();
            androidx.core.view.WindowInsetsControllerCompat controller =
                androidx.core.view.WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(light);
            controller.setAppearanceLightNavigationBars(light);
            call.resolve();
        });
    }

    @PluginMethod
    public void requestStartupPermissions(PluginCall call) {
        // Only the notification prompt (Android 13+), as WhatsApp asks on first launch; the rest come when used.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted("notifications")) {
            requestPermissionForAlias("notifications", call, "startupPermissionsDone");
        } else {
            call.resolve(state());
        }
    }

    @PermissionCallback
    private void startupPermissionsDone(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void startBackground(PluginCall call) {
        // With push the phone needs no always-on service; without it (yet) the "Connected" service keeps it reachable.
        MessagingService.applyMode(getContext());
        PushRegistration.ensure(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stopBackground(PluginCall call) {
        MessagingService.stop(getContext());
        call.resolve();
    }

    /**
     * The signed-in account for the service's own connection (used once the app is swiped away), with the
     * muted chats and groups so a closed app stays as quiet as an open one. Called on sign-in and whenever
     * the app goes to the background.
     */
    @PluginMethod
    public void setSession(PluginCall call) {
        Set<String> mutedChats = new HashSet<>(stringList(call.getArray("mutedChats")));
        Set<String> mutedGroups = new HashSet<>(stringList(call.getArray("mutedGroups")));
        boolean saved = RelaySession.save(getContext(), call.getString("origin"), call.getString("token"), call.getString("userId"), mutedChats, mutedGroups,
            call.getString("messageSound", ""), call.getString("groupSound", ""), call.getString("ringtoneSound", ""));
        if (saved) PushRegistration.ensure(getContext());
        JSObject result = new JSObject();
        result.put("saved", saved);
        call.resolve(result);
    }

    /** A call started or ended: while active the service keeps the microphone (and camera) working in the background. */
    @PluginMethod
    public void setCallActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        MessagingService.setCall(getContext(), active, video, call.getString("name"));
        CallActionReceiver.activeCallId = active ? call.getString("callId") : null;
        // Voice calls start on the earpiece (or a headset), video calls on the loudspeaker.
        if (active) CallAudio.start(getContext(), video);
        else CallAudio.stop(getContext());
        JSObject result = new JSObject();
        result.put("speaker", CallAudio.isSpeaker());
        call.resolve(result);
    }

    /**
     * Seals a secret with the Android Keystore (SecureStore) — used by the web app to protect its local data key:
     * { value } → { sealed }. The Keystore key never leaves Android, so the sealed value is useless off the phone.
     */
    @PluginMethod
    public void sealSecret(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("sealed", SecureStore.seal(call.getString("value")));
            call.resolve(result);
        } catch (Exception broken) {
            call.reject("The Android Keystore is not available.");
        }
    }

    /** Invite a friend: the phone's contacts with numbers, read on the device ([] without permission). */
    @PluginMethod
    public void listContacts(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("allowed", Invites.allowed(getContext(), Manifest.permission.READ_CONTACTS));
            result.put("contacts", Invites.contacts(getContext()));
            call.resolve(result);
        } catch (Exception broken) {
            call.reject("Contacts could not be read.");
        }
    }

    /**
     * Opens the phone's messages app with the number and the invite filled in, for the person to send (no SMS
     * permission needed), the way WhatsApp invites by text.
     */
    @PluginMethod
    public void openSmsComposer(PluginCall call) {
        String number = call.getString("number", "");
        String text = call.getString("text", "");
        try {
            Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)));
            intent.putExtra("sms_body", text);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception missing) {
            call.reject("No messages app is available.");
        }
    }

    /** Asks for contacts (Invite a friend), then reports the state. */
    @PluginMethod
    public void requestInvitePermissions(PluginCall call) {
        requestPermissionForAlias("contacts", call, "startupPermissionsDone");
    }

    /** App lock and screen security state: { biometric: available|none|unsupported, secureScreen, transcription }. */
    @PluginMethod
    public void securityStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("biometric", AppSecurity.status(getContext()));
        result.put("secureScreen", AppSecurity.secureScreen(getContext()));
        result.put("transcription", VoiceTranscriber.available(getContext()));
        call.resolve(result);
    }

    /** The phone's own unlock (fingerprint, face, or its PIN / pattern / password): { ok, error? }. */
    @PluginMethod
    public void authenticate(PluginCall call) {
        AppSecurity.authenticate(getActivity(), call.getString("title"), call.getString("subtitle"), (ok, error) -> {
            JSObject result = new JSObject();
            result.put("ok", ok);
            if (error != null) result.put("error", error);
            call.resolve(result);
        });
    }

    /** Screen security (FLAG_SECURE): no screenshots or recordings, blank in recent apps. */
    @PluginMethod
    public void setSecureScreen(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        AppSecurity.setSecureScreen(getActivity(), enabled);
        JSObject result = new JSObject();
        result.put("secureScreen", enabled);
        call.resolve(result);
    }

    /** Saves bytes made on the phone (a chat backup or export, base64) into Download/Hidden Messenger. */
    @PluginMethod
    public void saveBytes(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "saveBytesPermissionDone");
            return;
        }
        startSaveBytes(call);
    }

    @PermissionCallback
    private void saveBytesPermissionDone(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) startSaveBytes(call);
        else call.reject("Allow storage access to save files.");
    }

    private void startSaveBytes(PluginCall call) {
        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(call.getString("data", ""), android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException broken) {
            call.reject("Nothing to save.");
            return;
        }
        MediaSaver.saveBytes(getContext(), bytes, call.getString("filename", "file"), call.getString("mimeType", ""), (saved) -> {
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("path", saved.path);
            call.resolve(result);
        }, call::reject);
    }

    /** A voice message transcript made on the phone (Android 13+): { text } or { error }. */
    @PluginMethod
    public void transcribeAudio(PluginCall call) {
        byte[] audio;
        try {
            audio = android.util.Base64.decode(call.getString("data", ""), android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException broken) {
            call.reject("No audio.");
            return;
        }
        VoiceTranscriber.transcribe(getContext(), audio, call.getString("language"), (text, error) -> {
            JSObject result = new JSObject();
            if (text != null) result.put("text", text);
            if (error != null) result.put("error", error);
            call.resolve(result);
        });
    }

    /** Opens what sealSecret produced: { sealed } → { value }. */
    @PluginMethod
    public void openSecret(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("value", SecureStore.open(call.getString("sealed")));
            call.resolve(result);
        } catch (Exception broken) {
            call.reject("This secret cannot be opened on this phone (the Keystore key changed).");
        }
    }

    /** The web app's upload queue: { count, label, progress } — keeps a "Sending…" foreground service while count > 0. */
    @PluginMethod
    public void setUploads(PluginCall call) {
        UploadService.update(getContext(), call.getInt("count", 0), call.getString("label", ""), call.getInt("progress", 0));
        call.resolve();
    }

    /** The call ended in the app: clear every trace of it at once (see MessagingService.hardReset). */
    @PluginMethod
    public void endCall(PluginCall call) {
        Context context = getContext();
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            MessagingService.hardReset(context, "ended in the app");
            setCallWindow(false);
            call.resolve();
        });
    }

    /** The web app's call is still live (sent every few seconds while it lasts). */
    @PluginMethod
    public void callHeartbeat(PluginCall call) {
        MessagingService.heartbeat();
        call.resolve();
    }

    /** Outgoing-call ringback on the call stream (earpiece by default for voice calls). Resolves { played }. */
    @PluginMethod
    public void startRingback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("played", CallAudio.startRingback());
        call.resolve(result);
    }

    @PluginMethod
    public void stopRingback(PluginCall call) {
        CallAudio.stopRingback();
        call.resolve();
    }

    /** Video call: whether any camera is on. Both off → earpiece like a voice call; one back on → loudspeaker. */
    @PluginMethod
    public void setCallVideoShown(PluginCall call) {
        CallAudio.setVideoShown(getContext(), Boolean.TRUE.equals(call.getBoolean("shown", true)));
        JSObject result = new JSObject();
        result.put("speaker", CallAudio.isSpeaker());
        call.resolve(result);
    }

    /** The in-call speaker button: loudspeaker on/off (off = earpiece or headset). */
    @PluginMethod
    public void setSpeaker(PluginCall call) {
        CallAudio.setSpeaker(getContext(), Boolean.TRUE.equals(call.getBoolean("on", false)));
        JSObject result = new JSObject();
        result.put("speaker", CallAudio.isSpeaker());
        call.resolve(result);
    }

    /**
     * A phone sound: `sound` is a SoundChoice ("default" or a URI from listSystemSounds); `ringtone` says which
     * default and which audio stream (ringtone for calls, notification sound otherwise).
     */
    @PluginMethod
    public void playSystemSound(PluginCall call) {
        String sound = SoundChoice.parse(call.getString("sound", SoundChoice.PHONE_DEFAULT));
        boolean played = SystemSounds.play(getContext(), call.getString("key", "default"), sound.isEmpty() ? SoundChoice.PHONE_DEFAULT : sound,
            Boolean.TRUE.equals(call.getBoolean("ringtone", false)), Boolean.TRUE.equals(call.getBoolean("loop", false)));
        JSObject result = new JSObject();
        result.put("played", played);
        call.resolve(result);
    }

    /** The phone's own ringtones (`ringtone`) or notification sounds, as { sounds: [{ uri, title }] }. */
    @PluginMethod
    public void listSystemSounds(PluginCall call) {
        boolean ringtone = Boolean.TRUE.equals(call.getBoolean("ringtone", false));
        // Plugin methods run on Capacitor's plugin thread, so the media query does not block the UI.
        JSArray sounds = new JSArray();
        for (SystemSounds.Sound sound : SystemSounds.list(getContext(), ringtone)) {
            JSObject item = new JSObject();
            item.put("uri", sound.uri);
            item.put("title", sound.title);
            sounds.put(item);
        }
        JSObject result = new JSObject();
        result.put("sounds", sounds);
        call.resolve(result);
    }

    @PluginMethod
    public void stopSystemSound(PluginCall call) {
        SystemSounds.stop(call.getString("key", "default"));
        call.resolve();
    }

    /** A chat was read: remove its notification (and its part of the icon badge); no tag clears every chat. */
    @PluginMethod
    public void clearMessageNotifications(PluginCall call) {
        String tag = call.getString("tag");
        if (tag == null || tag.isEmpty()) Alerts.cancelAllMessages(getContext());
        else Alerts.cancelMessage(getContext(), tag);
        // Reading someone's chat also clears their missed-call notification, like WhatsApp.
        if (tag != null && tag.startsWith("chat:")) Alerts.clearMissedCalls(getContext(), tag.substring(5));
        call.resolve();
    }

    /** Missed-call notifications: one person's ({ peerId }) or all of them (the Calls tab was opened). */
    @PluginMethod
    public void clearMissedCalls(PluginCall call) {
        String peerId = call.getString("peerId");
        if (peerId == null || peerId.isEmpty()) Alerts.clearAllMissedCalls(getContext());
        else Alerts.clearMissedCalls(getContext(), peerId);
        call.resolve();
    }

    /** Saves a file into Download/Hidden Messenger/<Images|Video|Audio|Documents>; progress arrives as "mediaSaveProgress". */
    @PluginMethod
    public void saveMedia(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionDone");
            return;
        }
        startSave(call);
    }

    @PermissionCallback
    private void storagePermissionDone(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) startSave(call);
        else call.reject("Allow storage access to save files.");
    }

    private void startSave(PluginCall call) {
        String url = call.getString("url");
        String id = call.getString("id", "");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("Nothing to save.");
            return;
        }
        MediaSaver.save(getContext(), url, call.getString("filename", "file"), call.getString("mimeType", ""),
            (received, total) -> {
                JSObject progress = new JSObject();
                progress.put("id", id);
                progress.put("received", received);
                progress.put("total", total);
                notifyListeners("mediaSaveProgress", progress);
            },
            (result) -> {
                JSObject saved = new JSObject();
                saved.put("saved", true);
                saved.put("path", result.path);
                call.resolve(saved);
            },
            call::reject);
    }

    /**
     * Tapping a document: Android's "Open with" (Drive, a PDF reader, WPS…), like WhatsApp. Resolves { opened }, or
     * rejects with the reason (no app on the phone opens this type, or the download failed).
     */
    @PluginMethod
    public void openMedia(PluginCall call) {
        String url = call.getString("url");
        String data = call.getString("data");
        if (data == null && (url == null || !(url.startsWith("https://") || url.startsWith("http://")))) {
            call.reject("Nothing to open.");
            return;
        }
        String filename = call.getString("filename", "file");
        String mimeType = call.getString("mimeType", "");
        java.util.function.Consumer<java.io.File> open = (file) -> {
            android.app.Activity activity = getActivity();
            if (activity == null) {
                call.reject("Could not open the file.");
                return;
            }
            activity.runOnUiThread(() -> {
                try {
                    android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
                    String type = mimeType == null || mimeType.isEmpty() ? activity.getContentResolver().getType(uri) : mimeType;
                    Intent view = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, type == null || type.isEmpty() ? "*/*" : type)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    if (view.resolveActivity(activity.getPackageManager()) == null) {
                        call.reject("No app on this phone can open " + filename + ".");
                        return;
                    }
                    activity.startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                    JSObject result = new JSObject();
                    result.put("opened", true);
                    call.resolve(result);
                } catch (RuntimeException error) {
                    call.reject("Could not open the file.");
                }
            });
        };
        // End-to-end encrypted files arrive as bytes the app decrypted (data, base64); others are downloaded.
        if (data != null) {
            byte[] bytes;
            try {
                bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT);
            } catch (IllegalArgumentException error) {
                call.reject("Nothing to open.");
                return;
            }
            MediaSaver.writeForOpening(getContext(), bytes, filename, open, call::reject);
        } else {
            MediaSaver.downloadForOpening(getContext(), url, filename, open, call::reject);
        }
    }

    /** Nothing left to close on Back: leave the app running in the background, like WhatsApp. */
    @PluginMethod
    public void moveToBackground(PluginCall call) {
        if (getActivity() instanceof AppActivity) {
            AppActivity activity = (AppActivity) getActivity();
            activity.runOnUiThread(activity::leaveApp);
        } else if (getActivity() != null) {
            getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        }
        call.resolve();
    }

    /** Back gesture/button: the web app closes its top screen; false when it is not listening yet. */
    static boolean emitBack() {
        HiddenNativePlugin plugin = instance;
        if (plugin == null || !plugin.hasListeners("backButton")) return false;
        plugin.notifyListeners("backButton", new JSObject());
        return true;
    }

    static void emitPictureInPicture(boolean active) {
        HiddenNativePlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("active", active);
        plugin.notifyListeners("pictureInPicture", data, true);
    }

    /** Signing out: forget the account and stop the background connection. */
    @PluginMethod
    public void clearSession(PluginCall call) {
        // The server forgets this phone's push token (needs the session, so before it is cleared).
        PushRegistration.unregister(getContext());
        RelaySession.clear(getContext());
        // Signed out: this account's chats must not stay in the share sheet or on the app icon.
        ShareShortcuts.clear(getContext());
        NativeRelay.stop();
        call.resolve();
    }

    /** A call rung by the service's connection while the app was closed, for the web app to answer. */
    @PluginMethod
    public void takePendingCall(PluginCall call) {
        JSONObject pending = NativeRelay.takePendingCall();
        JSObject result = new JSObject();
        if (pending != null) {
            try {
                result.put("pending", JSObject.fromJSONObject(pending));
            } catch (JSONException ignored) {
                // Nothing usable to hand over.
            }
        }
        call.resolve(result);
    }

    private static List<String> stringList(JSArray array) {
        List<String> values = new ArrayList<>();
        if (array == null) return values;
        for (int index = 0; index < array.length(); index += 1) {
            String value = array.optString(index, null);
            if (value != null && !value.isEmpty()) values.add(value);
        }
        return values;
    }

    /**
     * A message notification: `group` picks group or direct messages, `sound` (a SoundChoice) the channel and so
     * the sound it plays.
     */
    @PluginMethod
    public void notify(PluginCall call) {
        String channel = NotificationChannels.messageChannel(getContext(), Boolean.TRUE.equals(call.getBoolean("group", false)),
            SoundChoice.parse(call.getString("sound", "")));
        String open = call.getString("open", "");
        String avatar = call.getString("avatar");
        if ((avatar == null || avatar.isEmpty()) && open.startsWith("chat:")) avatar = Avatars.pathFor(open.substring(5));
        boolean shown = Alerts.showMessage(getContext(), channel, call.getString("title", "Hidden Messenger"), call.getString("body", ""),
            call.getString("tag", channel), open, call.getInt("count", 0), call.getString("messageId"), call.getString("sender"), avatar);
        JSObject result = new JSObject();
        result.put("shown", shown);
        call.resolve(result);
    }

    /** Heads-up / full-screen incoming call with Accept and Reject; the ringtone repeats until it is handled. */
    @PluginMethod
    public void showIncomingCall(PluginCall call) {
        boolean shown = Alerts.showIncomingCall(getContext(), call.getString("callId", ""), call.getString("callerId", ""), call.getString("callerName", "Hidden Messenger"),
            "video".equals(call.getString("mode")), call.getString("ringtoneSound", ""), call.getString("callerAvatar"));
        if (shown) setCallWindow(true);
        JSObject result = new JSObject();
        result.put("shown", shown);
        call.resolve(result);
    }

    @PluginMethod
    public void cancelIncomingCall(PluginCall call) {
        // Still ringing when the caller hung up: Alerts turns it into a missed-call notification.
        if (Boolean.TRUE.equals(call.getBoolean("missed", false))) Alerts.missedCall(getContext());
        else cancelCallNotification(getContext());
        call.resolve();
    }

    /** Reads the next part of a file shared from another app (see SharedContent). */
    @PluginMethod
    public void readSharedChunk(PluginCall call) {
        Integer index = call.getInt("index");
        Double offset = call.getDouble("offset", 0.0);
        if (index == null) {
            call.reject("Give the shared file's index.");
            return;
        }
        try {
            call.resolve(SharedContent.readChunk(getContext(), index, offset == null ? 0 : offset.longValue()));
        } catch (java.io.IOException | RuntimeException failure) {
            call.reject(failure.getMessage() != null ? failure.getMessage() : "The shared file could not be read.");
        }
    }

    /** Recent chats for the share sheet's top row: [{ kind, id, name, initials, color, avatar }]. */
    @PluginMethod
    public void setShareTargets(PluginCall call) {
        JSArray targets = call.getArray("targets", new JSArray());
        JSObject result = new JSObject();
        result.put("published", ShareShortcuts.publish(getContext(), targets));
        call.resolve(result);
    }

    /** The share was sent or dismissed: release the shared files. */
    @PluginMethod
    public void clearShare(PluginCall call) {
        SharedContent.clear();
        call.resolve();
    }

    /**
     * Opens a link in the app that handles it (YouTube, Facebook, the browser…). It opens on top of Hidden Messenger,
     * so Back returns here.
     */
    /** Link preview on the sender's phone: the page's HTML (src/linkPreviewSender.js parses it). */
    @PluginMethod
    public void fetchPage(PluginCall call) {
        LinkFetcher.fetchPage(call.getString("url"), (text, finalUrl, type) -> {
            JSObject result = new JSObject();
            result.put("html", text);
            result.put("url", finalUrl);
            result.put("contentType", type);
            call.resolve(result);
        }, call::reject);
    }

    /** The preview's image, fetched by the phone (base64), to become a small thumbnail inside the message. */
    @PluginMethod
    public void fetchImage(PluginCall call) {
        LinkFetcher.fetchImage(call.getString("url"), (data, finalUrl, type) -> {
            JSObject result = new JSObject();
            result.put("data", data);
            result.put("contentType", type);
            call.resolve(result);
        }, call::reject);
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            call.reject("Only web links can be opened.");
            return;
        }
        if (getActivity() == null) {
            call.reject("The app is not on screen.");
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(view);
                call.resolve();
            } catch (android.content.ActivityNotFoundException none) {
                call.reject("No app on this phone can open this link.");
            }
        });
    }

    /** The app shows an incoming call ringing (true) or it stopped ringing (false). */
    @PluginMethod
    public void setCallRinging(PluginCall call) {
        Alerts.setAppRinging(Boolean.TRUE.equals(call.getBoolean("ringing", false)));
        call.resolve();
    }

    /** Called by the web app once a call is no longer ringing or has ended. */
    @PluginMethod
    public void endCallWindow(PluginCall call) {
        setCallWindow(false);
        call.resolve();
    }
}
