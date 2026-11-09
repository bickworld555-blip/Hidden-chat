package io.github.bickworld555.hiddenchat;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service that keeps Hidden Messenger reachable in the background. While the app's screen exists its
 * WebView holds the live connection and this service only keeps the process alive; once the screen is gone
 * (swiped away from recents, or the process restarted by Android) the service's own connection (NativeRelay)
 * takes over, so messages still reach two ticks with a notification and calls still ring.
 */
public class MessagingService extends Service {
    private static final int NOTIFICATION_ID = 1001;
    private static volatile boolean running;
    private static MessagingService instance;
    // During a call the service also holds the microphone (and camera for video) types, so Android keeps them
    // working when the user switches apps or turns the screen off; otherwise a backgrounded call goes silent.
    private static volatile boolean callActive;
    private static volatile boolean callVideo;
    private static volatile String callName;
    private static volatile long callStartedAt;

    static void start(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, MessagingService.class));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, MessagingService.class));
    }

    static boolean isRunning() {
        return running;
    }

    static boolean isVideoCallActive() {
        return callActive && callVideo;
    }

    static boolean isCallActive() {
        return callActive;
    }

    /** Called by the web app when a call starts and ends (HiddenNative.setCallActive). */
    static void setCall(Context context, boolean active, boolean video, String name) {
        if (active && !callActive) callStartedAt = System.currentTimeMillis();
        if (!active && callActive) MainActivity.callEnded();
        TelecomCalls.live(context, active, video, name);
        callActive = active;
        callVideo = active && video;
        callName = active && name != null && !name.trim().isEmpty() ? name.trim() : null;
        MainActivity.videoCallChanged(callVideo);
        MainActivity.callWindowChanged();
        MessagingService service = instance;
        if (service != null) new Handler(Looper.getMainLooper()).post(service::promote);
        else if (active) start(context);
    }

    /** Re-posts the notification with the current service types (e.g. once Android has the call as a phone call). */
    static void refresh() {
        MessagingService service = instance;
        if (service != null) new Handler(Looper.getMainLooper()).post(service::promote);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private int serviceTypes() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0;
        int types = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        if (callActive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (granted(Manifest.permission.RECORD_AUDIO)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (callVideo && granted(Manifest.permission.CAMERA)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            // A call Android knows about (Telecom) may hold the service as a phone call even from the background.
            if (TelecomCalls.hasCall()) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL;
        }
        return types;
    }

    /** (Re)posts the ongoing notification with the service types the current state needs. */
    private void promote() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = callActive ? callNotification(content) : new NotificationCompat.Builder(this, NotificationChannels.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle("Hidden Messenger")
            .setContentText("Connected · receiving messages and calls")
            .setContentIntent(content)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
        int types = serviceTypes();
        int fallback = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        // Most to least: with the phone-call type, without it, then the connection type alone (Android only grants
        // the microphone and camera while the app is in front, unless Android has the call as a phone call).
        int withoutPhoneCall = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? types & ~ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL : types;
        for (int attempt : new int[] { types, withoutPhoneCall, fallback }) {
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, attempt);
                return;
            } catch (RuntimeException notAllowedNow) {
                if (attempt == fallback) throw notAllowedNow;
            }
        }
    }

    /**
     * During a call: "<name> · Ongoing voice/video call" with a running timer and a Hang up button, like WhatsApp.
     * It uses its own visible (silent) channel, since the connection channel is minimised in the shade.
     */
    private Notification callNotification(PendingIntent content) {
        Intent hangUp = new Intent(this, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_HANGUP);
        PendingIntent hangUpIntent = PendingIntent.getBroadcast(this, 3, hangUp, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String name = callName != null ? callName : "Hidden Messenger";
        String text = callVideo ? "Ongoing video call" : "Ongoing voice call";
        Person caller = new Person.Builder().setName(name).setImportant(true).build();
        return new NotificationCompat.Builder(this, NotificationChannels.ONGOING_CALL)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(name)
            .setContentText(text)
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setWhen(callStartedAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUpIntent))
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationChannels.ensure(this);
        instance = this;
        promote();
        running = true;
        if (RelaySession.read(this) == null && !callActive) {
            // Nobody is signed in on this phone: nothing to keep reachable.
            stopSelf();
            return START_NOT_STICKY;
        }
        // Restarted by Android after the process was killed (no screen yet): reconnect on our own.
        if (!MainActivity.isAlive()) NativeRelay.start(this);
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiped away: the WebView is gone, so this service's own connection keeps messages and calls coming.
        if (RelaySession.read(this) != null) NativeRelay.start(this);
        else stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (instance == this) instance = null;
        NativeRelay.stop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
