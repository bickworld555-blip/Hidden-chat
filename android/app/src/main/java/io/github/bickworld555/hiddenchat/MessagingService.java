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
 * Foreground service that keeps the app process (and the WebView's live WebSocket) running while the app
 * is in the background, so messages and calls keep arriving. It holds no connection of its own: if the
 * task is removed or the process dies, it stops rather than claiming a connection that no longer exists.
 */
public class MessagingService extends Service {
    private static final int NOTIFICATION_ID = 1001;

    static void start(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, MessagingService.class));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, MessagingService.class));
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
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The WebView lives in the activity task; once the user swipes it away there is nothing to keep alive.
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
