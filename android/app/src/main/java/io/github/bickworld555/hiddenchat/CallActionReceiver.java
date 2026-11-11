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

    // The call in progress (set by the web app with setCallActive), so a hang-up from the notification, a headset
    // or the car reaches the server even while the app's screen is paused.
    static volatile String activeCallId;

    /** Ends the ongoing call (notification button, or a headset / car / watch through Android). */
    static void hangUp(Context context) {
        // The call lives in the WebView, which ends it and tells the other side. The server is told directly as well,
        // so the other side leaves at once even if the WebView is paused in the background (ending twice is harmless).
        Context app = context.getApplicationContext();
        endOnServer(app, activeCallId, "hang-up");
        if (!HiddenNativePlugin.emitCallAction("hangup", null)) {
            MessagingService.endOrphanedCall(app, "hang-up with no screen");
            return;
        }
        // The screen may be paused or gone without having said so; the hang-up must still end the call here.
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
            () -> MessagingService.endOrphanedCall(app, "hang-up not confirmed"), 2500);
    }

    /** Declines the ringing call (notification, call screen, or a headset / car / watch through Android). */
    static void decline(Context context, String callId) {
        TelecomCalls.rejected();
        Alerts.cancelIncomingCall(context);
        // The caller's phone stops ringing at once: the server is told directly (it ends the call once; a later copy
        // is a no-op), besides the service's connection or the web app, which may be paused in the background.
        endOnServer(context.getApplicationContext(), callId, "decline");
        boolean byService = NativeRelay.declinePendingCall(callId);
        boolean byApp = !byService && HiddenNativePlugin.emitCallAction("reject", callId);
        android.util.Log.i("CallAction", "decline " + callId + " via server" + (byService ? " + service" : byApp ? " + app" : ""));
    }

    /** POST /api/v1/calls/:id/end off the main thread. */
    private static void endOnServer(Context app, String callId, String why) {
        if (callId == null || callId.isEmpty()) return;
        new Thread(() -> {
            boolean ended = PushRegistration.endCall(app, callId);
            android.util.Log.i("CallAction", why + " " + callId + (ended ? " ended on the server" : " already over"));
        }, "call-end").start();
    }
}
