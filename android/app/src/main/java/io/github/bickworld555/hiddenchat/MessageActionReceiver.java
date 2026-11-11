package io.github.bickworld555.hiddenchat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import androidx.core.app.RemoteInput;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * "Reply", "Mark as read" and "Mute" on a message notification. Messages are end-to-end encrypted by the web app, so the
 * action goes to it: straight away while its screen is alive, otherwise queued until the app next opens (the
 * notification then says the reply is waiting, rather than pretending it was sent).
 */
public class MessageActionReceiver extends BroadcastReceiver {
    static final String ACTION_REPLY = "io.github.bickworld555.hiddenchat.MESSAGE_REPLY";
    static final String ACTION_READ = "io.github.bickworld555.hiddenchat.MESSAGE_READ";
    static final String ACTION_MUTE = "io.github.bickworld555.hiddenchat.MESSAGE_MUTE";
    static final String EXTRA_TAG = "hm_tag";
    static final String KEY_TEXT = "hm_reply_text";
    private static final String PREFS = "hidden_message_actions";
    private static final int MAX_QUEUED = 50;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        String open = intent.getStringExtra(Alerts.EXTRA_OPEN);
        String tag = intent.getStringExtra(EXTRA_TAG);
        if (open == null || open.isEmpty()) return;
        boolean reply = ACTION_REPLY.equals(action);
        if (ACTION_MUTE.equals(action)) {
            // Quiet at once, also while the app is closed; the app records the mute in its settings too.
            RelaySession.mute(context, open);
            if (!HiddenNativePlugin.emitMessageAction("mute", open, "")) queue(context, "mute", open, "");
            Alerts.cancelMessage(context, tag);
            return;
        }
        if (!reply && !ACTION_READ.equals(action)) return;
        String text = "";
        if (reply) {
            Bundle input = RemoteInput.getResultsFromIntent(intent);
            CharSequence typed = input == null ? null : input.getCharSequence(KEY_TEXT);
            text = typed == null ? "" : typed.toString().trim();
            if (text.isEmpty()) {
                Alerts.cancelMessage(context, tag);
                return;
            }
        }
        String name = reply ? "reply" : "read";
        boolean delivered = HiddenNativePlugin.emitMessageAction(name, open, text);
        if (!delivered) queue(context, name, open, text);
        if (reply && !delivered) Alerts.showReplyWaiting(context, tag, open, text);
        else Alerts.cancelMessage(context, tag);
    }

    private static synchronized void queue(Context context, String action, String open, String text) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONArray list = new JSONArray(prefs.getString("queue", "[]"));
            if (list.length() >= MAX_QUEUED) return;
            list.put(new JSONObject().put("action", action).put("open", open).put("text", text));
            prefs.edit().putString("queue", list.toString()).apply();
        } catch (JSONException broken) {
            prefs.edit().remove("queue").apply();
        }
    }

    /** The queued actions, oldest first; the queue is emptied. */
    static synchronized JSONArray take(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString("queue", "[]");
        prefs.edit().remove("queue").apply();
        try {
            return new JSONArray(stored);
        } catch (JSONException broken) {
            return new JSONArray();
        }
    }
}
