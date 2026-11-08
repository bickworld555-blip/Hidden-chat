package io.github.bickworld555.hiddenchat;

import android.Manifest;
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
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
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
        // Only a ringing call may show over the lock screen; leaving the app ends that.
        setCallWindow(false);
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
        if (ACTION_ACCEPT.equals(intent.getAction())) {
            cancelCallNotification(getContext());
            emitCallAction("accept", intent.getStringExtra(EXTRA_CALL_ID));
            intent.setAction(null);
        }
    }

    static void emitCallAction(String action, String callId) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("callId", callId);
        if (instance != null) instance.notifyListeners("callAction", data, true);
    }

    static void cancelCallNotification(Context context) {
        Alerts.cancelIncomingCall(context);
    }

    private void setCallWindow(boolean visibleOverLock) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                getActivity().setShowWhenLocked(visibleOverLock);
                getActivity().setTurnScreenOn(visibleOverLock);
            } else if (!visibleOverLock) {
                getActivity().getWindow().clearFlags(
                    android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                );
            }
        });
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
        return result;
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
        boolean saved = RelaySession.save(getContext(), call.getString("origin"), call.getString("token"), call.getString("userId"), mutedChats, mutedGroups);
        JSObject result = new JSObject();
        result.put("saved", saved);
        call.resolve(result);
    }

    /** A call started or ended: while active the service keeps the microphone (and camera) working in the background. */
    @PluginMethod
    public void setCallActive(PluginCall call) {
        MessagingService.setCall(getContext(), Boolean.TRUE.equals(call.getBoolean("active", false)), Boolean.TRUE.equals(call.getBoolean("video", false)));
        call.resolve();
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
            call.getString("tag", channel), call.getString("open", ""));
        JSObject result = new JSObject();
        result.put("shown", shown);
        call.resolve(result);
    }

    /** Heads-up / full-screen incoming call with Accept and Reject; the ringtone repeats until it is handled. */
    @PluginMethod
    public void showIncomingCall(PluginCall call) {
        boolean shown = Alerts.showIncomingCall(getContext(), call.getString("callId", ""), call.getString("callerName", "Hidden Messenger"),
            "video".equals(call.getString("mode")));
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

    /** Called by the web app once a call is no longer ringing or has ended. */
    @PluginMethod
    public void endCallWindow(PluginCall call) {
        setCallWindow(false);
        call.resolve();
    }
}
