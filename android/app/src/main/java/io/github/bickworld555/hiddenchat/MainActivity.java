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
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import java.util.Collections;

public class MainActivity extends BridgeActivity {
    private static volatile boolean alive;
    private static MainActivity current;

    /** Whether the app's screen (and so its WebView connection) currently exists. */
    static boolean isAlive() {
        return alive;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(HiddenNativePlugin.class);
        alive = true;
        current = this;
        // The WebView takes over the connection; the service's own one would only duplicate notifications.
        NativeRelay.stop();
        super.onCreate(savedInstanceState);
        // Back closes the top screen inside the app (chat → chat list, drawers, viewer…); with nothing left to close
        // the app goes to the background instead of being destroyed, like WhatsApp.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (!HiddenNativePlugin.emitBack()) moveTaskToBack(true);
            }
        });
    }

    private static PictureInPictureParams pipParams(Context context, boolean autoEnter) {
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
        MainActivity activity = current;
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        activity.runOnUiThread(() -> {
            try { activity.setPictureInPictureParams(pipParams(activity, active)); } catch (IllegalStateException ignored) { }
            // The call ended while it was in the floating window: close the window, like WhatsApp.
            if (!active && activity.isInPictureInPictureMode()) activity.moveTaskToBack(false);
        });
    }

    /** Home / app switch during a video call (Android 8–11): keep the call on screen in a picture-in-picture window. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (MessagingService.isVideoCallActive() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            try {
                enterPictureInPictureMode(pipParams(this, false));
            } catch (IllegalStateException unsupported) {
                // The device or the user's settings do not allow picture-in-picture; the call continues in the background.
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean active, Configuration newConfig) {
        super.onPictureInPictureModeChanged(active, newConfig);
        HiddenNativePlugin.emitPictureInPicture(active);
    }

    @Override
    public void onDestroy() {
        alive = false;
        if (current == this) current = null;
        // Screen gone (swiped away) but the service still runs: keep the phone reachable.
        if (!isChangingConfigurations() && MessagingService.isRunning()) NativeRelay.start(this);
        super.onDestroy();
    }
}
