package io.github.bickworld555.hiddenchat;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * "Answer" on the incoming-call notification. It has no window of its own (Theme.NoDisplay) and decides at the moment
 * of the tap how the call opens:
 * - phone locked: the call screen over the lock screen, as before;
 * - phone in use (another app, Home): the call screen full size, with a native "Connecting…" stand-in until the web
 *   app has drawn it (AppActivity.coverIfAnsweredAway), so the chat list never shows. Home/Back during a video call
 *   floats it, a voice call carries on with the call chip, and hang-up goes back to the app the person was in.
 */
public class CallAnswerActivity extends Activity {
    static final String EXTRA_VIDEO = "hm_call_video";

    static Intent intent(Context context, String callId, boolean video, String callerName) {
        return new Intent(context, CallAnswerActivity.class)
            .setAction(Alerts.ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            .putExtra(Alerts.EXTRA_CALL, true)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId)
            .putExtra(EXTRA_VIDEO, video)
            .putExtra(AppActivity.EXTRA_CALLER_NAME, callerName);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent tapped = getIntent();
        String callId = tapped.getStringExtra(Alerts.EXTRA_CALL_ID);
        Intent accept = new Intent(this, AppActivity.class)
            .setAction(Alerts.ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(Alerts.EXTRA_CALL, true)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId);
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        if (!locked) {
            accept.putExtra(AppActivity.EXTRA_ANSWERED_AWAY, true);
            accept.putExtra(AppActivity.EXTRA_CALLER_NAME, tapped.getStringExtra(AppActivity.EXTRA_CALLER_NAME));
        }
        android.util.Log.i("CallReturn", "answer tapped: locked=" + locked + " video=" + tapped.getBooleanExtra(EXTRA_VIDEO, false));
        startActivity(accept);
        finish();
        overridePendingTransition(0, 0);
    }
}
