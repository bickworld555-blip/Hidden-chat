package io.github.bickworld555.hiddenchat;

import android.content.Context;

/**
 * P5: Settings › Notifications › Always connected (off unless chosen). The phone keeps its own connection to the
 * server (MessagingService's always-on mode with NativeRelay) besides Firebase: calls ring and message wake-ups
 * arrive over it even when Firebase is late, at the cost of some battery and the "Connected" notification Android
 * requires, as WhatsApp does on phones without Google's push.
 */
final class AlwaysConnected {
    private static final String PREFS = "hm_always_connected";

    private AlwaysConnected() { }

    static boolean enabled(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", false);
    }

    static void set(Context context, boolean on) {
        context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", on).apply();
    }
}
