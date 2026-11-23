package io.github.bickworld555.hiddenchat.core.store

import android.content.Context
import io.github.bickworld555.hiddenchat.SecureStore
import io.github.bickworld555.hiddenchat.core.crypto.KeyRecords
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.locks.ReentrantLock
import net.zetetic.database.sqlcipher.SQLiteDatabase

/**
 * Where the native encryption core (CryptoCore) keeps its records between calls: this device's identity, prekeys,
 * sessions, pinned identities and sender keys, by name, as JSON text. A SQLCipher database of its own
 * (`hm-core.db`), separate from the web app's "hm-local": the native stack owns its keys outright and does not reach
 * into the WebView's database or its key handling.
 *
 * The database's raw key is 32 random bytes, sealed by the Android Keystore (SecureStore) and kept in the app's
 * no-backup files; nothing readable is left on disk if the app's files are copied off the phone. If the Keystore key
 * is gone (app data restored to another phone), the old database cannot be opened and a fresh one is started —
 * acceptable here, because Phase 1 may wipe legacy keys.
 *
 * One operation at a time: [exclusive] holds a lock so a session is read, advanced and written back as one step,
 * matching the web protocol's serialised queue.
 */
class NativeStore private constructor(private val db: SQLiteDatabase) : KeyRecords {
    private val lock = ReentrantLock()

    override fun get(name: String): String? {
        db.rawQuery("SELECT v FROM records WHERE k = ?", arrayOf(name)).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }

    override fun set(name: String, json: String) {
        db.execSQL("INSERT INTO records(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", arrayOf(name, json))
    }

    override fun delete(name: String) {
        db.execSQL("DELETE FROM records WHERE k = ?", arrayOf(name))
    }

    private var depth = 0

    override fun <T> exclusive(work: () -> T): T {
        // Reentrant: the core nests exclusive{} (encryptGroup → encryptForDevices). The lock is reentrant, and only
        // the outermost call drives the SQLite transaction, so nested calls never open a second transaction.
        lock.lock()
        try {
            val outer = depth == 0
            if (outer) db.beginTransaction()
            depth++
            try {
                val result = work()
                if (outer) db.setTransactionSuccessful()
                return result
            } finally {
                depth--
                if (outer) db.endTransaction()
            }
        } finally {
            lock.unlock()
        }
    }

    /** Forgets every record (sign-out): the core's identity, sessions and keys all go. */
    override fun clear() { exclusive { db.execSQL("DELETE FROM records") } }

    /**
     * Makes sure this store belongs to [account]. If it holds another account's data (or none yet), every record is
     * wiped first so the new owner starts from a fresh identity — the native store is never shared across accounts,
     * even if a sign-out wipe was missed (which would otherwise let the new account inherit the old one's identity,
     * sessions and the `native-keys-published` flag). Idempotent for the same owner.
     */
    fun adoptOwner(account: String) = exclusive {
        if (get(OWNER) != account) {
            db.execSQL("DELETE FROM records")
            set(OWNER, account)
        }
    }

    fun close() = db.close()

    companion object {
        private const val DB_NAME = "hm-core.db"
        private const val KEY_PREF = "hm-core-store"
        private const val KEY_NAME = "db-key"
        // The account this store's data belongs to (adoptOwner); a different owner means a fresh start.
        private const val OWNER = "owner-account"

        @Volatile
        private var instance: NativeStore? = null

        /** The one store for this process, opened on first use. Null only when the Keystore is unusable. */
        fun get(context: Context): NativeStore? {
            instance?.let { return it }
            synchronized(this) {
                instance?.let { return it }
                return try {
                    val opened = open(context.applicationContext)
                    opened.also { instance = it }
                } catch (unusable: Throwable) {
                    android.util.Log.w("NativeStore", "could not open the native key store", unusable)
                    null
                }
            }
        }

        private fun open(app: Context): NativeStore {
            // Load the SQLCipher native library before any database call. DatabaseKey.java loads it on the WebView
            // path, but the native background service runs in a process where that path never ran, so without this the
            // first openDatabase throws UnsatisfiedLinkError and the native fetch dies. System.loadLibrary is idempotent.
            System.loadLibrary("sqlcipher")
            val file = File(app.noBackupFilesDir, DB_NAME)
            return try {
                openWith(file, rawKey(app))
            } catch (broken: Throwable) {
                // The database could not be opened with its key: a corrupt file, or a Keystore key that no longer
                // matches (device credentials reset, or app data restored to another phone). Rather than leave the
                // native path permanently off, discard the unreadable database and its sealed key and start fresh —
                // the native stack re-registers a fresh identity ("security code changed" to contacts).
                android.util.Log.w("NativeStore", "native key store unopenable; recreating fresh", broken)
                deleteStore(app, file)
                openWith(file, rawKey(app))
            }
        }

        /** Opens (or creates) the database at [file] with [key]; a wrong key fails on the first query, not openDatabase. */
        private fun openWith(file: File, key: String): NativeStore {
            // The same call style as DatabaseKey.java (net.zetetic:sqlcipher-android), with create flags.
            val db = SQLiteDatabase.openDatabase(
                file.absolutePath, key, null,
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY, null,
            )
            try {
                // PRAGMA journal_mode returns the new mode, so net.zetetic's SQLCipher requires rawQuery, not execSQL
                // (execSQL rejects result-returning statements). A wrong key throws here; CREATE TABLE returns nothing.
                db.rawQuery("PRAGMA journal_mode = WAL", null).use { it.moveToFirst() }
                db.execSQL("CREATE TABLE IF NOT EXISTS records (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
            } catch (bad: Throwable) {
                try { db.close() } catch (ignored: Throwable) { /* already unusable */ }
                throw bad
            }
            return NativeStore(db)
        }

        /** Removes the database (and its WAL/SHM side files) and its sealed key, so the next open starts clean. */
        private fun deleteStore(app: Context, file: File) {
            file.delete()
            File(file.absolutePath + "-wal").delete()
            File(file.absolutePath + "-shm").delete()
            app.getSharedPreferences(KEY_PREF, Context.MODE_PRIVATE).edit().remove(KEY_NAME).apply()
        }

        /** The database's raw SQLCipher passphrase ("x'<64 hex>'"), made and Keystore-sealed on first use. */
        private fun rawKey(app: Context): String {
            val prefs = app.getSharedPreferences(KEY_PREF, Context.MODE_PRIVATE)
            val sealed = prefs.getString(KEY_NAME, null)
            if (sealed != null && SecureStore.isSealed(sealed)) {
                // open() throws if the Keystore key changed (reset/restored); treat that as "no usable key" and make a
                // fresh one — open()'s caller then recreates the database, which the old key could not have opened.
                val hex = try { SecureStore.open(sealed) } catch (changed: Throwable) { null }
                if (hex != null && hex.length == 64) return "x'$hex'"
            }
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val hex = StringBuilder(64)
            for (b in bytes) hex.append("0123456789abcdef"[(b.toInt() ushr 4) and 15]).append("0123456789abcdef"[b.toInt() and 15])
            // seal() throws if the Keystore is unusable: then get() returns null and the native store is simply off.
            prefs.edit().putString(KEY_NAME, SecureStore.seal(hex.toString())).apply()
            return "x'$hex'"
        }
    }
}
