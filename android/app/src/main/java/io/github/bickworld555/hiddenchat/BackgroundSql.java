package io.github.bickworld555.hiddenchat;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.community.database.sqlite.CapacitorSQLite;
import com.getcapacitor.community.database.sqlite.SQLite.SqliteConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Hashtable;

/**
 * The app's encrypted database (src/sqliteMessageDb.js: "hm-local", SQLCipher, the passphrase kept by the plugin in
 * Android's secure storage) for the background page, like WhatsApp's native code writing msgstore.db from a push.
 * The page has no Capacitor bridge, so the same plugin's Java side is driven here, behind the same four calls the
 * app's code makes (query, run, execute, executeSet); the schema and every statement stay in src/sqliteMessageDb.js.
 *
 * Only a database the app has already created and keyed is opened (never a new empty one). One connection while the
 * page runs, closed when it finishes (HeadlessRunner.finish), so the app's own connection opens cleanly.
 */
final class BackgroundSql {
    private static final String DB_NAME = "hm-local";
    private static CapacitorSQLite sqlite;
    private static boolean open;

    private BackgroundSql() { }

    /** One call from the page: { op, statement, values, set, transaction } → { values } / { changes } / { error }. */
    static synchronized String call(Context context, String json) {
        try {
            JSONObject request = new JSONObject(json);
            ensureOpen(context);
            String op = request.optString("op");
            boolean transaction = request.optBoolean("transaction", true);
            JSObject result = new JSObject();
            switch (op) {
                case "query": {
                    JSArray rows = sqlite.query(DB_NAME, request.optString("statement"), values(request), false);
                    result.put("values", rows);
                    break;
                }
                case "run":
                    result.put("changes", sqlite.run(DB_NAME, request.optString("statement"), values(request), transaction, false, "no"));
                    break;
                case "execute":
                    result.put("changes", sqlite.execute(DB_NAME, request.optString("statement"), transaction, false));
                    break;
                case "executeSet": {
                    JSONArray set = request.optJSONArray("set");
                    result.put("changes", sqlite.executeSet(DB_NAME, JSArray.from(set == null ? new Object[0] : toArray(set)), transaction, false, "no"));
                    break;
                }
                default:
                    return error("unknown operation");
            }
            return result.toString();
        } catch (Exception failed) {
            return error(failed.getMessage());
        }
    }

    /** The page finished: the connection goes, so nothing of it outlives the page. */
    static synchronized void close() {
        if (sqlite == null || !open) return;
        try { sqlite.close(DB_NAME, false); } catch (Exception ignored) { }
        try { sqlite.closeConnection(DB_NAME, false); } catch (Exception ignored) { }
        open = false;
    }

    private static void ensureOpen(Context context) throws Exception {
        if (open) return;
        if (sqlite == null) {
            SqliteConfig config = new SqliteConfig();
            config.setIsEncryption(true);
            config.setBiometricAuth(false);
            sqlite = new CapacitorSQLite(context.getApplicationContext(), config);
        }
        // The app creates and keys the database; before it has, there is nothing to write into.
        // The same one-time key switch as the app's (whichever opens first in this process does it).
        DatabaseKey.ensureRaw(context);
        if (!sqlite.isDatabase(DB_NAME) || !sqlite.isSecretStored()) throw new Exception("no-database");
        try { sqlite.closeConnection(DB_NAME, false); } catch (Exception ignored) { }
        sqlite.createConnection(DB_NAME, true, "secret", 1, new Hashtable<>(), false);
        sqlite.open(DB_NAME, false);
        open = true;
    }

    private static JSArray values(JSONObject request) throws Exception {
        JSONArray values = request.optJSONArray("values");
        return values == null ? new JSArray() : JSArray.from(toArray(values));
    }

    private static Object[] toArray(JSONArray array) throws Exception {
        Object[] items = new Object[array.length()];
        for (int i = 0; i < array.length(); i++) items[i] = array.get(i);
        return items;
    }

    private static String error(String message) {
        try {
            return new JSONObject().put("error", message == null ? "failed" : message).toString();
        } catch (Exception broken) {
            return "{\"error\":\"failed\"}";
        }
    }
}
