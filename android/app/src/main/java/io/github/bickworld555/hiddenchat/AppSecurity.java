package io.github.bickworld555.hiddenchat;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.view.WindowManager;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

/**
 * App lock and screen security, like WhatsApp's fingerprint lock:
 *  • unlock with the phone's own biometrics (fingerprint / face) or its screen-lock PIN, pattern or password;
 *  • screen security sets FLAG_SECURE, which blocks screenshots and screen recording and blanks the app in the
 *    recent-apps list. The choice is kept here so it applies from the first frame, before the web app loads.
 */
final class AppSecurity {
    private static final String PREFS = "hm-security";
    private static final String SECURE_SCREEN = "secure_screen";
    // Weak biometrics or the device credential: accepted on every Android version this app supports (24+).
    static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private AppSecurity() {}

    interface Result {
        void done(boolean ok, String error);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean secureScreen(Context context) {
        return prefs(context).getBoolean(SECURE_SCREEN, false);
    }

    static void setSecureScreen(Activity activity, boolean enabled) {
        prefs(activity).edit().putBoolean(SECURE_SCREEN, enabled).apply();
        activity.runOnUiThread(() -> apply(activity));
    }

    /** Applies the saved choice to the activity's window (called from MainActivity.onCreate too). */
    static void apply(Activity activity) {
        if (secureScreen(activity)) activity.getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    /** "available", "none" (no screen lock or biometrics set up) or "unsupported". */
    static String status(Context context) {
        int result = BiometricManager.from(context).canAuthenticate(AUTHENTICATORS);
        if (result == BiometricManager.BIOMETRIC_SUCCESS) return "available";
        if (result == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) return "none";
        return "unsupported";
    }

    static void authenticate(Activity activity, String title, String subtitle, Result result) {
        if (!(activity instanceof FragmentActivity)) {
            result.done(false, "Unlock is not available here.");
            return;
        }
        FragmentActivity host = (FragmentActivity) activity;
        host.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(host, ContextCompat.getMainExecutor(host), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult authenticationResult) {
                    result.done(true, null);
                }

                @Override
                public void onAuthenticationError(int code, CharSequence message) {
                    result.done(false, message == null ? "Not unlocked." : message.toString());
                }
                // onAuthenticationFailed: one unrecognised finger; the prompt stays open for another try.
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title == null || title.isEmpty() ? "Unlock Hidden Messenger" : title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
            prompt.authenticate(info);
        });
    }
}
