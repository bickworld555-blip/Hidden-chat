package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Firebase push for this phone, like WhatsApp: the FCM token is registered with our server together with a key
 * this phone made, so push bodies are encrypted end to end (server to phone; Google only relays them).
 *
 * "Push mode" is on only when Firebase is configured in this build (google-services.json), the token is
 * registered for the signed-in account, and the server answered that it sends pushes. Until then the app keeps
 * its always-on background connection, so nothing is ever missed while push is being set up.
 */
final class PushRegistration {
    private static final String TAG = "PushRegistration";
    private static final String PREFS = "hidden_push";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final ExecutorService io = Executors.newSingleThreadExecutor();
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build();

    private PushRegistration() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Firebase is part of this build (the google-services plugin ran with a google-services.json). */
    static boolean available(Context context) {
        try {
            return !FirebaseApp.getApps(context).isEmpty() || FirebaseApp.initializeApp(context) != null;
        } catch (RuntimeException notConfigured) {
            return false;
        }
    }

    /** Push carries messages and calls for the signed-in account: the always-on connection is not needed. */
    static boolean isActive(Context context) {
        RelaySession session = RelaySession.read(context);
        if (session == null) return false;
        SharedPreferences prefs = prefs(context);
        return prefs.getBoolean("active", false) && session.userId.equals(prefs.getString("userId", null));
    }

    /** This phone's payload key (32 random bytes), made once and kept in the app's private storage. */
    static synchronized String deviceKey(Context context) {
        SharedPreferences prefs = prefs(context);
        String key = prefs.getString("key", null);
        if (key == null) {
            byte[] bytes = new byte[32];
            new SecureRandom().nextBytes(bytes);
            key = Base64.encodeToString(bytes, Base64.NO_WRAP);
            prefs.edit().putString("key", key).apply();
        }
        return key;
    }

    /** Signed in, or the app came to the front: (re)register the current token, then pick the background mode. */
    static void ensure(Context context) {
        Context app = context.getApplicationContext();
        if (RelaySession.read(app) == null) return;
        if (!available(app)) {
            setActive(app, false, null);
            return;
        }
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) register(app, task.getResult());
                else {
                    Log.w(TAG, "no FCM token", task.getException());
                    setActive(app, false, null);
                }
            });
        } catch (RuntimeException unavailable) {
            Log.w(TAG, "Firebase Messaging unavailable", unavailable);
            setActive(app, false, null);
        }
    }

    /** New or refreshed token (also from PushService.onNewToken): tell the server. */
    static void register(Context context, String token) {
        Context app = context.getApplicationContext();
        io.execute(() -> {
            RelaySession session = RelaySession.read(app);
            if (session == null || token == null || token.isEmpty()) return;
            try {
                JSONObject body = new JSONObject().put("token", token).put("key", deviceKey(app)).put("platform", "android");
                Request request = new Request.Builder()
                    .url(session.origin + "/api/v1/push/devices")
                    .header("Authorization", "Bearer " + session.token)
                    .post(RequestBody.create(body.toString(), JSON))
                    .build();
                try (Response response = http.newCall(request).execute()) {
                    if (response.isSuccessful() && response.body() != null) {
                        boolean push = new JSONObject(response.body().string()).optBoolean("push", false);
                        prefs(app).edit().putString("token", token).apply();
                        setActive(app, push, session.userId);
                    } else if (response.code() == 404 || response.code() == 401) {
                        // An older server without push, or the session is gone: stay on the always-on connection.
                        setActive(app, false, null);
                    }
                    // Other errors: keep the mode we had; the next start or token refresh tries again.
                }
            } catch (Exception offline) {
                Log.w(TAG, "push registration postponed: " + offline.getMessage());
            }
        });
    }

    /** Signing out: the server forgets this phone (needs the session, so call before clearing it). */
    static void unregister(Context context) {
        Context app = context.getApplicationContext();
        RelaySession session = RelaySession.read(app);
        String token = prefs(app).getString("token", null);
        prefs(app).edit().putBoolean("active", false).remove("userId").apply();
        if (session == null || token == null) return;
        io.execute(() -> {
            try {
                Request request = new Request.Builder()
                    .url(session.origin + "/api/v1/push/devices")
                    .header("Authorization", "Bearer " + session.token)
                    .delete(RequestBody.create(new JSONObject().put("token", token).toString(), JSON))
                    .build();
                http.newCall(request).execute().close();
            } catch (Exception ignored) {
                // Signing out removes the session's push devices on the server anyway.
            }
        });
    }

    private static void setActive(Context context, boolean active, String userId) {
        SharedPreferences.Editor editor = prefs(context).edit().putBoolean("active", active);
        if (userId != null) editor.putString("userId", userId);
        editor.apply();
        main.post(() -> MessagingService.applyMode(context));
    }

    /** Decrypts a push body (AES-256-GCM; enc = ciphertext and tag, iv = 12 bytes), or null if it is not ours. */
    static JSONObject decrypt(Context context, String enc, String iv) {
        if (enc == null || iv == null) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            byte[] key = Base64.decode(deviceKey(context), Base64.NO_WRAP);
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            byte[] plain = cipher.doFinal(Base64.decode(enc, Base64.NO_WRAP));
            return new JSONObject(new String(plain, StandardCharsets.UTF_8));
        } catch (Exception notForThisKey) {
            Log.w(TAG, "push body could not be decrypted");
            return null;
        }
    }

    /** Two ticks for messages shown from a push. Blocking: called on the push's own worker thread. */
    static void markDelivered(Context context, String messageId) {
        post(context, "/api/v1/messages/delivered", new JSONObjectBuilder().put("messageIds", new JSONArray().put(messageId)).build());
    }

    /** Decline or hang up over HTTP (no connection needed): the server ends the call for both sides. */
    static boolean declineCall(Context context, String callId) {
        if (callId == null || callId.isEmpty()) return false;
        return post(context, "/api/v1/calls/" + android.net.Uri.encode(callId) + "/end", new JSONObject());
    }

    private static boolean post(Context context, String path, JSONObject body) {
        RelaySession session = RelaySession.read(context);
        if (session == null || body == null) return false;
        Request request = new Request.Builder()
            .url(session.origin + path)
            .header("Authorization", "Bearer " + session.token)
            .post(RequestBody.create(body.toString(), JSON))
            .build();
        try (Response response = http.newCall(request).execute()) {
            return response.isSuccessful();
        } catch (Exception offline) {
            return false;
        }
    }

    /** JSONObject.put throws a checked exception; this keeps one-line bodies readable. */
    private static final class JSONObjectBuilder {
        private final JSONObject object = new JSONObject();

        JSONObjectBuilder put(String key, Object value) {
            try {
                object.put(key, value);
            } catch (Exception ignored) {
                // Keys and values here are always valid.
            }
            return this;
        }

        JSONObject build() {
            return object;
        }
    }
}
