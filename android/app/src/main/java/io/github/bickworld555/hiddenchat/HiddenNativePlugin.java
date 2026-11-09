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
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
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
        if (!MainActivity.wantsCallWindow()) setCallWindow(false);
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
        if (SharedContent.isShare(intent)) {
            // Shared from another app's share sheet: the web app shows a chat picker. Retained until it listens.
            notifyListeners("shareReceived", SharedContent.read(getContext(), intent), true);
            intent.setAction(null);
        }
        if (ACTION_ACCEPT.equals(intent.getAction())) {
            cancelCallNotification(getContext());
            emitCallAction("accept", intent.getStringExtra(EXTRA_CALL_ID));
            intent.setAction(null);
        }
    }

    /** Returns false when no WebView is listening (the app's screen is gone). */
    static boolean emitCallAction(String action, String callId) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("callId", callId);
        HiddenNativePlugin plugin = instance;
        if (plugin == null) return false;
        plugin.notifyListeners("callAction", data, true);
        return true;
    }

    static void cancelCallNotification(Context context) {
        Alerts.cancelIncomingCall(context);
    }

    private void setCallWindow(boolean visibleOverLock) {
        if (!(getActivity() instanceof MainActivity)) return;
        MainActivity activity = (MainActivity) getActivity();
        // Never drop the lock-screen window while a call still rings or is in progress.
        activity.runOnUiThread(() -> activity.applyCallWindow(visibleOverLock || MainActivity.wantsCallWindow()));
    }

    private String[] startupAliases() {
        List<String> aliases = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) aliases.add("notifications");
        aliases.add("microphone");
        aliases.add("camera");
        return aliases.toArray(new String[0]);
    }

    private JSObject state() {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED);
        result.put("camera", getPermissionState("camera") == PermissionState.GRANTED);
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        result.put("batteryUnrestricted", power != null && power.isIgnoringBatteryOptimizations(context.getPackageName()));
        result.put("sdk", Build.VERSION.SDK_INT);
        // Android 14+ lets only allowed apps show ringing calls full screen on the lock screen (off by default for
        // apps not installed from the Play Store).
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        result.put("fullScreenCalls", Build.VERSION.SDK_INT < 34 || (notifications != null && notifications.canUseFullScreenIntent()));
        result.put("pictureInPicture", pictureInPictureAllowed(context));
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

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void requestStartupPermissions(PluginCall call) {
        requestPermissionForAliases(startupAliases(), call, "startupPermissionsDone");
    }

    @PermissionCallback
    private void startupPermissionsDone(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (power != null && !power.isIgnoringBatteryOptimizations(context.getPackageName())) {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + context.getPackageName()));
            getActivity().startActivity(intent);
        }
        call.resolve(state());
    }

    @PluginMethod
    public void startBackground(PluginCall call) {
        MessagingService.start(getContext());
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
            Boolean.TRUE.equals(call.getBoolean("phoneMessageSound", false)), Boolean.TRUE.equals(call.getBoolean("phoneGroupSound", false)),
            Boolean.TRUE.equals(call.getBoolean("phoneRingtone", false)));
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
        // Voice calls start on the earpiece (or a headset), video calls on the loudspeaker.
        if (active) CallAudio.start(getContext(), video);
        else CallAudio.stop(getContext());
        JSObject result = new JSObject();
        result.put("speaker", CallAudio.isSpeaker());
        call.resolve(result);
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

    /** The in-call speaker button: loudspeaker on/off (off = earpiece or headset). */
    @PluginMethod
    public void setSpeaker(PluginCall call) {
        CallAudio.setSpeaker(getContext(), Boolean.TRUE.equals(call.getBoolean("on", false)));
        JSObject result = new JSObject();
        result.put("speaker", CallAudio.isSpeaker());
        call.resolve(result);
    }

    /** This phone's own default sound (the in-app "Default" choice): ringtone for calls, notification sound otherwise. */
    @PluginMethod
    public void playSystemSound(PluginCall call) {
        boolean played = SystemSounds.play(getContext(), call.getString("key", "default"), Boolean.TRUE.equals(call.getBoolean("ringtone", false)),
            Boolean.TRUE.equals(call.getBoolean("loop", false)));
        JSObject result = new JSObject();
        result.put("played", played);
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

    /** Nothing left to close on Back: leave the app running in the background, like WhatsApp. */
    @PluginMethod
    public void moveToBackground(PluginCall call) {
        if (getActivity() != null) getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
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
        RelaySession.clear(getContext());
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

    /** A message notification on the direct_messages or group_messages channel, with that channel's sound. */
    @PluginMethod
    public void notify(PluginCall call) {
        String channel = call.getString("channel");
        boolean shown = Alerts.showMessage(getContext(), channel, call.getString("title", "Hidden Messenger"), call.getString("body", ""),
            call.getString("tag", channel), call.getString("open", ""), call.getInt("count", 0));
        JSObject result = new JSObject();
        result.put("shown", shown);
        call.resolve(result);
    }

    /** Heads-up / full-screen incoming call with Accept and Reject; the ringtone repeats until it is handled. */
    @PluginMethod
    public void showIncomingCall(PluginCall call) {
        boolean shown = Alerts.showIncomingCall(getContext(), call.getString("callId", ""), call.getString("callerName", "Hidden Messenger"),
            "video".equals(call.getString("mode")), Boolean.TRUE.equals(call.getBoolean("phoneRingtone", false)));
        if (shown) setCallWindow(true);
        JSObject result = new JSObject();
        result.put("shown", shown);
        call.resolve(result);
    }

    @PluginMethod
    public void cancelIncomingCall(PluginCall call) {
        cancelCallNotification(getContext());
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

    /** Called by the web app once a call is no longer ringing or has ended. */
    @PluginMethod
    public void endCallWindow(PluginCall call) {
        setCallWindow(false);
        call.resolve();
    }
}
