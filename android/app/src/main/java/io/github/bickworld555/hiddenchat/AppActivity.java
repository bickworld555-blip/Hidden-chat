package io.github.bickworld555.hiddenchat;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import java.util.Collections;

public class AppActivity extends BridgeActivity {
    private static volatile boolean alive;
    private static AppActivity current;
    private static volatile boolean visible;
    // The call was answered from the lock screen, the call screen or a notification while the app was not in front:
    // when it ends the phone goes back to where it was (lock screen, home, the other app), not to the chat list.
    private static volatile boolean returnAfterCall;
    // Captured when a call starts ringing: Android marks the app visible again before it delivers the Accept, so
    // whether the user was elsewhere has to be known from before.
    private static volatile boolean ringingWhileAway;

    // Logged decisions of the hand-back (when a call answered from elsewhere ends): `adb logcat -s CallReturn`.
    private static final String RETURN_TAG = "CallReturn";

    // Answered from the notification while the phone was in use (CallAnswerActivity): the app opened in the floating
    // call window. A voice call then tucks itself away once its service holds the microphone, so the person carries
    // on in their app; a video call stays in the floating window. Cleared once the person opens the call themselves.
    static final String EXTRA_QUIET_ANSWER = "hm_quiet_answer";
    private static volatile boolean quietAnswer;
    private static final long QUIET_HIDE_MS = 700;

    // Whether the screen is in the floating window, from Android's own callbacks (isInPictureInPictureMode() was
    // stale on the S23 after the floating task had been sent back).
    private static volatile boolean floating;

    /** The call's service now holds the microphone (it keeps working in the background): tuck a quiet voice call away. */
    static void callServiceReady() {
        if (!quietAnswer) return;
        handler.removeCallbacks(hideQuietCall);
        micSeenAt = 0;
        micWaits = 0;
        handler.postDelayed(hideQuietCall, QUIET_HIDE_MS);
    }

    // "Call started" only means answering began: the web view still has to open the microphone and send its answer,
    // which stalled when the screen left that early (S23: the caller never connected). It leaves once the app's own
    // microphone recording runs, plus a moment for the answer to go out; if the microphone never starts it stays.
    private static long micSeenAt;
    private static int micWaits;
    private static final long MIC_SETTLE_MS = 1500;
    private static final long MIC_POLL_MS = 250;
    private static final int MIC_MAX_WAITS = 40;

    private static boolean recordingNow(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return true;
        android.media.AudioManager audio = context.getSystemService(android.media.AudioManager.class);
        return audio != null && !audio.getActiveRecordingConfigurations().isEmpty();
    }

    private static final Runnable hideQuietCall = new Runnable() {
        @Override
        public void run() {
            AppActivity activity = current;
            if (!quietAnswer || activity == null || !MessagingService.isCallActive()) return;
            // A video call stays in the floating window (its camera needs a window on screen).
            if (MessagingService.isVideoCallActive()) { android.util.Log.i(RETURN_TAG, "quiet answer: video stays floating"); return; }
            if (!recordingNow(activity)) {
                if (++micWaits < MIC_MAX_WAITS) { handler.postDelayed(this, MIC_POLL_MS); return; }
                android.util.Log.i(RETURN_TAG, "quiet answer: the microphone never started, the call stays on screen");
                return;
            }
            long now = android.os.SystemClock.elapsedRealtime();
            if (micSeenAt == 0) { micSeenAt = now; handler.postDelayed(this, MIC_SETTLE_MS); return; }
            quietAnswer = false;
            boolean wasFloating = floating;
            boolean moved = activity.moveTaskToBack(!wasFloating);
            // Android does not always report leaving the floating window for a task sent back from it: note it here,
            // or the next quiet answer would think the screen is still floating (seen on the S23: it stayed full size).
            floating = false;
            android.util.Log.i(RETURN_TAG, "quiet answer: voice call tucked away (floating=" + wasFloating + " moved=" + moved + " mic for " + (now - micSeenAt) + " ms)");
        }
    };

    // A plain cover over a quietly answered call until its call screen is up: the web view's last picture (the chat
    // list) never shows. The page underneath stays visible to the web app, so nothing re-rings.
    private android.view.View answerCover;
    private long coveredAt;
    private static final long COVER_MIN_MS = 400;
    private static final long COVER_MAX_MS = 3000;

