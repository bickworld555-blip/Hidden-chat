package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import net.zetetic.database.sqlcipher.SQLiteDatabase;

import java.io.File;

/**
 * The local database (src/sqliteMessageDb.js "hm-local", SQLCipher) is keyed with a random 256-bit secret the SQLite
 * plugin keeps in its encrypted preferences (Android Keystore). Given as a passphrase, SQLCipher stretched it through
 * 256,000 rounds of PBKDF2 at every open: 422 ms of each cold start on the S23 (2026-11-22), which protects only weak,
 * human-chosen passwords. The same 256 bits given as a raw key (x'…') skip the stretching; the encryption and the key
 * stay exactly as strong.
 *
 * Once per phone, before anything opens the database: re-key it from the passphrase form to the raw form of the same
 * secret, check it opens with the new key, then store the new form. An interrupted switch is finished at the next
 * start (the raw form follows from the stored secret). Anything unexpected leaves everything as it was.
 */
final class DatabaseKey {
    private static final String TAG = "DatabaseKey";
    private static final String DB_FILE = "hm-localSQLite.db";
    // The SQLite plugin's own encrypted preferences (CapacitorSQLite.setSharedPreferences) and its secret's key.
    private static final String PLUGIN_PREFS = "sqlite_encrypted_shared_prefs";
    private static final String SECRET = "secret";
    // Plain flag: done on this phone (later starts skip opening the encrypted preferences).
    private static final String PREFS = "hm_db_key";
    private static final String DONE = "raw";
    private static boolean checked;

    private DatabaseKey() { }

    /** The raw-key form of a 64-hex-digit secret. */
    static String raw(String hex) {
        return "x'" + hex + "'";
    }

    /** Whether a stored secret is still in the old (stretched passphrase) form: exactly 64 hex digits. */
    static boolean isPassphraseForm(String secret) {
        return secret != null && secret.matches("[0-9a-fA-F]{64}");
    }

    /** Before the first open in this process (the app's or the background page's). Fast after the first time. */
    static synchronized void ensureRaw(Context context) {
        if (checked) return;
        checked = true;
        Context app = context.getApplicationContext();
        SharedPreferences flag = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (flag.getBoolean(DONE, false)) return;
        long started = android.os.SystemClock.elapsedRealtime();
        try {
            SharedPreferences prefs = pluginPrefs(app);
            String secret = prefs.getString(SECRET, "");
            if (secret == null || secret.isEmpty()) return; // not keyed yet: the app sets a raw-form secret itself
            if (!isPassphraseForm(secret)) { flag.edit().putBoolean(DONE, true).apply(); return; }
            String rawKey = raw(secret);
            File db = app.getDatabasePath(DB_FILE);
            if (db.exists()) {
                System.loadLibrary("sqlcipher");
                if (opens(db, secret)) {
                    // A copy (still under the old key) until the switch is confirmed: anything unexpected restores it.
                    File backup = new File(db.getPath() + ".prekey");
                    copy(db, backup);
                    try {
                        rekey(db, secret, rawKey);
                    } catch (Exception failed) {
                        if (!opens(db, secret) && !opens(db, rawKey)) copy(backup, db);
                        throw failed;
                    }
                    if (!opens(db, rawKey)) {
                        if (!opens(db, secret)) copy(backup, db);
                        Log.w(TAG, "re-keyed database does not open with the raw key; secret kept");
                        return;
                    }
                    if (!prefs.edit().putString(SECRET, rawKey).commit()) { Log.w(TAG, "new secret not stored; finished next start"); return; }
                    //noinspection ResultOfMethodCallIgnored
                    backup.delete();
                } else if (!opens(db, rawKey)) {
                    Log.w(TAG, "database opens with neither key form; left as it is");
                    return;
                }
            }
            if (!prefs.edit().putString(SECRET, rawKey).commit()) { Log.w(TAG, "new secret not stored; retried next start"); return; }
            flag.edit().putBoolean(DONE, true).apply();
            Log.i(TAG, "database key switched to raw form in " + (android.os.SystemClock.elapsedRealtime() - started) + " ms");
        } catch (Throwable failed) {
            // The plugin opens it with whatever secret is stored, exactly as before.
            Log.w(TAG, "raw-key switch skipped", failed);
        }
    }

    private static SharedPreferences pluginPrefs(Context app) throws Exception {
        MasterKey master = new MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(app, PLUGIN_PREFS, master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    private static boolean opens(File file, String key) {
        SQLiteDatabase db = null;
        try {
            db = SQLiteDatabase.openDatabase(file.getAbsolutePath(), key, null, SQLiteDatabase.OPEN_READONLY, null);
            try (android.database.Cursor cursor = db.rawQuery("SELECT count(*) FROM sqlite_master", (Object[]) null)) {
                return cursor.moveToFirst();
            }
        } catch (Exception wrongKey) {
            return false;
        } finally {
            if (db != null) try { db.close(); } catch (Exception ignored) { }
        }
    }

    private static void copy(File from, File to) throws java.io.IOException {
        try (java.io.FileInputStream in = new java.io.FileInputStream(from); java.io.FileOutputStream out = new java.io.FileOutputStream(to)) {
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) > 0;) out.write(buffer, 0, read);
            out.getFD().sync();
        }
    }

    // PRAGMA rekey in one transaction (rollback journal): an interruption leaves the database on the old key.
    private static void rekey(File file, String oldKey, String newKey) {
        SQLiteDatabase db = SQLiteDatabase.openDatabase(file.getAbsolutePath(), oldKey, null, SQLiteDatabase.OPEN_READWRITE, null);
        try {
            db.changePassword(newKey);
        } finally {
            db.close();
        }
    }
}
