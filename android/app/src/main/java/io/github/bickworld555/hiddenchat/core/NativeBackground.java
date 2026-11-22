package io.github.bickworld555.hiddenchat.core;

import android.content.Context;
import android.content.SharedPreferences;

import io.github.bickworld555.hiddenchat.core.crypto.CryptoCores;
import io.github.bickworld555.hiddenchat.core.crypto.HmCryptoCore;
import io.github.bickworld555.hiddenchat.core.crypto.SecureRng;
import io.github.bickworld555.hiddenchat.core.store.NativeStore;

/**
 * The seam that turns on the native end-to-end path (decrypt-on-push in Kotlin instead of the hidden WebView page).
 *
 * The flag is scoped to a single account id, not a global on/off: the native path activates only when the named
 * account is the one signed in (the strict check is NativeFlag in the app package, which can read the session). This
 * is what makes throwaway-account verification safe on a device that also holds a real account — the real account,
 * being a different id, always uses the unchanged WebView path. Off by default (no account named).
 *
 * Enabling it for an account makes the native store the key owner for that account: HmCryptoCore generates a fresh
 * device identity and NativeRegistration re-registers it ("security code changed" to its contacts). Not wired into
 * app startup directly; the app calls {@link #install(Context)} only when NativeFlag says the named account is active.
 */
public final class NativeBackground {
    private static final String PREFS = "hm-native";
    private static final String ENABLED_FOR = "enabled-for";

    private NativeBackground() {}

    /** The account id the native path is enabled for, or null (off). */
    public static String enabledForAccount(Context context) {
        return prefs(context).getString(ENABLED_FOR, null);
    }

    /** Names the account the native path is for (a test/rollout driver sets this); null or empty turns it off. */
    public static void setEnabledForAccount(Context context, String userId) {
        SharedPreferences.Editor editor = prefs(context).edit();
        if (userId == null || userId.isEmpty()) editor.remove(ENABLED_FOR);
        else editor.putString(ENABLED_FOR, userId);
        editor.apply();
    }

    /**
     * Installs the native CryptoCore over NativeStore when the flag names an account and the Keystore-backed store is
     * usable. Returns true when the native core is now active. The strict "is this the signed-in account" check is
     * NativeFlag (app package); callers gate with it before using the core.
     */
    public static boolean install(Context context) {
        if (enabledForAccount(context) == null) return false;
        NativeStore store = NativeStore.Companion.get(context);
        if (store == null) return false;
        CryptoCores.INSTANCE.install(new HmCryptoCore(store, SecureRng.INSTANCE));
        return true;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
