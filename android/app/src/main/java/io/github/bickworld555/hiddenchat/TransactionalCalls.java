package io.github.bickworld555.hiddenchat;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.os.Handler;
import android.os.Looper;
import android.os.OutcomeReceiver;
import android.telecom.CallAttributes;
import android.telecom.CallControl;
import android.telecom.CallControlCallback;
import android.telecom.CallEndpoint;
import android.telecom.CallEventCallback;
import android.telecom.CallException;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telecom.VideoProfile;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

/**
 * Hidden Messenger calls through Android's transactional calling API (Android 14+, TelecomManager.addCall), the way
 * WhatsApp places its calls. For the person nothing changes from {@link TelecomCalls}' ConnectionService: headset,
 * car and watch answer / decline / mute / hang up, other apps' sound gives way, Telecom owns the audio route, and the
 * screens stay our own. What changes: Android no longer treats the call as one its phone-call machinery screens, so
 * when it ends the default call-screening app (Truecaller on the S23) is not started with its post-call screen
 * (android.telecom.action.POST_CALL, sent by Telecom after every ConnectionService call, 2026-11-22). Android also
 * lends the call its own foreground-service standing (FGS delegation) while it lasts.
 *
 * Same events as {@link TelecomCalls}, which hands them here on Android 14+. All on the main thread.
 */
@RequiresApi(34)
final class TransactionalCalls {
    private static final String TAG = "TelecomCalls";
    private static final String ACCOUNT_ID = "hidden-messenger-transactional";
    private static final long RINGING_GRACE_MS = 2500;
    private static final long ACTIVE_WITHOUT_APP_CALL_MS = 20000;
    private static final long RINGING_WITHOUT_ALERT_MS = 5000;
    private static final long CHECK_INTERVAL_MS = 2500;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static Context app;
    private static boolean registered;

    // The one call Android knows of (one at a time, as before).
    private static CallControl control;
    private static String callId = "";
    private static boolean incoming;
    private static boolean ringing;
    private static boolean video;
    private static boolean pending;       // addCall sent, its answer not back yet
    private static boolean endWhenAdded;  // the call ended in the app before Android finished adding it
    private static int generation;        // which call a late callback belongs to
    private static List<CallEndpoint> endpoints = Collections.emptyList();
    private static int endpointType = -1;
    private static long unbackedSince;

    private TransactionalCalls() {}

    static PhoneAccountHandle handle(Context context) {
        // A transactional account is not bound to a service: the component only names the app.
        return new PhoneAccountHandle(new ComponentName(context.getPackageName(), context.getPackageName() + ".calls"), ACCOUNT_ID);
    }

    private static Executor executor() {
        return app.getMainExecutor();
    }