    private void coverUntilCallShows() {
        if (answerCover == null) {
            answerCover = new android.view.View(this);
            answerCover.setBackgroundColor(0xff0b1220);
            ((android.view.ViewGroup) getWindow().getDecorView()).addView(answerCover,
                new android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        }
        coveredAt = android.os.SystemClock.elapsedRealtime();
        handler.removeCallbacks(uncoverCheck);
        handler.postDelayed(uncoverCheck, COVER_MIN_MS);
    }

    private final Runnable uncoverCheck = new Runnable() {
        @Override
        public void run() {
            if (answerCover == null) return;
            long shown = android.os.SystemClock.elapsedRealtime() - coveredAt;
            if (!MessagingService.isCallActive() && shown < COVER_MAX_MS) { handler.postDelayed(this, 150); return; }
            ((android.view.ViewGroup) getWindow().getDecorView()).removeView(answerCover);
            answerCover = null;
            android.util.Log.i(RETURN_TAG, "quiet answer: call screen shown after " + shown + " ms");
        }
    };

    /** A call started ringing: remember whether the app was in front (unlocked) at that moment. */
    static void callRinging(Context context) {
        // A call in progress keeps its own decision: a second ring (a call waiting, a late repeat) must not clear it.
        if (MessagingService.isCallActive()) {
            android.util.Log.i(RETURN_TAG, "ring during a call: keep return=" + returnAfterCall);
            return;
        }
        // Just answered, not yet reported as a call: the ringing screen reporting in late (seen on the S23 ~0.8 s after
        // Answer) is the same call, and must not clear the way back.
        if (android.os.SystemClock.elapsedRealtime() - answeredAt < ANSWER_GRACE_MS) {
            android.util.Log.i(RETURN_TAG, "ring just after answering: keep return=" + returnAfterCall);
            return;
        }
        android.app.KeyguardManager keyguard = context.getSystemService(android.app.KeyguardManager.class);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        ringingWhileAway = !visible || locked;
        // A new call decides afresh: a hand-back left from an earlier call that never connected must not apply.
        returnAfterCall = false;
        android.util.Log.i(RETURN_TAG, "ringing: visible=" + visible + " locked=" + locked + " away=" + ringingWhileAway);
    }

    // An answer that does not become a call within this long (failed to connect) forgets its hand-back.
    private static final long ANSWER_TO_CALL_MS = 60_000;
    private static final Runnable forgetUnusedHandBack = () -> {
        if (!MessagingService.isCallActive()) returnAfterCall = false;
    };

    private static final long ANSWER_GRACE_MS = 10_000;
    private static volatile long answeredAt = -ANSWER_GRACE_MS;

    private static void armHandBack() {
        answeredAt = android.os.SystemClock.elapsedRealtime();
        returnAfterCall = ringingWhileAway;
        handler.removeCallbacks(forgetUnusedHandBack);
        if (returnAfterCall) handler.postDelayed(forgetUnusedHandBack, ANSWER_TO_CALL_MS);
        android.util.Log.i(RETURN_TAG, "answered from outside: return=" + returnAfterCall);
    }
    private static final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());

    /** Whether the app's screen is on show (the person sees new messages arrive in it). */
    static boolean isVisible() {
        return visible;
    }

