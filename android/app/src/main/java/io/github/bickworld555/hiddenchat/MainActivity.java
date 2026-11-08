package io.github.bickworld555.hiddenchat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static volatile boolean alive;

    /** Whether the app's screen (and so its WebView connection) currently exists. */
    static boolean isAlive() {
        return alive;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(HiddenNativePlugin.class);
        alive = true;
        // The WebView takes over the connection; the service's own one would only duplicate notifications.
        NativeRelay.stop();
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onDestroy() {
        alive = false;
        // Screen gone (swiped away or closed with Back) but the service still runs: keep the phone reachable.
        if (!isChangingConfigurations() && MessagingService.isRunning()) NativeRelay.start(this);
        super.onDestroy();
    }
}
