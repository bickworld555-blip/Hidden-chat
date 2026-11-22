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

    fun close() = db.close()

    companion object {
        private const val DB_NAME = "hm-core.db"
        private const val KEY_PREF = "hm-core-store"
        private const val KEY_NAME = "db-key"

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
                } catch (unusable: Exception) {
                    null
                }
            }
        }

        private fun open(app: Context): NativeStore {
            val key = rawKey(app)
            val file = File(app.noBackupFilesDir, DB_NAME)
            // The same call style as DatabaseKey.java (net.zetetic:sqlcipher-android), with create flags.
            val db = SQLiteDatabase.openDatabase(
                file.absolutePath, key, null,
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY, null,
            )
            db.execSQL("PRAGMA journal_mode = WAL")
            db.execSQL("CREATE TABLE IF NOT EXISTS records (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
            return NativeStore(db)
        }

        /** The database's raw SQLCipher passphrase ("x'<64 hex>'"), made and Keystore-sealed on first use. */
        private fun rawKey(app: Context): String {
            val prefs = app.getSharedPreferences(KEY_PREF, Context.MODE_PRIVATE)
            val sealed = prefs.getString(KEY_NAME, null)
            if (sealed != null && SecureStore.isSealed(sealed)) {
                val hex = SecureStore.open(sealed)
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
