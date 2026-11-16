package io.github.bickworld555.hiddenchat;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * C2: a missed-call notification was swiped away, like WhatsApp's MissedCallNotificationDismissedReceiver. The calls
 * count as seen: the next missed call from that person counts from 1 again, and the person's chat row loses its red
 * missed-call mark (the app takes the "seen" event from CallEvents when it opens or returns to screen).
 */
public class MissedCallDismissReceiver extends BroadcastReceiver {
    private static final String EXTRA_CALLER = "hm_missed_caller";

    static PendingIntent intent(Context context, String callerId, int requestCode) {
        Intent dismissed = new Intent(context, MissedCallDismissReceiver.class).putExtra(EXTRA_CALLER, callerId);
        return PendingIntent.getBroadcast(context, requestCode, dismissed, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String callerId = intent == null ? null : intent.getStringExtra(EXTRA_CALLER);
        if (callerId == null || callerId.isEmpty()) return;
        Alerts.forgetMissedCount(callerId);
        CallEvents.record(context, null, callerId, false, "seen");
    }
}
