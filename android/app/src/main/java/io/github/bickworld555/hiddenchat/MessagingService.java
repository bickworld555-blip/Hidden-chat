package io.github.bickworld555.hiddenchat;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
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

    static void start(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, MessagingService.class));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, MessagingService.class));
    }

    static boolean isRunning() {
        return running;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationChannels.ensure(this);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new NotificationCompat.Builder(this, NotificationChannels.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle("Hidden Messenger")
            .setContentText("Connected · receiving messages and calls")
            .setContentIntent(content)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        running = true;
        if (RelaySession.read(this) == null) {
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
        NativeRelay.stop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
