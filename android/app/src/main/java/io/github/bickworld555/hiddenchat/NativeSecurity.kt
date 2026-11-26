package io.github.bickworld555.hiddenchat

import android.app.Activity
import android.content.Context

/**
 * A public bridge from the native Compose UI (io.github.bickworld555.hiddenchat.ui) to [AppSecurity], whose methods
 * are package-private. Phase 1 native-shell work: the native Settings and Unlock screens drive the same
 * biometric / secure-screen path the WebView already uses, without widening AppSecurity's own surface.
 *
 * The "native app lock" is a separate, native-UI-only switch (hm_native_ui/app_lock, default off). When on, the
 * native UI asks for a biometric / device-credential unlock before it shows any chats. It does NOT touch the web
 * app's own app lock or any crypto flag — it only gates the native UI entry.
 */
object NativeSecurity {
    private const val PREFS = "hm_native_ui"
    private const val APP_LOCK = "app_lock"

    /** FLAG_SECURE: blocks screenshots / screen recording and blanks the app in recents (shared with the WebView). */
    fun secureScreenOn(context: Context): Boolean = AppSecurity.secureScreen(context)
    fun setSecureScreen(activity: Activity, enabled: Boolean) {
        AppSecurity.setSecureScreen(activity, enabled)
    }

    /** "available", "none" (no biometrics / screen lock set up) or "unsupported". */
    fun unlockStatus(context: Context): String = AppSecurity.status(context)

    fun appLockOn(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(APP_LOCK, false)

    fun setAppLock(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(APP_LOCK, enabled).apply()
    }

    /** Prompts the phone's biometrics / device credential; [onDone] is called with (true, null) on success. */
    fun authenticate(activity: Activity, title: String, subtitle: String, onDone: (Boolean, String?) -> Unit) {
        AppSecurity.authenticate(activity, title, subtitle) { ok, error -> onDone(ok, error) }
    }
}
