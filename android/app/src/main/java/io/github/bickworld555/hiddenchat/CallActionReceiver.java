package io.github.bickworld555.hiddenchat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Handles "Reject" on the incoming-call notification and "Hang up" on the ongoing-call one without opening the app. */
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_REJECT = "io.github.bickworld555.hiddenchat.CALL_REJECT";
    static final String ACTION_HANGUP = "io.github.bickworld555.hiddenchat.CALL_HANGUP";
    static final String ACTION_REPLY = "io.github.bickworld555.hiddenchat.CALL_REPLY";
    static final String EXTRA_TEXT = "hm_text";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_HANGUP.equals(intent.getAction())) {
            hangUp(context);
            return;
        }
        if (ACTION_REPLY.equals(intent.getAction())) {
            // "Message" on the ringing call: decline it and send a quick reply, without opening the app.
            String callId = intent.getStringExtra(Alerts.EXTRA_CALL_ID);
            String text = intent.getStringExtra(EXTRA_TEXT);
            TelecomCalls.rejected();
            Alerts.cancelIncomingCall(context);
            boolean byService = NativeRelay.replyToPendingCall(callId, text) && NativeRelay.declinePendingCall(callId);
            if (!byService) {
                com.getcapacitor.JSObject extra = new com.getcapacitor.JSObject();
                extra.put("text", text);
                HiddenNativePlugin.emitCallAction("reply", callId, extra);
            }
            return;
        }
        if (ACTION_REJECT.equals(intent.getAction())) decline(context, intent.getStringExtra(Alerts.EXTRA_CALL_ID));
    }

    /** Ends the ongoing call (notification button, or a headset / car / watch through Android). */
    static void hangUp(Context context) {
        // The call lives in the WebView, which ends it and tells the other side. Without a WebView there is no
        // call left to end, so only the call state (notification, audio route) is cleared.
        if (!HiddenNativePlugin.emitCallAction("hangup", null)) {
            MessagingService.setCall(context, false, false, null);
            CallAudio.stop(context);
        }
    }

    /** Declines the ringing call (notification, call screen, or a headset / car / watch through Android). */
    static void decline(Context context, String callId) {
        TelecomCalls.rejected();
        Alerts.cancelIncomingCall(context);
        // App closed: the service's connection tells the caller. App open (or in the background): the web app does.
        boolean byService = NativeRelay.declinePendingCall(callId);
        boolean byApp = !byService && HiddenNativePlugin.emitCallAction("reject", callId);
        android.util.Log.i("CallAction", "decline " + callId + " via " + (byService ? "service" : byApp ? "app" : "nobody"));
    }
}
