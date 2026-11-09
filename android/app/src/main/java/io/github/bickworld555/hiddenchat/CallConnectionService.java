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
        @SuppressWarnings("deprecation")
        public void onCallAudioStateChanged(CallAudioState state) {
            if (state == null || state.isMuted() == systemMuted) return;
            systemMuted = state.isMuted();
            TelecomCalls.muteFromSystem(this, systemMuted);
        }
    }
}
