package io.github.bickworld555.hiddenchat;

import android.os.Bundle;
import android.telecom.CallAudioState;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telecom.VideoProfile;

/**
 * Android's side of a Hidden Messenger call (see {@link TelecomCalls}). Telecom asks this service for a Connection
 * when a call rings or is placed; the Connection passes on what Android (headset, car, watch, call waiting) does.
 */
public class CallConnectionService extends ConnectionService {

    @Override
    public Connection onCreateIncomingConnection(PhoneAccountHandle account, ConnectionRequest request) {
        CallConnection connection = new CallConnection(details(request), true);
        connection.setRinging();
        TelecomCalls.created(connection);
        return connection;
    }

    @Override
    public void onCreateIncomingConnectionFailed(PhoneAccountHandle account, ConnectionRequest request) {
        TelecomCalls.failed(true);
    }

    @Override
    public Connection onCreateOutgoingConnection(PhoneAccountHandle account, ConnectionRequest request) {
        CallConnection connection = new CallConnection(details(request), false);
        // The web app reports the call once it is placed; from Android's point of view it is in progress.
        connection.setActive();
        TelecomCalls.created(connection);
        return connection;
    }

    @Override
    public void onCreateOutgoingConnectionFailed(PhoneAccountHandle account, ConnectionRequest request) {
        TelecomCalls.failed(false);
    }

    /** Our details travel in the request's extras (nested in the incoming-call bundle on some Android versions). */
    private static Bundle details(ConnectionRequest request) {
        Bundle extras = request.getExtras();
        if (extras == null) return new Bundle();
        Bundle nested = extras.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS);
        if (nested != null && !extras.containsKey(TelecomCalls.EXTRA_INCOMING)) return nested;
        Bundle outgoing = extras.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS);
        if (outgoing != null && !extras.containsKey(TelecomCalls.EXTRA_NAME)) return outgoing;
        return extras;
    }

    static final class CallConnection extends Connection {
        volatile String callId;
        final boolean incoming;
        private boolean systemMuted;
        // Android 14+: where this call's audio can go and where it goes now (Telecom reports both).
        private volatile java.util.List<android.telecom.CallEndpoint> endpoints = java.util.Collections.emptyList();
        private volatile int endpointType = -1;

        CallConnection(Bundle details, boolean incoming) {
            this.incoming = incoming;
            callId = details.getString(TelecomCalls.EXTRA_CALL_ID, "");
            String name = details.getString(TelecomCalls.EXTRA_NAME, "Hidden Messenger");
            boolean video = details.getBoolean(TelecomCalls.EXTRA_VIDEO, false);
            setConnectionProperties(PROPERTY_SELF_MANAGED);
            setAudioModeIsVoip(true);
            setConnectionCapabilities(CAPABILITY_MUTE | (video ? CAPABILITY_SUPPORTS_VT_LOCAL_BIDIRECTIONAL | CAPABILITY_SUPPORTS_VT_REMOTE_BIDIRECTIONAL : 0));
            setAddress(TelecomCalls.address(callId), TelecomManager.PRESENTATION_ALLOWED);
            setCallerDisplayName(name == null || name.isEmpty() ? "Hidden Messenger" : name, TelecomManager.PRESENTATION_ALLOWED);
            setVideoState(video ? VideoProfile.STATE_BIDIRECTIONAL : VideoProfile.STATE_AUDIO_ONLY);
        }

        @Override
        public void onShowIncomingCallUi() {
            // The ringing notification (with its full-screen intent) is already up; on a locked phone also open the
            // native call screen directly, where Android allows it.
            TelecomCalls.showCallScreen();
        }

        @Override
        public void onAnswer() {
            TelecomCalls.answerFromSystem(this);
        }

        @Override
        public void onAnswer(int videoState) {
            TelecomCalls.answerFromSystem(this);
        }

        @Override
        public void onReject() {
            TelecomCalls.declineFromSystem(this);
        }

        @Override
        public void onDisconnect() {
            if (getState() == STATE_RINGING) TelecomCalls.declineFromSystem(this);
            else TelecomCalls.hangUpFromSystem(this);
        }

        @Override
        public void onAbort() {
            onDisconnect();
        }

        @Override
        @androidx.annotation.RequiresApi(34)
        public void onAvailableCallEndpointsChanged(@androidx.annotation.NonNull java.util.List<android.telecom.CallEndpoint> available) {
            endpoints = new java.util.ArrayList<>(available);
            CallAudio.telecomReady();
        }

        @Override
        @androidx.annotation.RequiresApi(34)
        public void onCallEndpointChanged(@androidx.annotation.NonNull android.telecom.CallEndpoint endpoint) {
            endpointType = endpoint.getEndpointType();
            android.util.Log.i("CallAudio", "Telecom route now " + endpoint.getEndpointName());
        }

        /**
         * Puts the call's audio on the loudspeaker, or else on a headset (Bluetooth, wired) or the earpiece, through
         * Telecom: for a self-managed call Telecom owns the route and puts back any route set behind its back.
         */
        @SuppressWarnings("deprecation")
        boolean routeTo(boolean speaker) {
            if (android.os.Build.VERSION.SDK_INT >= 34 && !endpoints.isEmpty()) {
                android.telecom.CallEndpoint target = pickEndpoint(endpoints, speaker);
                if (target != null) {
                    if (target.getEndpointType() == endpointType) return true;
                    requestCallEndpointChange(target, Runnable::run, new android.os.OutcomeReceiver<Void, android.telecom.CallEndpointException>() {
                        @Override public void onResult(Void result) { android.util.Log.i("CallAudio", "Telecom route set to " + target.getEndpointName()); }
                        @Override public void onError(@androidx.annotation.NonNull android.telecom.CallEndpointException error) { android.util.Log.w("CallAudio", "Telecom route refused: " + error.getCode()); }
                    });
                    return true;
                }
            }
            CallAudioState state = getCallAudioState();
            int mask = state == null ? 0 : state.getSupportedRouteMask();
            int route = speaker ? CallAudioState.ROUTE_SPEAKER
                : (mask & CallAudioState.ROUTE_BLUETOOTH) != 0 ? CallAudioState.ROUTE_BLUETOOTH : CallAudioState.ROUTE_WIRED_OR_EARPIECE;
            if (state == null || state.getRoute() != route) setAudioRoute(route);
            return true;
        }

        @androidx.annotation.RequiresApi(34)
        private static android.telecom.CallEndpoint pickEndpoint(java.util.List<android.telecom.CallEndpoint> available, boolean speaker) {
            android.telecom.CallEndpoint earpiece = null, loud = null, headset = null;
            for (android.telecom.CallEndpoint endpoint : available) {
                switch (endpoint.getEndpointType()) {
                    case android.telecom.CallEndpoint.TYPE_EARPIECE: earpiece = endpoint; break;
                    case android.telecom.CallEndpoint.TYPE_SPEAKER: loud = endpoint; break;
                    case android.telecom.CallEndpoint.TYPE_BLUETOOTH:
                    case android.telecom.CallEndpoint.TYPE_WIRED_HEADSET:
                        if (headset == null) headset = endpoint;
                        break;
                    default: break;
                }
            }
            if (speaker) return loud != null ? loud : earpiece;
            if (headset != null) return headset;
            return earpiece != null ? earpiece : loud;
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCallAudioStateChanged(CallAudioState state) {
            if (state == null || state.isMuted() == systemMuted) return;
            systemMuted = state.isMuted();
            TelecomCalls.muteFromSystem(this, systemMuted);
        }
    }
}
