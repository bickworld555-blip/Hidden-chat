package io.github.bickworld555.hiddenchat;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telecom.Connection;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telecom.VideoProfile;
import android.util.Log;

/**
 * Hidden Messenger calls as Android phone calls (Telecom, self-managed ConnectionService), like WhatsApp: Android
 * knows a call is ringing or in progress, so a Bluetooth headset, car kit or watch can answer, decline, mute and
 * hang up; a SIM call arriving meanwhile is handled as call waiting; other apps' sound gives way; and the service may
 * keep the microphone as a phone call while the app is in the background.
 *
 * The screens stay the app's own (the native ringing screen, the call screen): a self-managed calling app shows its
 * own UI, and Android's phone app cannot show a WebRTC video call. One call at a time; a second ringing call while
 * one is in progress rings without Telecom.
 *
 * Events in: the call rings ({@link #incoming}), was answered or declined from our own screens ({@link #answered},
 * {@link #rejected}), stopped ringing ({@link #ringingStopped}), went live or ended ({@link #live}). Events out (from
 * Android): {@link #answerFromSystem}, {@link #declineFromSystem}, {@link #hangUpFromSystem}, {@link #muteFromSystem}.
 */
final class TelecomCalls {
    private static final String TAG = "TelecomCalls";
    private static final String ACCOUNT_ID = "hidden-messenger-calls";
    static final String EXTRA_CALL_ID = "hm_call_id";
    static final String EXTRA_NAME = "hm_name";
    static final String EXTRA_VIDEO = "hm_video";
    static final String EXTRA_INCOMING = "hm_incoming";
    /** A call that only rang in the app (ended or answered elsewhere) is dropped this long after it stops ringing. */
    private static final long RINGING_GRACE_MS = 2500;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static Context app;
    private static CallConnectionService.CallConnection connection;
    private static boolean registered;
    private static boolean placing;

    private TelecomCalls() {}

