package io.github.bickworld555.hiddenchat;

import android.content.Context;

import io.github.bickworld555.hiddenchat.core.NativeBackground;

/**
 * Whether the native end-to-end path is active right now: the flag must name an account (NativeBackground) AND that
 * account must be the one signed in (RelaySession). In the app package because it reads the session. This is the one
 * gate every native-path entry point uses, so the native path can never touch an account it was not enabled for —
 * the real account, being a different id, always falls through to the WebView path.
 */
final class NativeFlag {
    private NativeFlag() {}

    static boolean active(Context context) {
        String forUser = NativeBackground.enabledForAccount(context);
        if (forUser == null) return false;
        RelaySession session = RelaySession.read(context);
        return session != null && forUser.equals(session.userId);
    }
}
