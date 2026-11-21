package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.os.PowerManager;

/**
 * P3: while a push-started fetch runs, the phone's CPU stays awake (a partial wake lock, at most FETCH_WAKE_MS), and
 * is let go the moment the fetch says it is done, like WhatsApp's push handler holding Firebase's wake time until
 * the message is processed. Unlike blocking the push handler, it never delays the next push (Firebase handles them
 * one at a time: a call arriving meanwhile must ring at once).
 *
 * Also remembers when the last fetch completed, so the hourly check (HeartbeatJob, P4) only fetches when nothing
 * else has for a while.
 */
final class FetchWake {
    static final long FETCH_WAKE_MS = 15_000;
    private static final String PREFS = "hm_fetch";
    private static PowerManager.WakeLock lock;

    private FetchWake() { }

    /** Keeps the CPU awake for at most `ms` (renewed by a later call). */
    static synchronized void hold(Context context, long ms) {
        try {
            if (lock == null) {
                PowerManager power = context.getApplicationContext().getSystemService(PowerManager.class);
                if (power == null) return;
                lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hiddenchat:fetch");
                lock.setReferenceCounted(false);
            }
            lock.acquire(ms);
        } catch (RuntimeException ignored) {
            // No wake lock: the foreground service still keeps the process alive.
        }
    }

    // When the last push-started fetch began and when one last ended (elapsedRealtime), whatever its outcome.
    private static volatile long startedAt;
    private static volatile long endedAt;

    /** A push started (or kept going) a fetch: until it ends, the sealed notice waits (PushService). */
    static void started() {
        startedAt = android.os.SystemClock.elapsedRealtime();
    }

    /** A fetch is running: started and not ended since. */
    static boolean inProgress() {
        long started = startedAt;
        return started > 0 && started > endedAt;
    }

    // After a completed fetch, how long its own notifications get before unfilled "New message" lines go.
    private static final long SETTLE_ARRIVING_MS = 1_500;

    /**
     * The fetch has ended (the app's own, or the background page): the CPU may sleep, the short foreground service
     * ("Checking for new messages") goes at once rather than at its time limit, and `fetched` (everything waiting was
     * opened and notified) also counts for the sealed notice and the hourly check.
     */
    static void finished(Context context, boolean fetched) {
        if (fetched) {
            markFetched(context);
            // Its notifications are posted by now; "New message" lines it did not replace go (Alerts.settleArriving).
            Context app = context.getApplicationContext();
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> Alerts.settleArriving(app), SETTLE_ARRIVING_MS);
        }
        endedAt = android.os.SystemClock.elapsedRealtime();
        release();
        WakeKeeper.release();
    }

    /** The CPU may sleep again. */
    static synchronized void release() {
        try {
            if (lock != null && lock.isHeld()) lock.release();
        } catch (RuntimeException ignored) { }
    }

    // When the last fetch completed (elapsedRealtime), for PushService's sealed fallback.
    private static volatile long completedAt;

    /** Whether a fetch completed at or after `since` (elapsedRealtime): everything waiting was opened and notified. */
    static boolean completedSince(long since) {
        long at = completedAt;
        return at > 0 && at >= since;
    }

    static void markFetched(Context context) {
        completedAt = android.os.SystemClock.elapsedRealtime();
        context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("lastFetch", System.currentTimeMillis()).apply();
    }

    /** Whether a fetch completed within the last `ms` milliseconds. */
    static boolean fetchedWithin(Context context, long ms) {
        long last = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("lastFetch", 0);
        long now = System.currentTimeMillis();
        return last > 0 && last <= now && now - last < ms;
    }
}