    static boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
    }

    static PhoneAccountHandle handle(Context context) {
        return new PhoneAccountHandle(new ComponentName(context, CallConnectionService.class), ACCOUNT_ID);
    }

    private static TelecomManager telecom(Context context) {
        return context.getSystemService(TelecomManager.class);
    }

    static Uri address(String callId) {
        return Uri.fromParts(PhoneAccount.SCHEME_SIP, callId == null || callId.isEmpty() ? "hidden-messenger" : callId, null);
    }

    /** Registers the calling account once per process (Android keeps it; registering again only updates it). */
    static synchronized boolean register(Context context) {
        if (!supported()) return false;
        app = context.getApplicationContext();
        if (registered) return true;
        TelecomManager telecom = telecom(app);
        if (telecom == null) return false;
        try {
            PhoneAccount account = PhoneAccount.builder(handle(app), "Hidden Messenger")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED | PhoneAccount.CAPABILITY_VIDEO_CALLING
                    | PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING)
                .setIcon(Icon.createWithResource(app, R.mipmap.ic_launcher))
                .setShortDescription("Hidden Messenger voice and video calls")
                .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
                .build();
            telecom.registerPhoneAccount(account);
            registered = true;
        } catch (RuntimeException refused) {
            Log.w(TAG, "calling account not registered", refused);
        }
        return registered;
    }

    static synchronized boolean hasCall() {
        return connection != null;
    }

    /** An incoming call started ringing (our own notification and screen show it). */
    static void incoming(Context context, String callId, String name, boolean video) {
        if (!register(context)) return;
        main.post(() -> {
            synchronized (TelecomCalls.class) {
                if (connection != null) {
                    // The same call again (the background connection first rings without the id, then with it).
                    if (connection.getState() == Connection.STATE_RINGING && connection.incoming) {
                        if (callId != null && !callId.isEmpty()) connection.callId = callId;
                        connection.setCallerDisplayName(name, TelecomManager.PRESENTATION_ALLOWED);
                    }
                    return;
                }
                TelecomManager telecom = telecom(app);
                if (telecom == null) return;
                try {
                    if (!telecom.isIncomingCallPermitted(handle(app))) {
                        Log.i(TAG, "incoming call not permitted now (another call cannot be held)");
                        return;
                    }
                    Bundle details = new Bundle();
                    details.putString(EXTRA_CALL_ID, callId == null ? "" : callId);
                    details.putString(EXTRA_NAME, name);
                    details.putBoolean(EXTRA_VIDEO, video);
                    details.putBoolean(EXTRA_INCOMING, true);
                    Bundle extras = new Bundle();
                    extras.putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, address(callId));
                    extras.putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, details);
                    if (video) extras.putInt(TelecomManager.EXTRA_INCOMING_VIDEO_STATE, VideoProfile.STATE_BIDIRECTIONAL);
                    telecom.addNewIncomingCall(handle(app), extras);
                } catch (RuntimeException refused) {
                    Log.w(TAG, "incoming call not reported", refused);
                }
            }
        });
    }

    /** The call went live (placed or answered) or ended, as the web app reports it (setCallActive). */
    static void live(Context context, boolean active, boolean video, String name) {
        if (!register(context)) return;
        main.post(() -> {
            synchronized (TelecomCalls.class) {
                if (!active) {
                    placing = false;
                    end(DisconnectCause.LOCAL);
                    return;
                }
                if (connection != null) {
                    if (connection.getState() != Connection.STATE_ACTIVE) connection.setActive();
                    connection.setVideoState(video ? VideoProfile.STATE_BIDIRECTIONAL : VideoProfile.STATE_AUDIO_ONLY);
                    return;
                }
                if (placing) return;
                // An outgoing call (or one answered inside the app before Android heard it ring).
                TelecomManager telecom = telecom(app);
                if (telecom == null) return;
                try {
                    if (!telecom.isOutgoingCallPermitted(handle(app))) {
                        Log.i(TAG, "outgoing call not permitted now");
                        return;
                    }
                    Bundle details = new Bundle();
                    details.putString(EXTRA_NAME, name);
                    details.putBoolean(EXTRA_VIDEO, video);
                    Bundle extras = new Bundle();
                    extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle(app));
                    extras.putInt(TelecomManager.EXTRA_START_CALL_WITH_VIDEO_STATE, video ? VideoProfile.STATE_BIDIRECTIONAL : VideoProfile.STATE_AUDIO_ONLY);
                    extras.putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, details);
                    placing = true;
                    telecom.placeCall(address(null), extras);
                } catch (RuntimeException refused) {
                    placing = false;
                    Log.w(TAG, "outgoing call not reported", refused);
                }
            }
        });
    }

    /** Answered on our own call screen or notification: Android hears it before the web app picks up. */
    static void answered() {
        main.post(() -> {
            synchronized (TelecomCalls.class) {
                if (connection != null && connection.getState() == Connection.STATE_RINGING) connection.setActive();
            }
        });
    }

    /** Declined on our own call screen or notification ("Decline", "Message"). */
    static void rejected() {
        main.post(() -> {
            synchronized (TelecomCalls.class) {
                if (connection != null && connection.getState() == Connection.STATE_RINGING) end(DisconnectCause.REJECTED);
            }
        });
    }

    /**
     * The ringing notification or in-app ringing went away. That happens on answer too (just before the call goes
     * live), so a still-ringing call is only dropped as missed if it has not been answered a moment later.
     */
    static void ringingStopped() {
        main.postDelayed(() -> {
            synchronized (TelecomCalls.class) {
                if (connection == null || connection.getState() != Connection.STATE_RINGING) return;
                if (Alerts.isRinging() || MessagingService.isCallActive()) return;
                end(DisconnectCause.MISSED);
            }
        }, RINGING_GRACE_MS);
    }

    /** Hard reset: Android has no call of ours left (setDisconnected + destroy), now if on the main thread. */
    static void endAll() {
        Runnable reset = () -> {
            synchronized (TelecomCalls.class) {
                placing = false;
                main.removeCallbacks(check);
                end(DisconnectCause.LOCAL);
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) reset.run();
        else main.post(reset);
    }

    private static void end(int cause) {
        CallConnectionService.CallConnection ending = connection;
        connection = null;
        if (ending == null) return;
        ending.setDisconnected(new DisconnectCause(cause));
        ending.destroy();
        Log.i(TAG, "call " + ending.callId + " ended (" + cause + ")");
    }

    // --- From CallConnectionService ---

    /** A call the app answered must be live in the app within this time, or Android drops it. */
    private static final long ACTIVE_WITHOUT_APP_CALL_MS = 20000;
    private static final long RINGING_WITHOUT_ALERT_MS = 5000;
    private static final long CHECK_INTERVAL_MS = 2500;
    private static long unbackedSince;

    /**
     * Android shows a call (the lock-screen call chip with its timer) for as long as the connection exists, so a
     * connection the app no longer backs is never left behind: active with no call in the app, or ringing with
     * nothing ringing. Runs while a connection exists.
     */
    private static final Runnable check = new Runnable() {
        @Override
        public void run() {
            synchronized (TelecomCalls.class) {
                if (connection == null) return;
                int state = connection.getState();
                boolean backed = state == Connection.STATE_RINGING ? Alerts.isRinging() || MessagingService.isCallActive() : MessagingService.isCallActive();
                long now = android.os.SystemClock.elapsedRealtime();
                if (backed) unbackedSince = 0;
                else if (unbackedSince == 0) unbackedSince = now;
                long limit = state == Connection.STATE_RINGING ? RINGING_WITHOUT_ALERT_MS : ACTIVE_WITHOUT_APP_CALL_MS;
                if (unbackedSince != 0 && now - unbackedSince >= limit) {
                    Log.i(TAG, "dropping a call the app no longer has");
                    end(state == Connection.STATE_RINGING ? DisconnectCause.MISSED : DisconnectCause.LOCAL);
                    return;
                }
                main.postDelayed(this, CHECK_INTERVAL_MS);
            }
        }
    };

    static synchronized void created(CallConnectionService.CallConnection created) {
        unbackedSince = 0;
        main.removeCallbacks(check);
        main.postDelayed(check, CHECK_INTERVAL_MS);
        if (!created.incoming) placing = false;
        if (connection != null && connection != created) {
            CallConnectionService.CallConnection previous = connection;
            connection = null;
            previous.setDisconnected(new DisconnectCause(DisconnectCause.OTHER));
            previous.destroy();
        }
        connection = created;
        Log.i(TAG, "call " + created.callId + (created.incoming ? " ringing" : " placed") + " through Telecom");
        // An outgoing call may have ended before Android created it.
        if (!created.incoming && !MessagingService.isCallActive()) end(DisconnectCause.LOCAL);
        else MessagingService.refresh();
    }

    static synchronized void failed(boolean incoming) {
        if (!incoming) placing = false;
        Log.i(TAG, (incoming ? "incoming" : "outgoing") + " call refused by Android (busy with another call)");
    }

    /** Headset, car, watch or the system answered: answer in the app (opening it over the lock screen). */
    static void answerFromSystem(CallConnectionService.CallConnection answered) {
        Context context = app;
        if (context == null) return;
        synchronized (TelecomCalls.class) {
            if (answered != connection) return;
            answered.setActive();
        }
        String callId = answered.callId;
        MainActivity.answeredFromOutside();
        Alerts.cancelIncomingCall(context);
        Intent open = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(Alerts.EXTRA_CALL, true)
            .putExtra(Alerts.EXTRA_CALL_ID, callId);
        // The app's screen is running: it answers now; otherwise the screen opens and answers as it loads.
        if (!HiddenNativePlugin.emitCallAction("accept", callId)) open.setAction(Alerts.ACTION_ACCEPT);
        try {
            context.startActivity(open);
        } catch (RuntimeException blocked) {
            Log.w(TAG, "call screen not opened", blocked);
        }
    }

    static void declineFromSystem(CallConnectionService.CallConnection declined) {
        synchronized (TelecomCalls.class) {
            if (declined != connection) return;
            end(DisconnectCause.REJECTED);
        }
        if (app != null) CallActionReceiver.decline(app, declined.callId);
    }

    static void hangUpFromSystem(CallConnectionService.CallConnection ended) {
        synchronized (TelecomCalls.class) {
            if (ended != connection) return;
            end(DisconnectCause.LOCAL);
        }
        if (app != null) CallActionReceiver.hangUp(app);
    }

    static void muteFromSystem(CallConnectionService.CallConnection muted, boolean on) {
        synchronized (TelecomCalls.class) {
            if (muted != connection || muted.getState() != Connection.STATE_ACTIVE) return;
        }
        com.getcapacitor.JSObject extra = new com.getcapacitor.JSObject();
        extra.put("muted", on);
        HiddenNativePlugin.emitCallAction("mute", muted.callId, extra);
    }
}
