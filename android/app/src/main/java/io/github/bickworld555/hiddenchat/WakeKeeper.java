package io.github.bickworld555.hiddenchat;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app's process awake for a few seconds while its own code fetches what a push announced (the app is in the
 * background but alive: src/xmpp/session.js backgroundFetch). A short service (Android 14+): meant for a few seconds
 * of work and not counted against Android 15's daily "dataSync" cap, which refused MessagingService.startSync once the
 * app's other services had used it up (seen on the S23: the fetch froze and the sealed notice stood in).
 */
public class WakeKeeper extends Service {
    private static final String TAG = "WakeKeeper";
    private static final int NOTIFICATION_ID = 1004;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static volatile long until;
    private static volatile WakeKeeper instance;

    /** Keeps the process awake for `durationMs` (extended by a later call). False when Android refuses. */
    static boolean keep(Context context, long durationMs) {
        until = Math.max(until, SystemClock.elapsedRealtime() + durationMs);
        Context app = context.getApplicationContext();
        try {
            ContextCompat.startForegroundService(app, new Intent(app, WakeKeeper.class));
            return true;
        } catch (RuntimeException refused) {
            Log.w(TAG, "foreground service refused", refused);
            return false;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        NotificationChannels.ensure(this);
        Notification notice = new NotificationCompat.Builder(this, NotificationChannels.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle("Checking for new messages")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTIFICATION_ID, notice);
        } catch (RuntimeException refused) {
            Log.w(TAG, "could not go to the foreground", refused);
            stop();
            return START_NOT_STICKY;
        }
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::stop, Math.max(0, until - SystemClock.elapsedRealtime()));
        return START_NOT_STICKY;
    }

    // The short service's time is up (about 3 minutes): stop at once.
    @Override
    public void onTimeout(int startId) {
        stop();
    }

    private void stop() {
        main.removeCallbacksAndMessages(null);
        if (instance == this) instance = null;
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (RuntimeException ignored) { }
        stopSelf();
    }
}
