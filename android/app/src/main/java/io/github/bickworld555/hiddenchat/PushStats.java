package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

/**
 * P7: how Android delivered this phone's pushes, like WhatsApp's push handler reading google.delivered_priority and
 * google.priority_reduced. The server sends every push at high priority; Android lowers one (battery saving, an app
 * it judges rarely used, too many high-priority pushes that showed nothing) and such a push may arrive late, so a
 * late notification can be explained in Settings › Notifications. Counts per week, nothing about content.
 */
final class PushStats {
    private static final String TAG = "PushStats";
    private static final String PREFS = "hm_push_stats";
    private static final long WINDOW_MS = 7L * 24 * 60 * 60 * 1000;

    private PushStats() { }

    static void record(Context context, RemoteMessage message, String type) {
        int original = message.getOriginalPriority();
        int delivered = message.getPriority();
        boolean demoted = original == RemoteMessage.PRIORITY_HIGH && delivered != RemoteMessage.PRIORITY_HIGH;
        synchronized (PushStats.class) {
            SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long now = System.currentTimeMillis();
            long since = prefs.getLong("since", 0);
            // A new week starts the counts again.
            boolean fresh = since == 0 || now - since > WINDOW_MS;
            SharedPreferences.Editor edit = prefs.edit();
            if (fresh) edit.putLong("since", now);
            edit.putInt("received", (fresh ? 0 : prefs.getInt("received", 0)) + 1);
            if (fresh) edit.putInt("demoted", 0);
            if (demoted) {
                edit.putInt("demoted", (fresh ? 0 : prefs.getInt("demoted", 0)) + 1)
                    .putLong("lastDemotedAt", now)
                    .putString("lastDemotedType", type == null ? "" : type);
            }
            edit.apply();
        }
        if (demoted) Log.w(TAG, "push " + type + " delivered at lower priority (" + original + " -> " + delivered + ")");
    }

    /** { since, received, demoted, lastDemotedAt, lastDemotedType } for the app's Notifications screen. */
    static JSONObject snapshot(Context context) {
        SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject result = new JSONObject();
        try {
            result.put("since", prefs.getLong("since", 0))
                .put("received", prefs.getInt("received", 0))
                .put("demoted", prefs.getInt("demoted", 0))
                .put("lastDemotedAt", prefs.getLong("lastDemotedAt", 0))
                .put("lastDemotedType", prefs.getString("lastDemotedType", ""));
        } catch (Exception ignored) { }
        return result;
    }
}
