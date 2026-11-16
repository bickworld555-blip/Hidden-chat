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

    /** The fetch is done (the background page, or the app's own fetch): the CPU may sleep again. */
    static synchronized void release() {
        try {
            if (lock != null && lock.isHeld()) lock.release();
        } catch (RuntimeException ignored) { }
    }

    static void markFetched(Context context) {
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
