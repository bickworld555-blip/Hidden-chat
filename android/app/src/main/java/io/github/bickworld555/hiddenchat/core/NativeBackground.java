package io.github.bickworld555.hiddenchat.core;

import android.content.Context;
import android.content.SharedPreferences;

import io.github.bickworld555.hiddenchat.core.crypto.CryptoCores;
import io.github.bickworld555.hiddenchat.core.crypto.HmCryptoCore;
import io.github.bickworld555.hiddenchat.core.store.NativeStore;

/**
 * The seam that turns on the native end-to-end path (decrypt-on-push in Kotlin instead of the hidden WebView page).
 * Off by default: until the flag is set and the native path is verified on a device, nothing here runs and the
 * WebView background page (HeadlessRunner) stays the live path, so fdd5962 behaviour is unchanged.
 *
 * Enabling this makes the native store the key owner: HmCryptoCore generates a fresh device identity in NativeStore
 * and (a later step) publishes its prekeys, so the device re-registers and contacts see a one-time "security code
 * changed" — the chosen migration. Not wired into app startup yet; a caller invokes {@link #install(Context)} only
 * once the native fetch path exists.
 */
public final class NativeBackground {
    private static final String PREFS = "hm-native";
    private static final String ENABLED = "enabled";

    private NativeBackground() {}

    /** Whether the native end-to-end path is turned on (default false). */
    public static boolean enabled(Context context) {
        return prefs(context).getBoolean(ENABLED, false);
    }

    /** Turns the native path on or off for this device (a later Settings toggle / staged rollout drives this). */
    public static void setEnabled(Context context, boolean on) {
        prefs(context).edit().putBoolean(ENABLED, on).apply();
    }

    /**
     * Installs the native CryptoCore over NativeStore when the flag is on and the Keystore-backed store is usable.
     * Returns true when the native core is now active. A no-op (false) when the flag is off, so it is safe to call
     * unconditionally at startup.
     */
    public static boolean install(Context context) {
        if (!enabled(context)) return false;
        NativeStore store = NativeStore.Companion.get(context);
        if (store == null) return false;
        CryptoCores.INSTANCE.install(new HmCryptoCore(store, io.github.bickworld555.hiddenchat.core.crypto.SecureRng.INSTANCE));
        return true;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
