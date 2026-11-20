package io.github.bickworld555.hiddenchat;

import android.app.Activity;
import android.app.ActivityOptions;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

/**
 * "Answer" on the incoming-call notification. It has no window of its own (Theme.NoDisplay) and decides at the moment
 * of the tap how the call opens:
 * - phone locked: the call screen over the lock screen, as before;
 * - phone in use (another app, Home): the app opens straight into the floating call window instead of full screen,
 *   so the person stays where they were and never sees the chat list. A voice call then tucks itself away once it is
 *   running (AppActivity.callServiceReady); a video call stays in the floating window.
 * The app has to open at all because the call lives in its WebView, and Android only lets a call use the microphone
 * and camera from the background when its service started while the app was on screen.
 */
public class CallAnswerActivity extends Activity {
    static final String EXTRA_VIDEO = "hm_call_video";

    static Intent intent(Context context, String callId, boolean video) {
        return new Intent(context, CallAnswerActivity.class)
            .setAction(Alerts.ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            .putExtra(Alerts.EXTRA_CALL, true)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId)
            .putExtra(EXTRA_VIDEO, video);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent tapped = getIntent();
        String callId = tapped.getStringExtra(Alerts.EXTRA_CALL_ID);
        boolean video = tapped.getBooleanExtra(EXTRA_VIDEO, false);
        Intent accept = new Intent(this, AppActivity.class)
            .setAction(Alerts.ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(Alerts.EXTRA_CALL, true)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId);
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        Bundle options = null;
        if (!locked) {
            accept.putExtra(AppActivity.EXTRA_QUIET_ANSWER, true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                try {
                    options = ActivityOptions.makeLaunchIntoPip(AppActivity.pipParams(this, video)).toBundle();
                } catch (RuntimeException unsupported) {
                    options = null;
                }
            }
        }
        android.util.Log.i("CallReturn", "answer tapped: locked=" + locked + " video=" + video + " floating=" + (options != null));
        try {
            startActivity(accept, options);
        } catch (RuntimeException refused) {
            // Picture-in-picture turned off for the app (or not offered): open as before, it still answers.
            startActivity(accept);
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
