package io.github.bickworld555.hiddenchat;
import io.github.bickworld555.hiddenchat.core.NativeBackground;

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

    // Answered from the notification while the phone was in use (CallAnswerActivity): the call screen opens full size,
    // like a phone app's in-call screen. Until the web app has drawn it, a native "Connecting…" cover with the caller's
    // name stands in, so the web view's last picture (the chat list) never shows. Hang-up then hands back (handBack).
    static final String EXTRA_ANSWERED_AWAY = "hm_answered_away";
    static final String EXTRA_CALLER_NAME = "hm_caller_name";

    // Whether the screen is in the floating window, from Android's own callbacks (isInPictureInPictureMode() was
    // stale on the S23 after the floating task had been sent back).
    private static volatile boolean floating;

    private android.view.View answerCover;
    private long coveredAt;
    // The cover leaves as soon as the web app reports the call live (it has drawn the call screen by then); the 400 ms
    // minimum used before held the call screen back ~0.3 s longer than WhatsApp Business takes (S23, 2026-11-21).
    private static final long COVER_MIN_MS = 120;
    private static final long COVER_MAX_MS = 5000;
    private static final long COVER_FADE_MS = 120;

    /** The call screen's stand-in while the web view wakes: dark, the caller's name, "Connecting…". */
    private void coverUntilCallShows(String name, String callId) {
        if (answerCover == null) {
            android.widget.LinearLayout column = new android.widget.LinearLayout(this);
            column.setOrientation(android.widget.LinearLayout.VERTICAL);
            column.setGravity(android.view.Gravity.CENTER);
            column.setBackgroundColor(0xff0b1220);
            android.widget.TextView title = new android.widget.TextView(this);
            title.setText(name == null || name.trim().isEmpty() ? "Hidden Messenger" : name.trim());
            title.setTextColor(0xffffffff);
            title.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 26);
            title.setSingleLine(true);
            title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            title.setGravity(android.view.Gravity.CENTER);
            int pad = Math.round(24 * getResources().getDisplayMetrics().density);
            title.setPadding(pad, 0, pad, 0);
            android.widget.TextView state = new android.widget.TextView(this);
            state.setText("Connecting…");
            state.setTextColor(0x99ffffff);
            state.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 16);
            state.setGravity(android.view.Gravity.CENTER);
            state.setPadding(0, pad / 3, 0, 0);
            column.addView(title);
            column.addView(state);
            // Hang up works from the first frame, even while the web call screen is still loading (a cold start after
            // an update took 2.4 s on the S23): the call ends on the server and here, as the floating window's button does.
            android.widget.TextView end = new android.widget.TextView(this);
            end.setText("End");
            end.setTextColor(0xffffffff);
            end.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 16);
            end.setGravity(android.view.Gravity.CENTER);
            android.graphics.drawable.GradientDrawable red = new android.graphics.drawable.GradientDrawable();
            red.setShape(android.graphics.drawable.GradientDrawable.OVAL);
            red.setColor(0xffd85d56);
            end.setBackground(red);
            end.setContentDescription("End call");
            int size = Math.round(68 * getResources().getDisplayMetrics().density);
            android.widget.LinearLayout.LayoutParams endParams = new android.widget.LinearLayout.LayoutParams(size, size);
            endParams.topMargin = pad * 3;
            final String endCallId = callId;
            end.setOnClickListener((view) -> {
                Context app = getApplicationContext();
                if (endCallId != null && !endCallId.isEmpty()) CallActionReceiver.endOnServer(app, endCallId, "hang-up");
                CallActionReceiver.hangUp(app);
            });
            column.addView(end, endParams);
            answerCover = column;
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
            android.view.View cover = answerCover;
            if (cover == null) return;
            long shown = android.os.SystemClock.elapsedRealtime() - coveredAt;
            if (!MessagingService.isCallActive() && shown < COVER_MAX_MS) { handler.postDelayed(this, 50); return; }
            answerCover = null;
            // A short fade into the call screen instead of a cut.
            cover.animate().alpha(0f).setDuration(COVER_FADE_MS).withEndAction(() -> {
                android.view.ViewParent parent = cover.getParent();
                if (parent instanceof android.view.ViewGroup) ((android.view.ViewGroup) parent).removeView(cover);
            }).start();
            android.util.Log.i(RETURN_TAG, "answered away: call screen shown after " + shown + " ms");
        }
    };

    /** Answered from the notification while away: cover the web view's last picture until the call screen is up. */
    private void coverIfAnsweredAway(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_ANSWERED_AWAY, false)) return;
        // Once only: a later recreation of this screen (rotation, theme) must not cover a call already on show.
        intent.removeExtra(EXTRA_ANSWERED_AWAY);
        coverUntilCallShows(intent.getStringExtra(EXTRA_CALLER_NAME), intent.getStringExtra(Alerts.EXTRA_CALL_ID));
    }

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
        // The saved picture of the chat list (LaunchSnapshot) is read while the bridge and web view start.
        LaunchSnapshot.preload(this);
        super.onCreate(savedInstanceState);
        // Remember what the file chooser returns, so picked videos are read natively (PickedFiles).
        if (getBridge() != null) PickedFiles.install(getBridge());
        // Screen security (FLAG_SECURE) from the first frame, before the web app has loaded.
        AppSecurity.apply(this);
        // The native end-to-end core, so the foreground web app routes its crypto through it (bridge). Only for the
        // account the flag names; the real account (a different id) keeps its own WebView protocol.
        if (NativeFlag.active(this)) NativeBackground.install(this);
        // Started from the app icon: the chat list as it was last left, until the live one has drawn.
        LaunchSnapshot.attach(this);
        // Opened by a ringing call's full-screen notification: show over the lock screen and light the screen at
        // once, before the web app has loaded (otherwise the call would wait behind the lock screen).
        if (getIntent() != null && getIntent().getBooleanExtra(Alerts.EXTRA_CALL, false)) applyCallWindow(true);
        // A fresh screen knows its window: opened straight into the floating window by a quiet answer, or full size.
        floating = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode();
        coverIfAnsweredAway(getIntent());
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
    public void onPause() {
        // Leaving with the plain chat list on show: its picture is kept (encrypted) for the next cold start.
        LaunchSnapshot.capture(this);
        super.onPause();
    }

    @Override
    public void onStop() {
        visible = false;
        super.onStop();
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
            return;
        }
        if (!Alerts.ACTION_ACCEPT.equals(intent.getAction())) return;
        // Captured when it started ringing (with the app closed nothing was visible, so that counts too).
        armHandBack();
    }

    /** The call ended (still ended a moment later, so a voice/video switch does not count): step back if asked. */
    static void callEnded() {
        handler.removeCallbacks(handBack);
        handler.removeCallbacks(forgetUnusedHandBack);
        handBackTries = 0;
        android.util.Log.i(RETURN_TAG, "call ended: return=" + returnAfterCall);
        handler.postDelayed(handBack, HAND_BACK_MS);
    }

    // How soon the phone goes back after the call ends, and how long the hand-back waits for the call to be reported
    // finished (a call still marked ringing) before it gives up. A voice/video switch reports "ended" and "started" in
    // the same web-app tick, so a short first wait is enough to tell it apart; the 1.2 s wait used before left the
    // person on our "Call ended" screen ten times longer than WhatsApp Business takes to return (S23, 2026-11-21).
    private static final long HAND_BACK_MS = 200;
    private static final long HAND_BACK_RETRY_MS = 250;
    private static final int HAND_BACK_TRIES = 16;
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
        coverIfAnsweredAway(intent);
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
        // Closing the floating window keeps the call, like WhatsApp Business: Android's own close removes the whole
        // screen, and the call lives in this screen's WebView, so the call ended with it. Our close action only puts the
        // window away (hideFloatingWindow); the call goes on and its notification brings the call screen back.
        if (Build.VERSION.SDK_INT >= 33) {
            Intent hide = new Intent(context, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_HIDE_WINDOW);
            PendingIntent hideIntent = PendingIntent.getBroadcast(context, 5, hide, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            builder.setCloseAction(new RemoteAction(
                Icon.createWithResource(context, android.R.drawable.ic_menu_close_clear_cancel), "Close", "Hide the call window", hideIntent));
        }
        return builder.build();
    }

    /** The floating window's close button: the window goes to the background with the call still running. */
    static void hideFloatingWindow() {
        AppActivity activity = current;
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !(floating || activity.isInPictureInPictureMode())) return;
            boolean moved = activity.moveTaskToBack(true);
            floating = false;
            android.util.Log.i(RETURN_TAG, "floating window closed, call kept: moved=" + moved);
        });
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
        floating = active;
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
        // The cold-start picture lives in this screen's window.
        LaunchSnapshot.detach(this);
        // Screen gone (swiped away) but the service still runs: keep the phone reachable.
        if (!isChangingConfigurations() && MessagingService.isRunning() && MessagingService.isLegacy(this)) NativeRelay.start(this);
        // The call lived in this screen's WebView: without it there is no call any more.
        if (!isChangingConfigurations()) MessagingService.endOrphanedCall(this, "screen closed");
        super.onDestroy();
    }
}
