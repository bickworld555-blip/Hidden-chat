package io.github.bickworld555.hiddenchat;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Processes messages on push when the app's process had no screen (swiped away, killed, or never opened since boot),
 * like WhatsApp's GcmFGService: a short foreground service that hosts the app's background page (HeadlessRunner) and
 * stops when the page is done. See HeadlessRunner for what the page does and how it never meets the app's own code.
 */
public class BackgroundHost extends Service {
    private static final String TAG = "BackgroundHost";
    private static final int NOTIFICATION_ID = 1003;
    private static volatile boolean running;

    /** Starts the background page for a push; nothing when the app's screen exists or a page already runs. */
    static void start(Context context) {
        if (AppActivity.isAlive() || running || HeadlessRunner.isRunning()) return;
        Context app = context.getApplicationContext();
        try {
            ContextCompat.startForegroundService(app, new Intent(app, BackgroundHost.class));
            running = true;
        } catch (RuntimeException notAllowed) {
            Log.w(TAG, "foreground service refused: the sealed notice stands in", notAllowed);
        }
    }

    static boolean isRunning() {
        return running || HeadlessRunner.isRunning();
    }

    /** The app's screen is being created: a running page finishes the message in hand and stops. */
    static void stopForApp() {
        HeadlessRunner.stopForApp();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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
            stop();
            return START_NOT_STICKY;
        }
        // A page already running (the hourly check hosts it), or the app's screen appeared: nothing to host.
        if (HeadlessRunner.isRunning() || !HeadlessRunner.start(this, (reason) -> stop())) { stop(); return START_NOT_STICKY; }
        hosting = true;
        return START_NOT_STICKY;
    }

    // Whether this service started the page now running (only then may it end it).
    private boolean hosting;

    private void stop() {
        running = false;
        hosting = false;
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (RuntimeException ignored) { }
        stopSelf();
    }

    // A short service's time is up (about 3 minutes; the page is done long before): stop at once.
    @Override
    public void onTimeout(int startId) {
        if (hosting) HeadlessRunner.finish("timeout");
        stop();
    }

    @Override
    public void onDestroy() {
        if (hosting) HeadlessRunner.finish("service-destroyed");
        running = false;
        hosting = false;
        super.onDestroy();
    }
}
