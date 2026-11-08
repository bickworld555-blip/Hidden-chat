package io.github.bickworld555.hiddenchat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Handles "Reject" on the incoming-call notification without opening the app. */
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_REJECT = "io.github.bickworld555.hiddenchat.CALL_REJECT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_REJECT.equals(intent.getAction())) return;
        String callId = intent.getStringExtra(Alerts.EXTRA_CALL_ID);
        Alerts.cancelIncomingCall(context);
        // App closed: the service's connection tells the caller. App open (or in the background): the web app does.
        if (!NativeRelay.declinePendingCall(callId)) HiddenNativePlugin.emitCallAction("reject", callId);
    }
}
