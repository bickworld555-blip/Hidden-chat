package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * The signed-in account the background connection uses, handed over by the web app (HiddenNative.setSession)
 * and kept in the app's private storage — the same token the WebView already keeps in its own storage.
 * Muted chats and groups travel with it so a closed app stays as quiet as an open one.
 */
final class RelaySession {
    private static final String PREFS = "hidden_relay_session";

    final String origin;
    final String token;
    final String userId;
    final Set<String> mutedChats;
    final Set<String> mutedGroups;
    // The sound for each kind of alert, as a SoundChoice: "" (the app's tone), "default" (the phone's) or a phone sound URI.
    final String messageSound;
    final String groupSound;
    final String ringtoneSound;

    private RelaySession(String origin, String token, String userId, Set<String> mutedChats, Set<String> mutedGroups,
                         String messageSound, String groupSound, String ringtoneSound) {
        this.origin = origin;
        this.token = token;
        this.userId = userId;
        this.mutedChats = mutedChats;
        this.mutedGroups = mutedGroups;
        this.messageSound = messageSound;
        this.groupSound = groupSound;
        this.ringtoneSound = ringtoneSound;
    }

    /** Only an https origin (or http on a local test server) with a token and a user id is accepted. */
    static boolean save(Context context, String origin, String token, String userId, Set<String> mutedChats, Set<String> mutedGroups) {
        return save(context, origin, token, userId, mutedChats, mutedGroups, "", "", "");
    }

    static boolean save(Context context, String origin, String token, String userId, Set<String> mutedChats, Set<String> mutedGroups,
                        String messageSound, String groupSound, String ringtoneSound) {
        if (origin == null || token == null || userId == null || token.isEmpty() || userId.isEmpty()) return false;
        Uri uri = Uri.parse(origin);
        String scheme = uri.getScheme();
        if (uri.getHost() == null || !("https".equals(scheme) || "http".equals(scheme))) return false;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("origin", scheme + "://" + uri.getAuthority())
            // The session token is sealed with the Android Keystore (SecureStore): unreadable if the files are copied.
            .putString("token", SecureStore.sealOrKeep(token))
            .putString("userId", userId)
            .putStringSet("mutedChats", mutedChats == null ? Collections.emptySet() : new HashSet<>(mutedChats))
            .putStringSet("mutedGroups", mutedGroups == null ? Collections.emptySet() : new HashSet<>(mutedGroups))
            .putString("messageSound", SoundChoice.parse(messageSound))
            .putString("groupSound", SoundChoice.parse(groupSound))
            .putString("ringtoneSound", SoundChoice.parse(ringtoneSound))
            .remove("phoneMessageSound").remove("phoneGroupSound").remove("phoneRingtone")
            .apply();
        return true;
    }

    static RelaySession read(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String origin = prefs.getString("origin", null);
        String stored = prefs.getString("token", null);
        String token = SecureStore.openOrNull(stored);
        String userId = prefs.getString("userId", null);
        if (origin == null || token == null || userId == null) return null;
        // Saved by an older version in the clear: seal it now.
        if (!SecureStore.isSealed(stored)) {
            String sealed = SecureStore.sealOrKeep(token);
            if (SecureStore.isSealed(sealed)) prefs.edit().putString("token", sealed).apply();
        }
        return new RelaySession(origin, token, userId,
            new HashSet<>(prefs.getStringSet("mutedChats", Collections.emptySet())),
            new HashSet<>(prefs.getStringSet("mutedGroups", Collections.emptySet())),
            storedSound(prefs, "messageSound", "phoneMessageSound"), storedSound(prefs, "groupSound", "phoneGroupSound"),
            storedSound(prefs, "ringtoneSound", "phoneRingtone"));
    }

    /** Older versions kept only "phone default or not", as a boolean under `legacyKey`. */
    private static String storedSound(SharedPreferences prefs, String key, String legacyKey) {
        if (prefs.contains(key)) return SoundChoice.parse(prefs.getString(key, ""));
        return prefs.getBoolean(legacyKey, false) ? SoundChoice.PHONE_DEFAULT : "";
    }

    static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    String websocketUrl() {
        return (origin.startsWith("https://") ? "wss://" + origin.substring(8) : "ws://" + origin.substring(7)) + "/ws";
    }
}
