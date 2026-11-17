package io.github.bickworld555.hiddenchat;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Over-the-air web updates (server/otaUpdates.mjs publishes them; src/otaConfig.js has the shared rules).
 *
 * The app's web code ships inside the APK (assets/public, served at https://localhost). A signed bundle published
 * later replaces it without a new APK:
 * 1. check(): reads the manifest, verifies its ECDSA P-256 signature with PUBLIC_KEY (built into the app, so neither
 *    the server nor the network can change what runs), skips bundles that need newer native code (NATIVE_API) and
 *    bundles that failed here before, then builds the bundle in files/ota/<version>: each file is copied from the
 *    copy in use or the APK when its SHA-256 already matches, otherwise downloaded by hash; every file is verified.
 * 2. The finished bundle is used from the next cold start (never in the middle of a call): Capacitor's own setting
 *    (CapWebViewSettings / serverBasePath, read when its bridge starts) points at the folder, as a "trial".
 * 3. The web app calls confirm() once it has started properly. A trial bundle that started and never confirmed
 *    (a broken update) is dropped at the following start and the previous copy comes back; that version is never
 *    tried again on this phone.
 * A new APK always starts from its own bundled code (Capacitor clears the setting; beforeBridge() drops old bundles).
 */
final class OtaUpdates {
    private OtaUpdates() {}

    // Must equal NATIVE_API in src/otaConfig.js (a test checks): bump both when web code starts needing new native code.
    static final int NATIVE_API = 1;
    // Must equal OTA_PUBLIC_KEY in src/otaConfig.js.
    static final String PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9D5SrYnL+4D42UU1pHh0kmcGxT/Rjq6mhtbZUWeaIzFUXcFSgBht7WFLYKPYfyuy7yYY0Ld9hU4eRm8/BZyoxg==";

    private static final String PREFS = "hm_ota";
    private static final String CAP_PREFS = "CapWebViewSettings";
    private static final String CAP_SERVER_PATH = "serverBasePath";
    private static final Pattern VERSION = Pattern.compile("^[A-Za-z0-9._-]{1,48}$");
    private static final Pattern PATH = Pattern.compile("^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._@-]+(?:/[A-Za-z0-9._@-]+)*$");
    private static final Pattern SHA = Pattern.compile("^[0-9a-f]{64}$");
    private static final long MAX_FILE = 64L * 1024 * 1024;
    private static final long MAX_TOTAL = 160L * 1024 * 1024;
    private static final int MAX_FILES = 2000;
    private static final int MAX_MANIFEST = 1024 * 1024;
    private static final Object LOCK = new Object();

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static File root(Context context) {
        return new File(context.getFilesDir(), "ota");
    }

    private static File dir(Context context, String version) {
        return new File(root(context), version);
    }

