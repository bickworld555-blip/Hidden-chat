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
 * P4: an hourly check, like WhatsApp's HEARTBEAT_WAKEUP. If no fetch has completed for a while (a push Firebase
 * delayed or dropped, a phone that was offline long enough for its pushes to expire), it fetches once: through the
 * app's own code when its process is alive, otherwise through the background page (HeadlessRunner). Runs only with a
 * network, at Android's convenience (inexact, batched with other apps' work), and survives restarts.
 */
public class HeartbeatJob extends JobService {
    private static final String TAG = "HeartbeatJob";
    static final int JOB_ID = 51_017;
    static final long PERIOD_MS = 60 * 60 * 1000L;
    private static final long FLEX_MS = 15 * 60 * 1000L;
    // A fetch this recent makes the check unnecessary.
    static final long RECENT_MS = 45 * 60 * 1000L;
    // How long the app's own fetch gets before the job lets Android sleep again.
    private static final long APP_FETCH_MS = 15_000;
    private static final Handler main = new Handler(Looper.getMainLooper());

    /** Schedules the hourly check once (signed in); nothing if it is already scheduled. */
    static void schedule(Context context) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs == null || jobs.getPendingJob(JOB_ID) != null) return;
        JobInfo info = new JobInfo.Builder(JOB_ID, new ComponentName(context, HeartbeatJob.class))
            .setPeriodic(PERIOD_MS, FLEX_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build();
        try {
            jobs.schedule(info);
        } catch (RuntimeException refused) {
            Log.w(TAG, "could not schedule the hourly check", refused);
        }
    }

    /** Signed out: no more checks. */
    static void cancel(Context context) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs != null) jobs.cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (RelaySession.read(this) == null) return false;
        if (FetchWake.fetchedWithin(this, RECENT_MS)) {
            Log.i(TAG, "skipped: fetched recently");
            return false;
        }
        if (HiddenNativePlugin.emitXmppWake()) {
            // The app's code is alive: it connects (or, off screen, does a background fetch) itself. The job keeps the
            // phone awake meanwhile.
            Log.i(TAG, "app fetch");
            main.postDelayed(() -> jobFinished(params, false), APP_FETCH_MS);
            return true;
        }
        if (BackgroundHost.isRunning() || HeadlessRunner.isRunning()) return false;
        boolean started = HeadlessRunner.start(this, (reason) -> {
            Log.i(TAG, "background page: " + reason);
            jobFinished(params, false);
        });
        Log.i(TAG, started ? "background page started" : "not started");
        return started;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // Android needs the time back: stop now; the next period tries again.
        main.removeCallbacksAndMessages(null);
        HeadlessRunner.finish("job-stopped");
        return false;
    }
}
