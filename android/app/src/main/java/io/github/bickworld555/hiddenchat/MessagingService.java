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
 * Hidden Messenger's foreground service. With Firebase push (the normal mode, like WhatsApp) it runs only when there
 * is work: during a call (microphone / camera / phone call), and for a short "sync" after a call push while the
 * phone connects to collect the caller's offer. Between those the app is idle: no service, no open socket.
 *
 * Until push is confirmed for this phone (no google-services.json in the build, no Google Play services, or a
 * server without push) it falls back to the always-on mode: a quiet "Connected" notification and the service's
 * own connection (NativeRelay) once the app's screen is gone, so messages and calls are never missed.
 */
public class MessagingService extends Service {
    private static final int NOTIFICATION_ID = 1001;
    // The ongoing-call notification (the timer on the lock screen / Samsung Now Bar) has its own id: when the call
    // ends it is cancelled outright. Turning it back into the "Connected" notification under the same id left some
    // phones showing the old call and its running timer.
    private static final int CALL_NOTIFICATION_ID = 1002;
    // Heartbeat from the web app while a call is live; without one for this long the call is over.
    private static final long HEARTBEAT_TIMEOUT_MS = 90_000;
    private static volatile long lastHeartbeat;
    private static volatile boolean running;
    private static MessagingService instance;
    // During a call the service also holds the microphone (and camera for video) types, so Android keeps them
    // working when the user switches apps or turns the screen off; otherwise a backgrounded call goes silent.
    private static volatile boolean callActive;
    private static volatile boolean callVideo;
    private static volatile String callName;
    private static volatile long callStartedAt;

    private static final String ACTION_SYNC = "io.github.bickworld555.hiddenchat.SYNC";
    // While a push asks for it (elapsed-realtime deadline): connected long enough to collect a call's offer.
    private static volatile long syncUntil;
    private static final Handler timers = new Handler(Looper.getMainLooper());