    static synchronized boolean register(Context context) {
        app = context.getApplicationContext();
        if (registered) return true;
        TelecomManager telecom = app.getSystemService(TelecomManager.class);
        if (telecom == null) return false;
        try {
            PhoneAccount account = PhoneAccount.builder(handle(app), "Hidden Messenger")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED | PhoneAccount.CAPABILITY_SUPPORTS_TRANSACTIONAL_OPERATIONS
                    | PhoneAccount.CAPABILITY_VIDEO_CALLING | PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING)
                .setIcon(Icon.createWithResource(app, R.mipmap.ic_launcher))
                .setShortDescription("Hidden Messenger voice and video calls")
                .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
                .build();
            telecom.registerPhoneAccount(account);
            // The ConnectionService account of earlier versions goes, so Android lists one calling account.
            try { telecom.unregisterPhoneAccount(TelecomCalls.handle(app)); } catch (RuntimeException ignored) { }
            registered = true;
        } catch (RuntimeException refused) {
            Log.w(TAG, "transactional calling account not registered", refused);
        }
        return registered;
    }

    static synchronized boolean hasCall() {
        return control != null;
    }

    /** Puts the call's audio on the loudspeaker or else a headset / the earpiece, through Telecom; false with no call. */
    static synchronized boolean route(boolean speaker) {
        if (control == null || endpoints.isEmpty()) return false;
        CallEndpoint target = pickEndpoint(endpoints, speaker);
        if (target == null) return false;
        if (target.getEndpointType() == endpointType) return true;
        control.requestCallEndpointChange(target, executor(), new OutcomeReceiver<Void, CallException>() {
            @Override public void onResult(Void result) { Log.i("CallAudio", "Telecom route set to " + target.getEndpointName()); }
            @Override public void onError(@NonNull CallException error) { Log.w("CallAudio", "Telecom route refused: " + error.getCode()); }
        });
        return true;
    }

    private static CallEndpoint pickEndpoint(List<CallEndpoint> available, boolean speaker) {
        CallEndpoint earpiece = null, loud = null, headset = null;
        for (CallEndpoint endpoint : available) {
            switch (endpoint.getEndpointType()) {
                case CallEndpoint.TYPE_EARPIECE: earpiece = endpoint; break;
                case CallEndpoint.TYPE_SPEAKER: loud = endpoint; break;
                case CallEndpoint.TYPE_BLUETOOTH:
                case CallEndpoint.TYPE_WIRED_HEADSET:
                    if (headset == null) headset = endpoint;
                    break;
                default: break;
            }
        }
        if (speaker) return loud != null ? loud : earpiece;
        if (headset != null) return headset;
        return earpiece != null ? earpiece : loud;
    }

    // --- Events from the app (TelecomCalls hands them over) ---

    static void incoming(Context context, String id, String name, boolean isVideo) {
        if (!register(context)) return;
        main.post(() -> {
            synchronized (TransactionalCalls.class) {
                if (control != null || pending) {
                    // The same call again (the background connection first rings without the id, then with it).
                    if (incoming && ringing && id != null && !id.isEmpty()) callId = id;
                    return;
                }
                add(CallAttributes.DIRECTION_INCOMING, id, name, isVideo);
            }
        });
    }

    static void live(Context context, boolean active, boolean isVideo, String name) {
        if (!register(context)) return;
        main.post(() -> {
            synchronized (TransactionalCalls.class) {
                if (!active) {
                    end(DisconnectCause.LOCAL);
                    return;
                }
                video = isVideo;
                if (control != null) {
                    if (ringing) answerCall();
                    CallAudio.telecomReady();
                    return;
                }
                if (pending) return;
                // An outgoing call (or one answered inside the app before Android heard it ring).
                add(CallAttributes.DIRECTION_OUTGOING, null, name, isVideo);
            }
        });
    }

    static void answered() {
        main.post(() -> {
            synchronized (TransactionalCalls.class) {
                if (control != null && ringing) answerCall();
            }
        });
    }

    static void rejected() {
        main.post(() -> {
            synchronized (TransactionalCalls.class) {
                if (ringing) end(DisconnectCause.REJECTED);
            }
        });
    }

    static void ringingStopped() {
        main.postDelayed(() -> {
            synchronized (TransactionalCalls.class) {
                if (!ringing) return;
                if (Alerts.isRinging() || MessagingService.isCallActive()) return;
                end(DisconnectCause.MISSED);
            }
        }, RINGING_GRACE_MS);
    }

    static void endAll() {
        Runnable reset = () -> {
            synchronized (TransactionalCalls.class) {
                main.removeCallbacks(check);
                end(DisconnectCause.LOCAL);
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) reset.run();
        else main.post(reset);
    }

    // --- Android's side ---

    private static void add(int direction, String id, String name, boolean isVideo) {
        TelecomManager telecom = app.getSystemService(TelecomManager.class);
        if (telecom == null) return;
        final int call = ++generation;
        incoming = direction == CallAttributes.DIRECTION_INCOMING;
        ringing = incoming;
        video = isVideo;
        callId = id == null ? "" : id;
        endWhenAdded = false;
        String shown = name == null || name.trim().isEmpty() ? "Hidden Messenger" : name.trim();
        CallAttributes attributes = new CallAttributes.Builder(handle(app), direction, shown, TelecomCalls.address(id))
            .setCallType(isVideo ? CallAttributes.VIDEO_CALL : CallAttributes.AUDIO_CALL)
            .setCallCapabilities(0)
            .build();
        pending = true;
        try {
            telecom.addCall(attributes, executor(), new OutcomeReceiver<CallControl, CallException>() {
                @Override
                public void onResult(CallControl added) {
                    synchronized (TransactionalCalls.class) {
                        pending = false;
                        if (call != generation || endWhenAdded) {
                            // Ended (or replaced) in the app while Android was adding it.
                            added.disconnect(new DisconnectCause(incoming && ringing ? DisconnectCause.MISSED : DisconnectCause.LOCAL), executor(), ignore("late end"));
                            return;
                        }
                        control = added;
                        Log.i(TAG, "call " + callId + (incoming ? " ringing" : " placed") + " through Telecom (transactional)");
                        unbackedSince = 0;
                        main.removeCallbacks(check);
                        main.postDelayed(check, CHECK_INTERVAL_MS);
                        if (incoming) {
                            // Answered in the app before Android heard it ring: active at once.
                            if (MessagingService.isCallActive()) answerCall();
                            else if (!Alerts.isRinging()) { end(DisconnectCause.MISSED); return; }
                            TelecomCalls.showCallScreen();
                        } else if (!MessagingService.isCallActive()) {
                            end(DisconnectCause.LOCAL);
                            return;
                        } else {
                            added.setActive(executor(), ignore("set active"));
                        }
                        CallAudio.telecomReady();
                        MessagingService.refresh();
                    }
                }

                @Override
                public void onError(@NonNull CallException refused) {
                    synchronized (TransactionalCalls.class) {
                        if (call == generation) { pending = false; ringing = false; }
                    }
                    Log.i(TAG, (incoming ? "incoming" : "outgoing") + " call refused by Android: " + refused.getCode());
                }
            }, new Control(call), new Events(call));
        } catch (RuntimeException refused) {
            pending = false;
            ringing = false;
            Log.w(TAG, "call not reported to Android", refused);
        }
    }

    private static void answerCall() {
        if (control == null) return;
        ringing = false;
        control.answer(video ? VideoProfile.STATE_BIDIRECTIONAL : VideoProfile.STATE_AUDIO_ONLY, executor(), ignore("answer"));
    }

    private static void end(int cause) {
        boolean wasRinging = ringing;
        ringing = false;
        if (pending) { endWhenAdded = true; return; }
        CallControl ending = control;
        control = null;
        endpoints = Collections.emptyList();
        endpointType = -1;
        main.removeCallbacks(check);
        if (ending == null) return;
        ending.disconnect(new DisconnectCause(wasRinging && cause == DisconnectCause.LOCAL ? DisconnectCause.MISSED : cause), executor(), ignore("disconnect"));
        Log.i(TAG, "call " + callId + " ended (" + cause + ")");
        MessagingService.refresh();
    }

    private static OutcomeReceiver<Void, CallException> ignore(String what) {
        return new OutcomeReceiver<Void, CallException>() {
            @Override public void onResult(Void result) { }
            @Override public void onError(@NonNull CallException error) { Log.w(TAG, what + " refused: " + error.getCode()); }
        };
    }

    /**
     * Android shows a call (the status-bar chip with its timer) for as long as it exists, so a call the app no longer
     * backs is never left behind: active with no call in the app, or ringing with nothing ringing.
     */
    private static final Runnable check = new Runnable() {
        @Override
        public void run() {
            synchronized (TransactionalCalls.class) {
                if (control == null) return;
                boolean backed = ringing ? Alerts.isRinging() || MessagingService.isCallActive() : MessagingService.isCallActive();
                long now = android.os.SystemClock.elapsedRealtime();
                if (backed) unbackedSince = 0;
                else if (unbackedSince == 0) unbackedSince = now;
                long limit = ringing ? RINGING_WITHOUT_ALERT_MS : ACTIVE_WITHOUT_APP_CALL_MS;
                if (unbackedSince != 0 && now - unbackedSince >= limit) {
                    Log.i(TAG, "dropping a call the app no longer has");
                    end(ringing ? DisconnectCause.MISSED : DisconnectCause.LOCAL);
                    return;
                }
                main.postDelayed(this, CHECK_INTERVAL_MS);
            }
        }
    };

    /** What Android asks of the call (headset, car, watch, another call). */
    private static final class Control implements CallControlCallback {
        private final int call;
        Control(int call) { this.call = call; }
        private boolean current() { return call == generation && control != null; }

        @Override
        public void onSetActive(@NonNull Consumer<Boolean> done) {
            done.accept(true);
        }

        @Override
        public void onSetInactive(@NonNull Consumer<Boolean> done) {
            // No hold (as before): the call stays as it is.
            done.accept(false);
        }

        @Override
        public void onAnswer(int videoState, @NonNull Consumer<Boolean> done) {
            done.accept(true);
            Context context = app;
            String id;
            synchronized (TransactionalCalls.class) {
                if (!current() || !ringing || context == null) return;
                ringing = false;
                id = callId;
            }
            TelecomCalls.answerInApp(context, id);
        }

        @Override
        public void onDisconnect(@NonNull DisconnectCause cause, @NonNull Consumer<Boolean> done) {
            done.accept(true);
            Context context = app;
            boolean wasRinging;
            String id;
            synchronized (TransactionalCalls.class) {
                if (!current()) return;
                wasRinging = ringing;
                id = callId;
                ringing = false;
                control = null;
                endpoints = Collections.emptyList();
                endpointType = -1;
                main.removeCallbacks(check);
            }
            Log.i(TAG, "call " + id + " ended by Android (" + cause.getCode() + ")");
            if (context == null) return;
            if (wasRinging) CallActionReceiver.decline(context, id);
            else CallActionReceiver.hangUp(context);
            MessagingService.refresh();
        }

        @Override
        public void onCallStreamingStarted(@NonNull Consumer<Boolean> done) {
            done.accept(false);
        }
    }

    /** What happens to the call around it (audio route, mute from a headset or car). */
    private static final class Events implements CallEventCallback {
        private final int call;
        Events(int call) { this.call = call; }

        @Override
        public void onCallEndpointChanged(@NonNull CallEndpoint endpoint) {
            synchronized (TransactionalCalls.class) {
                if (call != generation) return;
                endpointType = endpoint.getEndpointType();
            }
            Log.i("CallAudio", "Telecom route now " + endpoint.getEndpointName());
        }

        @Override
        public void onAvailableCallEndpointsChanged(@NonNull List<CallEndpoint> available) {
            synchronized (TransactionalCalls.class) {
                if (call != generation) return;
                endpoints = new ArrayList<>(available);
            }
            CallAudio.telecomReady();
        }

        @Override
        public void onMuteStateChanged(boolean muted) {
            String id;
            synchronized (TransactionalCalls.class) {
                if (call != generation || control == null || ringing) return;
                id = callId;
            }
            com.getcapacitor.JSObject extra = new com.getcapacitor.JSObject();
            extra.put("muted", muted);
            HiddenNativePlugin.emitCallAction("mute", id, extra);
        }

        @Override
        public void onCallStreamingFailed(int reason) { }

        @Override
        public void onEvent(@NonNull String event, @NonNull android.os.Bundle extras) { }

        // Android 15+: the call's video state changed from outside (no action here; the app decides video).
        public void onVideoStateChanged(int videoState) { }
    }
}
