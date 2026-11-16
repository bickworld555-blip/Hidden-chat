package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Calls this phone handled without the app's screen (rung by push or the background service, then missed or
 * declined; or missed while the phone was offline, from the server's missed-call push). The app takes them when it
 * opens (HiddenNativePlugin.takeCallEvents) and writes each one to the call log and the chat, as calls it handled
 * itself: one entry per call, keyed by the call id so a call the app also saw is logged once.
 */
final class CallEvents {
    private static final String PREFS = "hm_call_events";
    private static final int MAX_EVENTS = 200;

    private CallEvents() { }

    /** `status`: "missed" | "declined". Ignored without a caller; a second event for the same call is dropped. */
    static void record(Context context, String callId, String peerId, boolean video, String status) {
        record(context, callId, peerId, video, status, null);
    }

    /** `reason`: why it did not ring through ("dnd": the phone was in Do Not Disturb), or null. */
    static synchronized void record(Context context, String callId, String peerId, boolean video, String status, String reason) {
        if (peerId == null || peerId.isEmpty()) return;
        SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONArray list = new JSONArray(prefs.getString("events", "[]"));
            String id = callId == null ? "" : callId;
            if (!id.isEmpty()) {
                for (int i = 0; i < list.length(); i++) {
                    if (id.equals(list.optJSONObject(i) == null ? null : list.optJSONObject(i).optString("callId"))) return;
                }
            }
            list.put(new JSONObject()
                .put("callId", id)
                .put("peerId", peerId)
                .put("mode", video ? "video" : "audio")
                .put("status", status)
                .put("direction", "incoming")
                .put("reason", reason == null ? "" : reason)
                .put("at", System.currentTimeMillis()));
            JSONArray kept = list;
            if (list.length() > MAX_EVENTS) {
                kept = new JSONArray();
                for (int i = list.length() - MAX_EVENTS; i < list.length(); i++) kept.put(list.get(i));
            }
            prefs.edit().putString("events", kept.toString()).apply();
        } catch (JSONException broken) {
            prefs.edit().remove("events").apply();
        }
    }

    /** The recorded calls, oldest first; the list is emptied. */
    static synchronized JSONArray take(Context context) {
        SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString("events", "[]");
        prefs.edit().remove("events").apply();
        try {
            return new JSONArray(stored);
        } catch (JSONException broken) {
            return new JSONArray();
        }
    }
}
