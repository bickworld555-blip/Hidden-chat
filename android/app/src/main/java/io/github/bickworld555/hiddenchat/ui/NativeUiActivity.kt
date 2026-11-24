package io.github.bickworld555.hiddenchat.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import io.github.bickworld555.hiddenchat.ui.theme.HiddenTheme

/**
 * The entry point for the native (Compose) UI — Step 5 foundation. Hosts the native chat list. Registered in the
 * manifest but exported=false with no launcher intent, so it is reachable only for a device test
 * (`adb shell am start -n <pkg>/.ui.NativeUiActivity`); the app still launches straight into the WebView. This is the
 * seam the native UI grows from, kept off the default path so the live app is unaffected.
 */
class NativeUiActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            HiddenTheme {
                ChatListScreen()
            }
        }
    }
}