    private static long appVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception e) {
            return -1;
        }
    }

    /** Called before Capacitor's bridge starts (AppActivity.onCreate): rolls back an unconfirmed trial, drops bundles of an older APK. */
    static void beforeBridge(Context context) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(context);
            SharedPreferences cap = context.getSharedPreferences(CAP_PREFS, Activity.MODE_PRIVATE);
            long installed = appVersion(context);
            if (p.getLong("apk", -2) != installed) {
                // A new APK: its own bundled code first (Capacitor clears serverBasePath too); old bundles go.
                deleteTree(root(context));
                p.edit().clear().putLong("apk", installed).apply();
                cap.edit().putString(CAP_SERVER_PATH, "").apply();
                return;
            }
            String trial = p.getString("trial", null);
            if (trial == null) return;
            int boots = p.getInt("trialBoots", 0) + 1;
            if (boots < 2) {
                p.edit().putInt("trialBoots", boots).apply();
                return;
            }
            // Started with this bundle before and it never confirmed: back to the previous copy, never this one again.
            String active = p.getString("active", null);
            File activeDir = active == null ? null : dir(context, active);
            cap.edit().putString(CAP_SERVER_PATH, activeDir != null && activeDir.isDirectory() ? activeDir.getAbsolutePath() : "").apply();
            Set<String> bad = new HashSet<>(p.getStringSet("bad", new HashSet<>()));
            bad.add(trial);
            p.edit().remove("trial").remove("trialBoots").putStringSet("bad", bad).apply();
            deleteTree(dir(context, trial));
        }
    }

    /** The web app started properly: the trial bundle (if any) becomes the confirmed one; older bundles go. */
    static void confirm(Context context) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(context);
            String trial = p.getString("trial", null);
            if (trial == null) return;
            p.edit().putString("active", trial).remove("trial").remove("trialBoots").apply();
            File[] children = root(context).listFiles();
            if (children != null) for (File child : children) if (!child.getName().equals(trial)) deleteTree(child);
        }
    }

    /** The folder the app's pages are served from when it is a confirmed bundle (the background page uses it too), else null. */
    static File confirmedDir(Context context) {
        SharedPreferences p = prefs(context);
        if (p.getString("trial", null) != null) return null;
        String active = p.getString("active", null);
        if (active == null) return null;
        File folder = dir(context, active);
        String serving = context.getSharedPreferences(CAP_PREFS, Activity.MODE_PRIVATE).getString(CAP_SERVER_PATH, "");
        return folder.isDirectory() && folder.getAbsolutePath().equals(serving) ? folder : null;
    }

    static JSONObject status(Context context) {
        SharedPreferences p = prefs(context);
        JSONObject result = new JSONObject();
        try {
            result.put("nativeApi", NATIVE_API);
            result.put("active", p.getString("active", null));
            result.put("trial", p.getString("trial", null));
        } catch (Exception ignored) {
            // not reachable with these value types
        }
        return result;
    }

    /**
     * Looks for a newer bundle at `origin` and prepares it for the next start. Returns "none" (nothing published),
     * "current", "needs-app-update", "failed-before", "ready" (prepared), or throws on a network/verification error.
     */
    static String check(Context context, String origin) throws Exception {
        if (origin == null || !origin.startsWith("https://")) throw new IOException("Updates come over HTTPS only.");
        synchronized (LOCK) {
            String manifestText = fetchText(origin + "/ota/manifest.json");
            if (manifestText == null) return "none";
            JSONObject manifest = new JSONObject(manifestText);
            String payloadText = manifest.getString("payload");
            byte[] signature = Base64.decode(manifest.getString("signature"), Base64.DEFAULT);
            if (!verify(payloadText.getBytes(StandardCharsets.UTF_8), signature)) throw new SecurityException("The update is not signed with the app's key.");
            JSONObject payload = new JSONObject(payloadText);
            String version = payload.getString("version");
            if (!VERSION.matcher(version).matches()) throw new SecurityException("Bad update version.");
            SharedPreferences p = prefs(context);
            if (version.equals(p.getString("active", null)) || version.equals(p.getString("trial", null))) return "current";
            if (p.getStringSet("bad", new HashSet<>()).contains(version)) return "failed-before";
            if (payload.getInt("nativeApi") > NATIVE_API) return "needs-app-update";
            JSONArray files = payload.getJSONArray("files");
            if (files.length() == 0 || files.length() > MAX_FILES) throw new SecurityException("Bad update file list.");

            File source = currentDir(context);
            File target = dir(context, version);
            File part = new File(root(context), version + ".part");
            deleteTree(part);
            if (!part.mkdirs()) throw new IOException("Cannot write the update.");
            long total = 0;
            boolean hasIndex = false;
            try {
                for (int i = 0; i < files.length(); i++) {
                    JSONObject file = files.getJSONObject(i);
                    String path = file.getString("path");
                    String sha = file.getString("sha256").toLowerCase(Locale.ROOT);
                    long size = file.getLong("size");
                    if (!PATH.matcher(path).matches() || !SHA.matcher(sha).matches() || size < 0 || size > MAX_FILE) throw new SecurityException("Bad update file " + path);
                    total += size;
                    if (total > MAX_TOTAL) throw new SecurityException("The update is too large.");
                    if (path.equals("index.html")) hasIndex = true;
                    File out = new File(part, path);
                    File parent = out.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot write " + path);
                    if (copyIfMatches(source != null ? openFile(new File(source, path)) : openAsset(context, path), out, sha, size)) continue;
                    if (source != null && copyIfMatches(openAsset(context, path), out, sha, size)) continue;
                    download(origin + "/ota/files/" + sha, out, sha, size);
                }
                if (!hasIndex) throw new SecurityException("The update has no index.html.");
                deleteTree(target);
                if (!part.renameTo(target)) throw new IOException("Cannot finish the update.");
            } catch (Exception failure) {
                deleteTree(part);
                throw failure;
            }
            // Used from the next start, as a trial until the web app confirms it.
            String previousTrial = p.getString("trial", null);
            if (previousTrial != null && !previousTrial.equals(version)) deleteTree(dir(context, previousTrial));
            context.getSharedPreferences(CAP_PREFS, Activity.MODE_PRIVATE).edit().putString(CAP_SERVER_PATH, target.getAbsolutePath()).apply();
            p.edit().putString("trial", version).putInt("trialBoots", 0).apply();
            return "ready";
        }
    }

    private static File currentDir(Context context) {
        String serving = context.getSharedPreferences(CAP_PREFS, Activity.MODE_PRIVATE).getString(CAP_SERVER_PATH, "");
        if (serving == null || serving.isEmpty()) return null;
        File folder = new File(serving);
        return folder.isDirectory() ? folder : null;
    }

    static boolean verify(byte[] data, byte[] signature) {
        try {
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.decode(PUBLIC_KEY, Base64.DEFAULT)));
            Signature check = Signature.getInstance("SHA256withECDSA");
            check.initVerify(key);
            check.update(data);
            return check.verify(signature);
        } catch (Exception e) {
            return false;
        }
    }

    private static InputStream openFile(File file) {
        try {
            return file.isFile() ? new FileInputStream(file) : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static InputStream openAsset(Context context, String path) {
        try {
            return context.getAssets().open("public/" + path);
        } catch (IOException e) {
            return null;
        }
    }

    /** Copies `in` to `out` when its SHA-256 and size match; otherwise leaves no file and returns false. */
    private static boolean copyIfMatches(InputStream in, File out, String sha, long size) {
        if (in == null) return false;
        try {
            if (writeVerified(in, out, sha, size)) return true;
        } catch (IOException ignored) {
            // fall through to the next source
        }
        out.delete();
        return false;
    }

    private static boolean writeVerified(InputStream in, File out, String sha, long size) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException(e);
        }
        long written = 0;
        try (InputStream input = in; OutputStream output = new FileOutputStream(out)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                written += read;
                if (written > size) return false;
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
            }
        }
        if (written != size) return false;
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString().equals(sha);
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty(ClientVersion.HEADER, String.valueOf(ClientVersion.PROTOCOL));
        return connection;
    }

    /** The response text, or null on 404 (nothing published). */
    private static String fetchText(String url) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            int code = connection.getResponseCode();
            if (code == 404) return null;
            if (code != 200) throw new IOException("Update check: HTTP " + code);
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[16 * 1024];
                java.io.ByteArrayOutputStream text = new java.io.ByteArrayOutputStream();
                int read;
                while ((read = in.read(buffer)) != -1) {
                    text.write(buffer, 0, read);
                    if (text.size() > MAX_MANIFEST) throw new IOException("The update manifest is too large.");
                }
                return text.toString("UTF-8");
            }
        } finally {
            connection.disconnect();
        }
    }

    private static void download(String url, File out, String sha, long size) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Update file: HTTP " + connection.getResponseCode());
            if (!writeVerified(connection.getInputStream(), out, sha, size)) {
                out.delete();
                throw new SecurityException("An update file does not match its hash.");
            }
        } finally {
            connection.disconnect();
        }
    }

    static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
