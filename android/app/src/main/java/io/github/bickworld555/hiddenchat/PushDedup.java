package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

/**
 * Each push id (`pid`, server/push.mjs pushId) is handled once, like WhatsApp dropping a push it already processed
 * (`is_duplicate_push_dropped`): the same wake-up arrives over Firebase and over the always-connected socket, and
 * Firebase or the server may retry. Without this a repeat could ring, notify or start a fetch twice.
 *
 * Kept for the last MAX ids, also across a process restart (a push can wake a process that died after the first).
 * A push without an id (an older server) is always handled.
 */
final class PushDedup {
    private static final String PREFS = "hm_push_dedup";
    private static final int MAX = 128;
    private static final ArrayDeque<String> order = new ArrayDeque<>();
    private static final Set<String> seen = new HashSet<>();
    private static boolean loaded;

    private PushDedup() { }

    /** True the first time `pid` is seen (handle it), false for a repeat (drop it). */
    static synchronized boolean firstTime(Context context, String pid) {
        if (pid == null || pid.isEmpty()) return true;
        load(context);
        if (seen.contains(pid)) return false;
        seen.add(pid);
        order.addLast(pid);
        while (order.size() > MAX) seen.remove(order.removeFirst());
        save(context);
        return true;
    }

    private static void load(Context context) {
        if (loaded) return;
        loaded = true;
        try {
            JSONArray stored = new JSONArray(prefs(context).getString("ids", "[]"));
            for (int index = 0; index < stored.length(); index += 1) {
                String pid = stored.optString(index, "");
                if (!pid.isEmpty() && seen.add(pid)) order.addLast(pid);
            }
        } catch (Exception ignored) {
            // Unreadable: start empty (at worst one repeat is handled again).
        }
    }

    private static void save(Context context) {
        prefs(context).edit().putString("ids", new JSONArray(order).toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
