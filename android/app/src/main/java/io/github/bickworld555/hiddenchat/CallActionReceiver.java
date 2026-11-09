package io.github.bickworld555.hiddenchat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Handles "Reject" on the incoming-call notification and "Hang up" on the ongoing-call one without opening the app. */
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_REJECT = "io.github.bickworld555.hiddenchat.CALL_REJECT";
    static final String ACTION_HANGUP = "io.github.bickworld555.hiddenchat.CALL_HANGUP";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_HANGUP.equals(intent.getAction())) {
            // The call lives in the WebView, which ends it and tells the other side. Without a WebView there is no
            // call left to end, so only the call state (notification, audio route) is cleared.
            if (!HiddenNativePlugin.emitCallAction("hangup", null)) {
                MessagingService.setCall(context, false, false, null);
                CallAudio.stop(context);
            }
            return;
        }
        if (!ACTION_REJECT.equals(intent.getAction())) return;
        String callId = intent.getStringExtra(Alerts.EXTRA_CALL_ID);
        Alerts.cancelIncomingCall(context);
        // App closed: the service's connection tells the caller. App open (or in the background): the web app does.
        if (!NativeRelay.declinePendingCall(callId)) HiddenNativePlugin.emitCallAction("reject", callId);
    }
}