    static void start(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, MessagingService.class));
    }

    /** Push mode is off for the signed-in account: the always-on connection keeps the phone reachable. */
    static boolean isLegacy(Context context) {
        return RelaySession.read(context) != null && !PushRegistration.isActive(context);
    }

    private static boolean syncing() {
        long now = android.os.SystemClock.elapsedRealtime();
        // A call that is still ringing keeps the connection a little longer, so Accept / Decline still work.
        return now < syncUntil || (Alerts.isRinging() && now < syncUntil + 60_000);
    }

    /** Whether the service has anything to do now. */
    private static boolean needed(Context context) {
        return callActive || syncing() || isLegacy(context);
    }

    /**
     * A push asked the phone to connect for a while (an incoming call): a short dataSync foreground service, the way
     * WhatsApp's GcmFGService does it. High-priority pushes may start one from the background.
     */
    static void startSync(Context context, long durationMs) {
        Context app = context.getApplicationContext();
        syncUntil = Math.max(syncUntil, android.os.SystemClock.elapsedRealtime() + durationMs);
        try {
            ContextCompat.startForegroundService(app, new Intent(app, MessagingService.class).setAction(ACTION_SYNC));
        } catch (RuntimeException notAllowed) {
            // Android refused a foreground service: connect anyway while the push keeps the process awake.
            NativeRelay.start(app);
        }
        timers.removeCallbacks(syncCheck);
        timers.postDelayed(syncCheck, durationMs + 500);
    }

    private static final Runnable syncCheck = new Runnable() {
        @Override
        public void run() {
            MessagingService service = instance;
            if (service != null) service.settle();
            else if (!syncing() && !AppActivity.isAlive()) NativeRelay.stopUnlessLegacy();
            if (syncing()) timers.postDelayed(this, 5_000);
        }
    };

    /** Sign-in, push registration or sign-out changed what the phone needs: start or stop the always-on mode. */
    static void applyMode(Context context) {
        Context app = context.getApplicationContext();
        MessagingService service = instance;
        if (isLegacy(app)) {
            if (service == null) start(app);
            else service.promote();
        } else if (service != null) {
            service.settle();
        }
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
        if (!active && callActive) AppActivity.callEnded();
        // Only a change reaches Android: a stray "not in a call" must not drop a call that is still ringing.
        if (active || callActive) TelecomCalls.live(context, active, video, name);
        callActive = active;
        callVideo = active && video;
        callName = active && name != null && !name.trim().isEmpty() ? name.trim() : null;
        AppActivity.videoCallChanged(callVideo);
        AppActivity.callWindowChanged();
        MessagingService service = instance;
        if (service != null) new Handler(Looper.getMainLooper()).post(service::settle);
        else if (active) start(context);
        else androidx.core.app.NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
        if (!active) androidx.core.app.NotificationManagerCompat.from(context).cancel(CALL_NOTIFICATION_ID);
        if (active) lastHeartbeat = 0;
        watch(context.getApplicationContext(), active);
    }

    private static final Handler watchdog = new Handler(Looper.getMainLooper());
    private static final long WATCH_INTERVAL_MS = 5000;

    /**
     * While a call is marked live, check every few seconds that the app screen holding it still exists. If it is
     * gone without having said so, the call cannot be going on: end it, so no call timer keeps counting on the
     * lock screen.
     */
    private static void watch(Context context, boolean active) {
        watchdog.removeCallbacksAndMessages(null);
        if (!active) return;
        watchdog.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!callActive) return;
                if (!AppActivity.isAlive()) {
                    endOrphanedCall(context, "no screen holds the call");
                    return;
                }
                long beat = lastHeartbeat;
                if (beat != 0 && android.os.SystemClock.elapsedRealtime() - beat > HEARTBEAT_TIMEOUT_MS) {
                    endOrphanedCall(context, "the app stopped confirming the call");
                    return;
                }
                watchdog.postDelayed(this, WATCH_INTERVAL_MS);
            }
        }, WATCH_INTERVAL_MS);
    }

    /** Re-posts the notification with the current service types (e.g. once Android has the call as a phone call). */
    static void refresh() {
        MessagingService service = instance;
        if (service != null) new Handler(Looper.getMainLooper()).post(service::promote);
    }

    /**
     * The web screen that held the call is gone (closed, swiped away, reloaded) or did not confirm a hang-up: the
     * call cannot go on, so its ongoing notification (the timer on the lock screen), Android's call and the audio
     * route end now instead of counting on forever.
     */
    /** The web app confirms every few seconds that its call is still live. */
    static void heartbeat() {
        if (callActive) lastHeartbeat = android.os.SystemClock.elapsedRealtime();
    }

    /**
     * The call ended (any way): everything about it goes, unconditionally and at once — the call state, Android's
     * call (Telecom), the audio route, the ongoing-call notification and the ringing screen of that call.
     */
    static void hardReset(Context context, String why) {
        android.util.Log.i("MessagingService", "call hard reset: " + why);
        if (callActive) setCall(context, false, false, null);
        TelecomCalls.endAll();
        CallAudio.stop(context);
        androidx.core.app.NotificationManagerCompat.from(context).cancel(CALL_NOTIFICATION_ID);
        lastHeartbeat = 0;
    }

    static void endOrphanedCall(Context context, String why) {
        if (!callActive) return;
        android.util.Log.i("MessagingService", "call state cleared: " + why);
        setCall(context, false, false, null);
        CallAudio.stop(context);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** The type for the service's own work: the always-on connection (specialUse) or a push sync (dataSync). */
    private int baseType() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0;
        if (isLegacy(this)) return Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        return ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    }

    private int serviceTypes() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0;
        // During a call in push mode the call types say it all; otherwise the service's own work type.
        int types = callActive && !isLegacy(this) ? 0 : baseType();
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
        Intent open = new Intent(this, AppActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = callActive ? callNotification(content) : new NotificationCompat.Builder(this, NotificationChannels.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle("Hidden Messenger")
            .setContentText(isLegacy(this) ? "Connected · receiving messages and calls" : "Connecting to the call…")
            .setContentIntent(content)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
        int id = callActive ? CALL_NOTIFICATION_ID : NOTIFICATION_ID;
        int types = serviceTypes();
        int fallback = baseType();
        if (types == 0) types = fallback;
        // Most to least: with the phone-call type, without it, then the connection type alone (Android only grants
        // the microphone and camera while the app is in front, unless Android has the call as a phone call).
        int withoutPhoneCall = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? types & ~ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL : types;
        for (int attempt : new int[] { types, withoutPhoneCall, fallback }) {
            try {
                ServiceCompat.startForeground(this, id, notification, attempt);
                // Back to "Connected": the call notification is deleted, not left behind or reused.
                if (!callActive) androidx.core.app.NotificationManagerCompat.from(this).cancel(CALL_NOTIFICATION_ID);
                else androidx.core.app.NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID);
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

    /** Keeps running (and re-posts the notification) while there is work; otherwise stops and disconnects. */
    void settle() {
        if (needed(this)) {
            promote();
            return;
        }
        if (!isLegacy(this) && !AppActivity.isAlive()) NativeRelay.stop();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationChannels.ensure(this);
        instance = this;
        // Android requires the notification first for a service started with startForegroundService.
        promote();
        running = true;
        if (RelaySession.read(this) == null && !callActive) {
            // Nobody is signed in on this phone: nothing to keep reachable.
            settle();
            return START_NOT_STICKY;
        }
        boolean sync = intent != null && ACTION_SYNC.equals(intent.getAction());
        boolean legacy = isLegacy(this);
        // A push sync, or the always-on mode restarted by Android after the process was killed: connect ourselves.
        if (!AppActivity.isAlive() && (sync || legacy)) NativeRelay.start(this);
        if (!needed(this)) {
            settle();
            return START_NOT_STICKY;
        }
        // Push mode is not restarted by Android after a kill: the next push wakes the app instead.
        return legacy ? START_STICKY : START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiped away: in the always-on mode this service's own connection keeps messages and calls coming;
        // with push the phone just sleeps until the next push.
        if (isLegacy(this)) NativeRelay.start(this);
        else settle();
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
