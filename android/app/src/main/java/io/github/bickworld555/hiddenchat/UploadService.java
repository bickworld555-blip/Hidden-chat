package io.github.bickworld555.hiddenchat;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service while files are being sent, like WhatsApp's MediaTranscodeService: "Sending 3 files · 45%".
 * The uploads themselves run in the web app's resumable upload queue (src/upload.js); this service only keeps the
 * app alive and visible, so Android does not freeze or kill it when the user switches away mid-upload.
 * It starts with the first upload and stops when the queue is empty.
 */
public class UploadService extends Service {
    private static final String TAG = "UploadService";
    private static final int NOTIFICATION_ID = 1003;
    private static volatile int count;
    private static volatile int progress;
    private static volatile String label = "";
    private static UploadService instance;

    /** The web app's upload queue changed (count 0 = nothing left to send). */
    static void update(Context context, int newCount, String newLabel, int newProgress) {
        Context app = context.getApplicationContext();
        count = Math.max(0, newCount);
        label = newLabel == null ? "" : newLabel;
        progress = Math.max(0, Math.min(100, newProgress));
        UploadService service = instance;
        if (count == 0) {
            if (service != null) service.finish();
            return;
        }
        if (service != null) {
            service.post();
            return;
        }
        try {
            ContextCompat.startForegroundService(app, new Intent(app, UploadService.class));
        } catch (RuntimeException notAllowed) {
            // Started from the background (Android refuses): the upload continues while the app stays alive.
            Log.w(TAG, "upload notification not started", notAllowed);
        }
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 5, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        int files = count;
        String title = files <= 1 ? "Sending " + (label.isEmpty() ? "a file" : label) : "Sending " + files + " files";
        return new NotificationCompat.Builder(this, NotificationChannels.UPLOADS)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle(title)
            .setContentText(progress + "%")
            .setProgress(100, progress, progress == 0)
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .build();
    }

    private void post() {
        if (count == 0) {
            finish();
            return;
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        try {
            manager.notify(NOTIFICATION_ID, notification());
        } catch (SecurityException noPermission) {
            // Notifications off: the service still keeps the upload alive.
        }
    }

    private void finish() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationChannels.ensure(this);
        instance = this;
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type);
        } catch (RuntimeException notAllowed) {
            Log.w(TAG, "foreground not allowed now", notAllowed);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (count == 0) finish();
        // Not restarted after a kill: the uploads lived in the app's process and resume when it opens again.
        return START_NOT_STICKY;
    }

    /** Android 15+: dataSync services have a daily time budget; when it runs out, step down gracefully. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "foreground time budget reached; uploads continue while the app is open");
        finish();
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
