package io.github.bickworld555.hiddenchat.core.store

import android.content.Context
import io.github.bickworld555.hiddenchat.SecureStore
import io.github.bickworld555.hiddenchat.core.crypto.KeyRecords
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.locks.ReentrantLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import net.zetetic.database.sqlcipher.SQLiteDatabase

/** One chat-list row the native (Compose) UI shows, mirrored from the web app's chat list (Step 5 data seam). */
data class ChatRecord(val id: String, val name: String, val preview: String, val time: String, val unread: Int, val avatar: String)

/** One person the native new-chat picker shows (chats + known people), mirrored from the web app (Step 5). */
data class ContactRecord(val id: String, val name: String, val avatar: String)

/**
 * One message in a chat the native UI shows. Keyed by [id] and ordered by [ts] (epoch ms) so the native background
 * inbox and the web-app mirror can both write it (upsert) without duplicates or ordering conflicts (Step 5).
 */
data class MessageRecord(val id: String, val mine: Boolean, val text: String, val time: String, val ts: Long)

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

    // Bumped whenever the UI-facing projections (chats / messages) change, so the native UI can observe the store as a
    // Flow and re-read off the main thread instead of blocking on open.
    private val _changes = MutableStateFlow(0L)
    val changes: StateFlow<Long> = _changes.asStateFlow()
    private fun bump() { _changes.value = _changes.value + 1 }

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

    /** Forgets every record (sign-out): the core's identity, sessions and keys all go, and the mirrored chat list. */
    override fun clear() { exclusive { db.execSQL("DELETE FROM records"); db.execSQL("DELETE FROM chats"); db.execSQL("DELETE FROM contacts"); db.execSQL("DELETE FROM chat_messages"); bump() } }

    /**
     * Replaces the mirrored chat list the native UI reads (Step 5 data seam), preserving the given order. The web app
     * owns the chat data and pushes this lightweight projection (id, name, preview, time, unread) whenever its list
     * changes; a later increment will have the native background inbox keep it up to date directly.
     */
    fun saveChats(rows: List<ChatRecord>) = exclusive {
        db.execSQL("DELETE FROM chats")
        rows.forEachIndexed { index, row ->
            db.execSQL(
                "INSERT INTO chats(id, name, preview, time, unread, position, avatar) VALUES(?, ?, ?, ?, ?, ?, ?)",
                arrayOf(row.id, row.name, row.preview, row.time, row.unread, index, row.avatar),
            )
        }
        bump()
    }

    /** The mirrored chat list for the native UI, in saved (most-recent-first) order. */
    fun chats(): List<ChatRecord> = exclusive {
        val out = ArrayList<ChatRecord>()
        db.rawQuery("SELECT id, name, preview, time, unread, avatar FROM chats ORDER BY position ASC", null).use { cursor ->
            while (cursor.moveToNext()) {
                out.add(ChatRecord(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3), cursor.getInt(4), cursor.getString(5)))
            }
        }
        out
    }

    /** Replaces the people the native new-chat picker shows (chats + known people), in the given order. */
    fun saveContacts(rows: List<ContactRecord>) = exclusive {
        db.execSQL("DELETE FROM contacts")
        rows.forEachIndexed { index, row ->
            db.execSQL("INSERT INTO contacts(id, name, position, avatar) VALUES(?, ?, ?, ?)", arrayOf(row.id, row.name, index, row.avatar))
        }
        bump()
    }

    /** The people for the native new-chat picker, in saved order. */
    fun contacts(): List<ContactRecord> = exclusive {
        val out = ArrayList<ContactRecord>()
        db.rawQuery("SELECT id, name, avatar FROM contacts ORDER BY position ASC", null).use { cursor ->
            while (cursor.moveToNext()) out.add(ContactRecord(cursor.getString(0), cursor.getString(1), cursor.getString(2)))
        }
        out
    }

    /** Upserts a window of a chat's messages (the web-app mirror), by id; existing rows are updated, others kept. */
    fun saveMessages(chatId: String, rows: List<MessageRecord>) = exclusive {
        for (row in rows) upsertMessage(chatId, row.id, row.mine, row.text, row.time, row.ts)
        bump()
    }

    /** Upserts one message (the native background inbox, as it decrypts an incoming message), so it appears natively. */
    fun addMessage(chatId: String, id: String, mine: Boolean, text: String, time: String, ts: Long) = exclusive {
        upsertMessage(chatId, id, mine, text, time, ts)
        bump()
    }

    /**
     * Reflects an incoming native-socket message in the chat-LIST projection — preview, time, unread +1, moved to the
     * top — so the native chat list updates live while native owns the foreground socket (the WebView mirror that
     * normally writes `chats` is suspended then). Only an existing row is updated; a brand-new sender's row still comes
     * from the next WebView mirror. No-op (no bump) when the chat is not in the list, so nothing flickers.
     */
    fun bumpChatForIncoming(chatId: String, preview: String, time: String) = exclusive {
        val exists = db.rawQuery("SELECT 1 FROM chats WHERE id = ? LIMIT 1", arrayOf(chatId)).use { it.moveToNext() }
        if (!exists) return@exclusive
        val top = db.rawQuery("SELECT MIN(position) FROM chats", null).use { if (it.moveToNext()) it.getInt(0) else 0 }
        db.execSQL(
            "UPDATE chats SET preview = ?, time = ?, unread = unread + 1, position = ? WHERE id = ?",
            arrayOf(preview, time, top - 1, chatId),
        )
        bump()
    }

    private fun upsertMessage(chatId: String, id: String, mine: Boolean, text: String, time: String, ts: Long) {
        // Never overwrite an existing non-empty text with an empty one: the WebView mirror pushes empty text for a
        // message that native (not the WebView) sent or received — the web store has no content for it — which would
        // otherwise clobber the native row and show a blank bubble. Real messages always have a non-empty label.
        db.execSQL(
            "INSERT INTO chat_messages(chat_id, id, mine, text, time, ts) VALUES(?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(chat_id, id) DO UPDATE SET mine = excluded.mine, " +
                "text = CASE WHEN excluded.text = '' AND text <> '' THEN text ELSE excluded.text END, " +
                "time = excluded.time, ts = excluded.ts",
            arrayOf(chatId, id, if (mine) 1 else 0, text, time, ts),
        )
    }

    /** A chat's messages, oldest-first (by timestamp), for the native conversation screen. */
    fun messages(chatId: String): List<MessageRecord> = exclusive {
        val out = ArrayList<MessageRecord>()
        db.rawQuery("SELECT id, mine, text, time, ts FROM chat_messages WHERE chat_id = ? ORDER BY ts ASC", arrayOf(chatId)).use { cursor ->
            while (cursor.moveToNext()) {
                out.add(MessageRecord(cursor.getString(0), cursor.getInt(1) != 0, cursor.getString(2), cursor.getString(3), cursor.getLong(4)))
            }
        }
        out
    }

    /**
     * Makes sure this store belongs to [account]. If it holds another account's data (or none yet), every record is
     * wiped first so the new owner starts from a fresh identity — the native store is never shared across accounts,
     * even if a sign-out wipe was missed (which would otherwise let the new account inherit the old one's identity,
     * sessions and the `native-keys-published` flag). Idempotent for the same owner.
     */
    fun adoptOwner(account: String) = exclusive {
        if (get(OWNER) != account) {
            db.execSQL("DELETE FROM records")
            db.execSQL("DELETE FROM chats")
            db.execSQL("DELETE FROM contacts")
            db.execSQL("DELETE FROM chat_messages")
            set(OWNER, account)
            bump()
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
                // Step 5 data seam: the native UI's chat-list + per-chat message projections, mirrored from the web app.
                db.execSQL("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, name TEXT NOT NULL, preview TEXT NOT NULL, time TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, avatar TEXT NOT NULL DEFAULT '')")
                db.execSQL("CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, avatar TEXT NOT NULL DEFAULT '')")
                // Add the avatar column to databases created before it existed (a no-op once the column is present).
                try { db.execSQL("ALTER TABLE chats ADD COLUMN avatar TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                try { db.execSQL("ALTER TABLE contacts ADD COLUMN avatar TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                // Superseded by chat_messages (id-keyed, ts-ordered, upsert) so the native inbox and the web mirror can
                // both write; the old position-ordered cache is dropped (it is a cache, rebuilt from the mirror/inbox).
                db.execSQL("DROP TABLE IF EXISTS messages")
                db.execSQL("CREATE TABLE IF NOT EXISTS chat_messages (chat_id TEXT NOT NULL, id TEXT NOT NULL, mine INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, time TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, id))")
                db.execSQL("CREATE INDEX IF NOT EXISTS chat_messages_order ON chat_messages (chat_id, ts)")
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
