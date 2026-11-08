package io.github.bickworld555.hiddenchat;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;

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
    static final String EXTRA_OPEN = "hm_open";
    static final String EXTRA_CALL_ID = "hm_call_id";
    static final String EXTRA_CALL = "hm_call";
    static final String ACTION_ACCEPT = "io.github.bickworld555.hiddenchat.CALL_ACCEPT";
    static final String ACTION_SHOW_CALL = "io.github.bickworld555.hiddenchat.CALL_SHOW";
    private static final String CALL_TAG = "incoming_call";
    private static final int CALL_ID = 2001;

    private static HiddenNativePlugin instance;

    @Override
    public void load() {
        instance = this;
        NotificationChannels.ensure(getContext());
        handleIntent(getActivity().getIntent());
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
        NotificationManagerCompat.from(context).cancel(CALL_TAG, CALL_ID);
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

    private PendingIntent openIntent(String open, int requestCode) {
        Intent intent = new Intent(getContext(), MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPEN, open);
        return PendingIntent.getActivity(getContext(), requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** A message notification on the direct_messages or group_messages channel, with that channel's sound. */
    @PluginMethod
    public void notify(PluginCall call) {
        String channel = NotificationChannels.GROUP_MESSAGES.equals(call.getString("channel"))
            ? NotificationChannels.GROUP_MESSAGES
            : NotificationChannels.DIRECT_MESSAGES;
        String tag = call.getString("tag", channel);
        String open = call.getString("open", "");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), channel)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(call.getString("title", "Hidden Messenger"))
            .setContentText(call.getString("body", ""))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(call.getString("body", "")))
            .setContentIntent(openIntent(open, tag.hashCode()))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setSound(NotificationChannels.rawSound(getContext(), NotificationChannels.soundFor(channel)));
            builder.setDefaults(NotificationCompat.DEFAULT_VIBRATE);
        }
        JSObject result = new JSObject();
        try {
            NotificationManagerCompat.from(getContext()).notify(tag, 1, builder.build());
            result.put("shown", true);
        } catch (SecurityException missingPermission) {
            result.put("shown", false);
        }
        call.resolve(result);
    }

    /** Heads-up / full-screen incoming call with Accept and Reject; the ringtone repeats until it is handled. */
    @PluginMethod
    public void showIncomingCall(PluginCall call) {
        Context context = getContext();
        String callId = call.getString("callId", "");
        String caller = call.getString("callerName", "Hidden Messenger");
        boolean video = "video".equals(call.getString("mode"));

        Intent show = new Intent(context, MainActivity.class)
            .setAction(ACTION_SHOW_CALL)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_CALL, true)
            .putExtra(EXTRA_CALL_ID, callId);
        Intent accept = new Intent(context, MainActivity.class)
            .setAction(ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_CALL, true)
            .putExtra(EXTRA_CALL_ID, callId);
        Intent reject = new Intent(context, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_REJECT)
            .putExtra(EXTRA_CALL_ID, callId);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent showIntent = PendingIntent.getActivity(context, 3001, show, flags);
        PendingIntent acceptIntent = PendingIntent.getActivity(context, 3002, accept, flags);
        PendingIntent rejectIntent = PendingIntent.getBroadcast(context, 3003, reject, flags);

        Person person = new Person.Builder().setName(caller).setImportant(true).build();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, NotificationChannels.INCOMING_CALLS)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(caller)
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
            builder.setSound(NotificationChannels.rawSound(context, R.raw.incoming_call_ringtone));
            builder.setVibrate(new long[] { 0, 800, 600, 800, 600 });
        }
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        JSObject result = new JSObject();
        try {
            NotificationManagerCompat.from(context).notify(CALL_TAG, CALL_ID, notification);
            setCallWindow(true);
            result.put("shown", true);
        } catch (SecurityException missingPermission) {
            result.put("shown", false);
        }
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