    /** Whether the app's screen (and so its WebView connection) currently exists. */
    static boolean isAlive() {
        return alive;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // One writer at a time: a background page still running (BackgroundHost) finishes the message in hand and
        // stops before this screen's own code starts using the keys (which also waits for the page's lock).
        BackgroundHost.stopForApp();
        // Settings › Storage and data › Proxy: in effect before the web view makes its first request.
        AppProxy.apply(this);
        // An Answer that opened the app: noted before the bridge starts, because the plugin then takes the action off
        // the intent (that left a call answered from another app with no way back when the screen had to be recreated).
        noteAnsweredFromOutside(getIntent());
        // Local plugins must be registered before the bridge starts.
        registerPlugin(HiddenNativePlugin.class);
        TelecomCalls.register(this);
        // Firebase push: (re)register this phone's token; the result picks push mode or the always-on fallback.
        PushRegistration.ensure(this);
        alive = true;
        current = this;
        // The WebView takes over the connection; the service's own one would only duplicate notifications.
        NativeRelay.stop();
        // Over-the-air web updates: roll back an update that never confirmed it started, before the bridge picks
        // which copy of the web app to load (OtaUpdates).
        OtaUpdates.beforeBridge(this);
        super.onCreate(savedInstanceState);
        // Remember what the file chooser returns, so picked videos are read natively (PickedFiles).
        if (getBridge() != null) PickedFiles.install(getBridge());
        // Screen security (FLAG_SECURE) from the first frame, before the web app has loaded.
        AppSecurity.apply(this);
        // Opened by a ringing call's full-screen notification: show over the lock screen and light the screen at
        // once, before the web app has loaded (otherwise the call would wait behind the lock screen).
        if (getIntent() != null && getIntent().getBooleanExtra(Alerts.EXTRA_CALL, false)) applyCallWindow(true);
        // A fresh screen knows its window: opened straight into the floating window by a quiet answer, or full size.
        floating = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode();
        if (quietAnswer && getIntent() != null && getIntent().getBooleanExtra(EXTRA_QUIET_ANSWER, false)) coverUntilCallShows();
        // Back closes the top screen inside the app (chat → chat list, drawers, viewer…); with nothing left to close
        // the app goes to the background instead of being destroyed, like WhatsApp.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (!HiddenNativePlugin.emitBack()) leaveApp();
            }
        });
    }

    @Override
    public void onStart() {
        super.onStart();
        visible = true;
    }

    @Override
    public void onStop() {
        visible = false;
        super.onStop();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (quietAnswer) android.util.Log.i(RETURN_TAG, "quiet answer: resumed, floating=" + floating + " (Android says " + isInPictureInPictureMode() + ")");
        // Android brought the existing screen forward full size instead of into the floating window: float it now.
        if (quietAnswer && !floating) handler.post(() -> {
            if (quietAnswer && !floating && current == this) {
                boolean floated = enterFloatingWindow();
                android.util.Log.i(RETURN_TAG, "quiet answer: opened full size, floating=" + floated);
            }
        });
    }

    private boolean enterFloatingWindow() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            return enterPictureInPictureMode(pipParams(this, false));
        } catch (IllegalStateException unsupported) {
            return false;
        }
    }

    /** A touch on the full-size screen: the person is using the app, so a quiet answer no longer tucks it away. */
    @Override
    public void onUserInteraction() {
        super.onUserInteraction();
        if (quietAnswer && !floating) { quietAnswer = false; android.util.Log.i(RETURN_TAG, "quiet answer: the person is using the app"); }
    }

    /** Answered through Android (headset, car, watch): the same hand-back as an answer from the call screen. */
    static void answeredFromOutside() {
        armHandBack();
    }

    private void noteAnsweredFromOutside(Intent intent) {
        if (intent == null) return;
        // Opened from the launcher or recents during a call: the user wants the app, so it stays when the call ends
        // (as with WhatsApp, where opening the main app during a call keeps you there).
        if (Intent.ACTION_MAIN.equals(intent.getAction()) && intent.hasCategory(Intent.CATEGORY_LAUNCHER)) {
            if (returnAfterCall) android.util.Log.i(RETURN_TAG, "opened from the launcher: stay in the app after the call");
            returnAfterCall = false;
            quietAnswer = false;
            return;
        }
        if (!Alerts.ACTION_ACCEPT.equals(intent.getAction())) return;
        // Captured when it started ringing (with the app closed nothing was visible, so that counts too).
        armHandBack();
        quietAnswer = intent.getBooleanExtra(EXTRA_QUIET_ANSWER, false);
        if (quietAnswer) android.util.Log.i(RETURN_TAG, "quiet answer: floating until the call runs");
    }

    /** The call ended (still ended a moment later, so a voice/video switch does not count): step back if asked. */
    static void callEnded() {
        quietAnswer = false;
        handler.removeCallbacks(hideQuietCall);
        handler.removeCallbacks(handBack);
        handler.removeCallbacks(forgetUnusedHandBack);
        handBackTries = 0;
        android.util.Log.i(RETURN_TAG, "call ended: return=" + returnAfterCall);
        handler.postDelayed(handBack, HAND_BACK_MS);
    }

    // How long "Call ended" shows before the phone goes back, and how long the hand-back waits for the call to be
    // reported finished (a voice/video switch, a call still marked ringing) before it gives up.
    private static final long HAND_BACK_MS = 1200;
    private static final long HAND_BACK_RETRY_MS = 500;
    private static final int HAND_BACK_TRIES = 8;
    private static int handBackTries;

    private static final Runnable handBack = new Runnable() {
        @Override
        public void run() {
            AppActivity activity = current;
            if (!returnAfterCall) { android.util.Log.i(RETURN_TAG, "stay: the call was answered in the app"); return; }
            if (activity == null) { returnAfterCall = false; android.util.Log.i(RETURN_TAG, "stay: no app screen"); return; }
            if (MessagingService.isCallActive() || Alerts.isRinging()) {
                // Not finished yet: look again shortly rather than leaving the person in the app for good.
                if (++handBackTries < HAND_BACK_TRIES) {
                    android.util.Log.i(RETURN_TAG, "waiting: active=" + MessagingService.isCallActive() + " ringing=" + Alerts.isRinging());
                    handler.postDelayed(this, HAND_BACK_RETRY_MS);
                } else {
                    returnAfterCall = false;
                    android.util.Log.i(RETURN_TAG, "stay: a call is still on");
                }
                return;
            }
            returnAfterCall = false;
            boolean moved = activity.moveTaskToBack(true);
            android.util.Log.i(RETURN_TAG, "back to where the person was: moved=" + moved);
        }
    };

    @Override
    protected void onNewIntent(Intent intent) {
        noteAnsweredFromOutside(intent);
        if (intent != null && intent.getBooleanExtra(Alerts.EXTRA_CALL, false)) applyCallWindow(true);
        super.onNewIntent(intent);
        // Before the screen shows again: cover the web view's last picture until the call screen is up.
        if (quietAnswer && intent != null && intent.getBooleanExtra(EXTRA_QUIET_ANSWER, false)) coverUntilCallShows();
    }

    /** While a call rings or is in progress the call screen shows over the lock screen, like the phone app. */
    static boolean wantsCallWindow() {
        return Alerts.isRinging() || MessagingService.isCallActive();
    }

    /** Ringing started/stopped or a call started/ended: update the lock-screen and keep-screen-on flags. */
    static void callWindowChanged() {
        AppActivity activity = current;
        if (activity != null) activity.runOnUiThread(() -> activity.applyCallWindow(wantsCallWindow()));
    }

    void applyCallWindow(boolean overLock) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(overLock);
            setTurnScreenOn(overLock);
        } else if (overLock) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        // The screen stays on while a call rings and during video calls (voice calls use the proximity sensor).
        if (overLock && (Alerts.isRinging() || MessagingService.isVideoCallActive())) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    static PictureInPictureParams pipParams(Context context, boolean autoEnter) {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(new Rational(9, 16));
        // A Hang up button in the floating window, like WhatsApp; it ends the call through the web app.
        Intent hangUp = new Intent(context, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_HANGUP);
        PendingIntent hangUpIntent = PendingIntent.getBroadcast(context, 4, hangUp, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        builder.setActions(Collections.singletonList(new RemoteAction(
            Icon.createWithResource(context, android.R.drawable.ic_menu_close_clear_cancel), "Hang up", "End the call", hangUpIntent)));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(autoEnter).setSeamlessResizeEnabled(true);
        return builder.build();
    }

    /** A video call started or ended: Android 12+ then enters picture-in-picture by itself on Home / app switch. */
    static void videoCallChanged(boolean active) {
        AppActivity activity = current;
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        activity.runOnUiThread(() -> {
            try { activity.setPictureInPictureParams(pipParams(activity, active)); } catch (IllegalStateException ignored) { }
            // The call ended while it was in the floating window: close the window, like WhatsApp.
            if (!active && (floating || activity.isInPictureInPictureMode())) { activity.moveTaskToBack(false); floating = false; }
        });
    }

    /**
     * Leaving the app with Back (or the web app's "go to background"): during a video call the call keeps playing in
     * the floating window, exactly as with Home; otherwise the app just goes to the background.
     */
    void leaveApp() {
        if (!enterCallPictureInPicture()) moveTaskToBack(true);
    }

    /** Puts a video call into the floating window; false when there is no video call or the phone does not allow it. */
    boolean enterCallPictureInPicture() {
        if (!MessagingService.isVideoCallActive() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        if (floating) return true;
        try {
            return enterPictureInPictureMode(pipParams(this, false));
        } catch (IllegalStateException unsupported) {
            return false;
        }
    }

    /** Home / app switch during a video call (Android 8–11): keep the call on screen in a picture-in-picture window. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Android 12+ enters by itself (auto-enter), but several phone makers ignore that; asking here as well works
        // everywhere, and does nothing when the window is already on its way.
        // When the device or the user's settings do not allow picture-in-picture the call continues in the background.
        enterCallPictureInPicture();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean active, Configuration newConfig) {
        super.onPictureInPictureModeChanged(active, newConfig);
        boolean wasFloating = floating;
        floating = active;
        if (quietAnswer) android.util.Log.i(RETURN_TAG, "quiet answer: floating window " + (active ? "on" : "off"));
        // Opened from the floating window to full size during the call: the person wants the app, it stays. (A late
        // "off" for a window already sent back is not that: it was no longer counted as floating.)
        if (!active && wasFloating && quietAnswer) { quietAnswer = false; android.util.Log.i(RETURN_TAG, "quiet answer: opened to full size"); }
        HiddenNativePlugin.emitPictureInPicture(active);
    }

    @Override
    public void onDestroy() {
        // Only the current screen going away means there is none: an older instance finishing after a newer one opened
        // (a call answered into a new window) must not report the app screenless, which made the call watchdog end it.
        if (current == this) {
            current = null;
            alive = false;
        }
        // Screen gone (swiped away) but the service still runs: keep the phone reachable.
        if (!isChangingConfigurations() && MessagingService.isRunning() && MessagingService.isLegacy(this)) NativeRelay.start(this);
        // The call lived in this screen's WebView: without it there is no call any more.
        if (!isChangingConfigurations()) MessagingService.endOrphanedCall(this, "screen closed");
        super.onDestroy();
    }
}
