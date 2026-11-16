package io.github.bickworld555.hiddenchat;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

/**
 * P6: messages left unsent when the app went off screen (no network, the app swiped away) go out as soon as there is a
 * network, with the app closed, like WhatsApp's UnsentMessagesNetworkAvailableJob. The app schedules it when it
 * leaves the screen with something in its outbox (HiddenNativePlugin.scheduleUnsent); the background page sends the
 * outbox once the server has given what waited (src/background/main.js sendOutbox). An app still alive sends it
 * itself on reconnecting. Survives restarts; Android retries with back-off when the page could not finish.
 */
public class UnsentMessagesJob extends JobService {
    private static final String TAG = "UnsentMessagesJob";
    static final int JOB_ID = 51_018;
    private static final long APP_SEND_MS = 15_000;
    private static final Handler main = new Handler(Looper.getMainLooper());

    /** Runs once a network is available (replacing an earlier request). */
    static void schedule(Context context) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs == null) return;
        JobInfo info = new JobInfo.Builder(JOB_ID, new ComponentName(context, UnsentMessagesJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
            .setPersisted(true)
            .build();
        try {
            jobs.schedule(info);
        } catch (RuntimeException refused) {
            Log.w(TAG, "could not schedule sending the outbox", refused);
        }
    }

    /** Signed out, or the outbox is empty again: nothing to send. */
    static void cancel(Context context) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs != null) jobs.cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (RelaySession.read(this) == null) return false;
        if (HiddenNativePlugin.emitXmppWake()) {
            // The app's code is alive: reconnecting sends its outbox (src/App.jsx onReady). Awake meanwhile.
            Log.i(TAG, "app sends");
            main.postDelayed(() -> jobFinished(params, false), APP_SEND_MS);
            return true;
        }
        if (BackgroundHost.isRunning() || HeadlessRunner.isRunning()) {
            // A page already runs and sends the outbox before it ends; this run is not needed.
            return false;
        }
        boolean started = HeadlessRunner.start(this, (reason) -> {
            Log.i(TAG, "background page: " + reason);
            // Not finished (no network after all, time limit): Android tries again later, with back-off.
            jobFinished(params, !"done".equals(reason) && !"signed-out".equals(reason));
        });
        Log.i(TAG, started ? "background page started" : "not started");
        return started;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        main.removeCallbacksAndMessages(null);
        HeadlessRunner.finish("job-stopped");
        // Android needs the time back: try again later.
        return true;
    }
}
