package io.github.bickworld555.hiddenchat;

import android.net.Uri;

/**
 * The sound one kind of alert uses, as handed over by the web app: "" = Hidden Messenger's own tone,
 * "default" = this phone's default sound, or a content:// URI from the phone's sound list (RingtoneManager).
 * Anything else is treated as the app's own tone.
 */
final class SoundChoice {
    static final String PHONE_DEFAULT = "default";
    private static final int MAX_LENGTH = 1024;

    private SoundChoice() {}

    static String parse(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_LENGTH) return "";
        if (PHONE_DEFAULT.equals(value)) return PHONE_DEFAULT;
        Uri uri = Uri.parse(value);
        return "content".equals(uri.getScheme()) && uri.getAuthority() != null ? value : "";
    }
}
