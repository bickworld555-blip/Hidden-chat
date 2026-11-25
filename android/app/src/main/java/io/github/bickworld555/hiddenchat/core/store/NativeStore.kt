package io.github.bickworld555.hiddenchat.core.store

import android.content.Context
import io.github.bickworld555.hiddenchat.SecureStore
import io.github.bickworld555.hiddenchat.core.Json
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
// @JvmOverloads so the Java mirror (HiddenNativePlugin) can still construct it with just the core fields; the trailing
// ones (status ticks, reply quote) are set by the native receive/echo paths, not the mirror.
data class MessageRecord @JvmOverloads constructor(
    val id: String,
    val mine: Boolean,
    val text: String,
    val time: String,
    val ts: Long,
    val status: String = "",
    /** The id of the message this one replies to (item 4 replies), or "". */
    val replyTo: String = "",
    /** The quoted snippet of [replyTo], resolved at read time (never stored); "" when unknown/not a reply. */
    val replyText: String = "",
    /** This message's reactions (item 4) as (userId, emoji) pairs; empty when none. */
    val reactions: List<Pair<String, String>> = emptyList(),
    /** Item 4 edit/delete: whether this message was edited, and whether it was deleted-for-everyone (placeholder). */
    val edited: Boolean = false,
    val deleted: Boolean = false,
    /** Item 4 forwarding: whether this message was forwarded (the inner `fw` flag), for the "Forwarded" label. */
    val forwarded: Boolean = false,
    /** Item 4 disappearing: when this message disappears (epoch ms), or 0 = never; drives the ⏱ indicator. */
    val expiresAt: Long = 0,
    /** Item 4 link previews: the sender-made preview card as JSON (the inner `lp`), or "" when the message has none. */
    val linkPreview: String = "",
    /** Item 5 media: the kind (photo|video|voice|gif|doc|"") this message is, the carried preview image (the inner
     *  `th` thumbnail for photos / `pv` poster for videos, a small JPEG data URL; "" when none), and a video/voice
     *  length in seconds (0 = none). Lets the native bubble show the real media preview instead of a text label. */
    val mediaKind: String = "",
    val mediaPreview: String = "",
    val mediaDuration: Int = 0,
    /** Item 5 full-res media: the raw attachment content ("emedia:<id>:<descriptor>:<name>" / "media:<id>:<name>"), so
     *  the native viewer can find the ciphertext file and its key to decrypt the full-resolution photo/video. "" = none. */
    val mediaSource: String = "",
)

/** One row of the authoritative message store (checklist item 2): a message's full JSON, keyed by (chatId, id), ts in ms.
 *  [text] is the readable words for the search index (provided by JS — src/sqliteMessageDb.js searchableText — since
 *  native keeps `json` opaque and never parses it); "" for ciphertext/structured payloads that are not searchable. */
data class FullMessage @JvmOverloads constructor(val chatId: String, val id: String, val ts: Long, val json: String, val text: String = "")

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
class NativeStore private constructor(private val db: SQLiteDatabase, private val ftsAvailable: Boolean) : KeyRecords {
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
    override fun clear() { exclusive { db.execSQL("DELETE FROM records"); db.execSQL("DELETE FROM chats"); db.execSQL("DELETE FROM contacts"); db.execSQL("DELETE FROM chat_messages"); db.execSQL("DELETE FROM full_messages"); if (ftsAvailable) db.execSQL("DELETE FROM full_messages_fts"); bump() } }

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
        // Carry each row's disappearing expiry (item 4) so a message the native sweep already removed does not
        // resurrect with no timer when the WebView mirror re-inserts it on relaunch (projection now sends expiresAt).
        for (row in rows) {
            upsertMessage(chatId, row.id, row.mine, row.text, row.time, row.ts, row.expiresAt)
            // Item 5 media: carry the WebView projection's media preview (thumb/poster) so native bubbles render it,
            // including for our own sent media and media the WebView (not native) received.
            if (row.mediaKind.isNotEmpty()) setMediaInternal(row.id, row.mediaKind, row.mediaPreview, row.mediaDuration, row.mediaSource)
        }
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

    private fun upsertMessage(chatId: String, id: String, mine: Boolean, text: String, time: String, ts: Long, expiresAt: Long = 0) {
        // Never overwrite an existing non-empty text with an empty one: the WebView mirror pushes empty text for a
        // message that native (not the WebView) sent or received — the web store has no content for it — which would
        // otherwise clobber the native row and show a blank bubble. Real messages always have a non-empty label.
        db.execSQL(
            "INSERT INTO chat_messages(chat_id, id, mine, text, time, ts, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(chat_id, id) DO UPDATE SET mine = excluded.mine, " +
                "text = CASE WHEN excluded.text = '' AND text <> '' THEN text ELSE excluded.text END, " +
                "time = excluded.time, ts = excluded.ts, " +
                // Disappearing (item 4): never downgrade a set expiry to 0 (a mirror/echo write that does not carry it);
                // apply a provided one. This is what stops a swept disappearing message from resurrecting with no timer
                // when the WebView mirror re-inserts it on relaunch — on the fresh INSERT it keeps its (past) expiry, so
                // messages() filters it and sweepExpired() removes it instead of showing it forever.
                "expires_at = CASE WHEN excluded.expires_at = 0 AND expires_at <> 0 THEN expires_at ELSE excluded.expires_at END",
            arrayOf(chatId, id, if (mine) 1 else 0, text, time, ts, maxOf(0L, expiresAt)),
        )
    }

    /** A chat's messages, oldest-first (by timestamp), for the native conversation screen. */
    fun messages(chatId: String): List<MessageRecord> = exclusive {
        val out = ArrayList<MessageRecord>()
        // Item 4 disappearing: a message past its expires_at is not shown (the sweep removes it from the DB separately).
        val now = System.currentTimeMillis()
        db.rawQuery("SELECT id, mine, text, time, ts, status, reply_to, reactions, edited, deleted, forwarded, expires_at, link_preview, media_kind, media_preview, media_duration, media_source FROM chat_messages WHERE chat_id = ? AND (expires_at = 0 OR expires_at > $now) ORDER BY ts ASC", arrayOf(chatId)).use { cursor ->
            while (cursor.moveToNext()) {
                out.add(MessageRecord(cursor.getString(0), cursor.getInt(1) != 0, cursor.getString(2), cursor.getString(3), cursor.getLong(4), cursor.getString(5) ?: "", cursor.getString(6) ?: "", "", parseReactions(cursor.getString(7)), cursor.getInt(8) != 0, cursor.getInt(9) != 0, cursor.getInt(10) != 0, cursor.getLong(11), cursor.getString(12) ?: "", cursor.getString(13) ?: "", cursor.getString(14) ?: "", cursor.getInt(15), cursor.getString(16) ?: ""))
            }
        }
        // Item 4 replies: resolve each reply's quoted snippet from the message it points to (same chat), so the native UI
        // can show "┃ <quoted text>" above the bubble without a second query. Unknown (older/unloaded) → left blank.
        val byId = out.associateBy { it.id }
        out.map { if (it.replyTo.isNotEmpty()) it.copy(replyText = byId[it.replyTo]?.text ?: "") else it }
    }

    // Item 4 reactions: the reactions column is a JSON array [{u:userId, e:emoji}]; one reaction per user (toggle).
    private fun parseReactions(json: String?): List<Pair<String, String>> {
        if (json.isNullOrEmpty()) return emptyList()
        val list = runCatching { Json.list(Json.parse(json)) }.getOrNull() ?: return emptyList()
        return list.mapNotNull { entry ->
            val m = Json.map(entry) ?: return@mapNotNull null
            val u = Json.string(m["u"]); val e = Json.string(m["e"])
            if (u != null && e != null) u to e else null
        }
    }

    private fun reactionsJson(reactions: List<Pair<String, String>>): String =
        Json.stringify(reactions.map { linkedMapOf<String, Any?>("u" to it.first, "e" to it.second) })

    /**
     * Applies a reaction to the message with [messageId] (found across chats — ids are unique): sets [reactorId]'s emoji
     * (one per user, replacing any prior), or removes it when [emoji] is null. Item 4 reactions; mirrors store.js
     * applyReaction. No-op when the message is not stored here.
     */
    fun addReaction(messageId: String, reactorId: String, emoji: String?) = exclusive {
        val row = db.rawQuery("SELECT chat_id, reactions FROM chat_messages WHERE id = ? LIMIT 1", arrayOf(messageId)).use {
            if (it.moveToNext()) Pair(it.getString(0), it.getString(1) ?: "") else null
        } ?: return@exclusive
        val current = parseReactions(row.second)
        val others = current.filter { it.first != reactorId }
        val next = if (emoji.isNullOrEmpty()) others else others + (reactorId to emoji)
        db.execSQL("UPDATE chat_messages SET reactions = ? WHERE id = ?", arrayOf(reactionsJson(next), messageId))
        bump()
    }

    /** Item 4 edit: replaces a message's text (found by id across chats) and flags it edited. No-op if not stored or deleted. */
    fun editMessageText(messageId: String, newText: String) = exclusive {
        db.execSQL("UPDATE chat_messages SET text = ?, edited = 1 WHERE id = ? AND deleted = 0", arrayOf(newText, messageId))
        bump()
    }

    /** Item 4 delete-for-everyone: replaces a message (by id) with the deleted placeholder — clears text, reactions and
     *  reply, sets deleted=1. Idempotent; no-op if not stored. */
    fun markDeleted(messageId: String) = exclusive {
        db.execSQL("UPDATE chat_messages SET deleted = 1, text = '', reactions = '', reply_to = '', link_preview = '', media_kind = '', media_preview = '', media_duration = 0, media_source = '' WHERE id = ?", arrayOf(messageId))
        bump()
    }

    /** Item 4 forwarding: flags a message (by id) as forwarded, for the "Forwarded" label. */
    fun setForwarded(messageId: String) = exclusive {
        db.execSQL("UPDATE chat_messages SET forwarded = 1 WHERE id = ?", arrayOf(messageId))
        bump()
    }

    /** Item 4 link previews: stores the sender-made preview card (the inner `lp`, already sanitized) as JSON for a
     *  message (by id). Empty/blank clears it. Never clobbers with an empty value once a card is set. */
    fun setLinkPreview(messageId: String, json: String?) = exclusive {
        if (json.isNullOrBlank()) return@exclusive
        db.execSQL("UPDATE chat_messages SET link_preview = ? WHERE id = ?", arrayOf(json, messageId))
        bump()
    }

    /** Item 5 media: records a message's media kind + carried preview image (the inner th/pv) + length, so the native
     *  bubble shows the real photo/video preview. No-op for a non-media kind; never clobbers a set preview with empty. */
    fun setMedia(messageId: String, kind: String?, preview: String?, duration: Int, source: String? = "") = exclusive {
        if (setMediaInternal(messageId, kind, preview, duration, source)) bump()
    }

    // The media UPDATE without a transaction/bump, so saveMessages can call it inside its own exclusive{} batch.
    private fun setMediaInternal(messageId: String, kind: String?, preview: String?, duration: Int, source: String?): Boolean {
        if (kind.isNullOrEmpty()) return false
        db.execSQL(
            "UPDATE chat_messages SET media_kind = ?, " +
                "media_preview = CASE WHEN ? = '' AND media_preview <> '' THEN media_preview ELSE ? END, " +
                "media_duration = ?, " +
                "media_source = CASE WHEN ? = '' AND media_source <> '' THEN media_source ELSE ? END WHERE id = ?",
            arrayOf(kind, preview ?: "", preview ?: "", maxOf(0, duration), source ?: "", source ?: "", messageId),
        )
        return true
    }

    // --- item 4 disappearing messages -------------------------------------------------------------------------------

    /** Sets a message's disappear time (epoch ms; [expiresAt] <= 0 clears it). Found by id across chats. */
    fun setExpiry(messageId: String, expiresAt: Long) = exclusive {
        db.execSQL("UPDATE chat_messages SET expires_at = ? WHERE id = ?", arrayOf(maxOf(0L, expiresAt), messageId))
        bump()
    }

    /** The per-chat disappearing timer in seconds (0 = off), set via chat:disappearing. */
    fun disappearSeconds(chatId: String): Long = exclusive { get("disappear:$chatId")?.toLongOrNull() ?: 0L }

    /** Records the per-chat disappearing timer (seconds; 0 = off). */
    fun setDisappearSeconds(chatId: String, seconds: Long) = exclusive {
        if (seconds > 0) set("disappear:$chatId", seconds.toString()) else delete("disappear:$chatId")
        bump()
    }

    /** Deletes every message already past its expires_at (the disappearing sweep); returns how many went. */
    fun sweepExpired(): Int = exclusive {
        val now = System.currentTimeMillis()
        val gone = db.rawQuery("SELECT COUNT(*) FROM chat_messages WHERE expires_at > 0 AND expires_at <= $now", null).use { if (it.moveToNext()) it.getInt(0) else 0 }
        if (gone > 0) { db.execSQL("DELETE FROM chat_messages WHERE expires_at > 0 AND expires_at <= $now"); bump() }
        gone
    }

    /** Records which message [id] (in [chatId]) replies to (item 4 replies); never clobbers an existing non-empty value. */
    fun setReplyTo(chatId: String, id: String, replyTo: String) = exclusive {
        if (replyTo.isEmpty()) return@exclusive
        db.execSQL(
            "UPDATE chat_messages SET reply_to = ? WHERE chat_id = ? AND id = ? AND reply_to = ''",
            arrayOf(replyTo, chatId, id),
        )
        bump()
    }

    // Checklist item 4 (read-receipt ticks): status moves forward only (failed<sent/waiting<delivered<read), mirroring
    // src/messageStatus.js mergeMessageStatus, so a late or duplicate receipt can never downgrade a tick.
    private val statusRank = mapOf("failed" to 0, "waiting" to 1, "sent" to 1, "delivered" to 2, "read" to 3)

    /** Raises one sent message's delivery status by id (message:status/ack carry only the id), never downgrading it. */
    fun raiseStatusById(id: String, status: String) = exclusive {
        val newRank = statusRank[status] ?: return@exclusive
        val current = db.rawQuery("SELECT status FROM chat_messages WHERE id = ? LIMIT 1", arrayOf(id)).use {
            if (it.moveToNext()) it.getString(0) ?: "" else null
        } ?: return@exclusive
        if (newRank > (statusRank[current] ?: -1)) {
            db.execSQL("UPDATE chat_messages SET status = ? WHERE id = ?", arrayOf(status, id))
            bump()
        }
    }

    /**
     * The native UI opened [chatId]: clears its unread badge and returns the incoming message ids that still need a read
     * receipt sent (those newer than the last read watermark for this chat), advancing the watermark so each is sent
     * once. The caller sends `message:read` for them over the native socket. Mirrors store.js markRead (read receipts
     * only move forward, so re-opening never re-sends).
     */
    fun markChatRead(chatId: String): List<String> = exclusive {
        val key = "read-watermark:$chatId"
        val since = get(key)?.toLongOrNull() ?: 0L
        val ids = ArrayList<String>()
        var maxTs = since
        db.rawQuery("SELECT id, ts FROM chat_messages WHERE chat_id = ? AND mine = 0 AND ts > $since ORDER BY ts ASC", arrayOf(chatId)).use { c ->
            while (c.moveToNext()) { ids.add(c.getString(0)); maxTs = maxOf(maxTs, c.getLong(1)) }
        }
        if (maxTs > since) set(key, maxTs.toString())
        // Clear the unread badge in the chat-list projection (the user is now looking at the chat).
        val exists = db.rawQuery("SELECT 1 FROM chats WHERE id = ? LIMIT 1", arrayOf(chatId)).use { it.moveToNext() }
        if (exists) db.execSQL("UPDATE chats SET unread = 0 WHERE id = ?", arrayOf(chatId))
        if (ids.isNotEmpty() || exists) bump()
        ids
    }

    // --- authoritative full-message store (checklist item 2): the WebView's messageStore backend ----------------------
    // Native treats `json` as an opaque blob (round-tripped, never parsed), so it stays decoupled from the message shape.

    /** Applies one messageStore diff atomically: clear whole chats, delete by id (any chat), then upsert full rows.
     *  Keeps the search index (search_text + the FTS5 row) in step with each change. */
    fun applyFullMessages(puts: List<FullMessage>, deletes: List<String>, clearChats: List<String>) = exclusive {
        for (chat in clearChats) {
            if (ftsAvailable) db.execSQL("DELETE FROM full_messages_fts WHERE rowid IN (SELECT rowid FROM full_messages WHERE chat_id = ?)", arrayOf(chat))
            db.execSQL("DELETE FROM full_messages WHERE chat_id = ?", arrayOf(chat))
        }
        for (id in deletes) {
            if (ftsAvailable) db.execSQL("DELETE FROM full_messages_fts WHERE rowid IN (SELECT rowid FROM full_messages WHERE id = ?)", arrayOf(id))
            db.execSQL("DELETE FROM full_messages WHERE id = ?", arrayOf(id))
        }
        for (m in puts) {
            db.execSQL(
                "INSERT INTO full_messages(chat_id, id, ts, json, search_text) VALUES(?, ?, ?, ?, ?) " +
                    "ON CONFLICT(chat_id, id) DO UPDATE SET ts = excluded.ts, json = excluded.json, search_text = excluded.search_text",
                arrayOf(m.chatId, m.id, m.ts, m.json, m.text),
            )
            syncFtsRow(m.chatId, m.id, m.text)
        }
    }

    /** Re-points the FTS5 row for (chatId,id) at the row's current search_text (drop the old, add the new). No-op
     *  without FTS5 (the LIKE fallback reads search_text directly). The full_messages row must already be written. */
    private fun syncFtsRow(chatId: String, id: String, text: String) {
        if (!ftsAvailable) return
        db.execSQL("DELETE FROM full_messages_fts WHERE rowid = (SELECT rowid FROM full_messages WHERE chat_id = ? AND id = ?)", arrayOf(chatId, id))
        if (text.isNotEmpty()) db.execSQL("INSERT INTO full_messages_fts(rowid, text) SELECT rowid, search_text FROM full_messages WHERE chat_id = ? AND id = ?", arrayOf(chatId, id))
    }

    /**
     * Full-text search over the stored messages (checklist item 2), newest-first, as [(id, chatId)] pairs — the same
     * shape sqlite search returns ({id, chat}). Uses the FTS5 index when the build has it, else a LIKE scan of the
     * JS-supplied search_text (never the opaque json, so ciphertext never matches). Empty/blank query → no results.
     */
    fun searchFullMessages(query: String, limit: Int): List<Pair<String, String>> = exclusive {
        val words = query.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(8)
        if (words.isEmpty()) return@exclusive emptyList()
        val cap = if (limit in 1..1000) limit else 200
        val out = ArrayList<Pair<String, String>>()
        if (ftsAvailable) {
            // Prefix match per word (mirrors sqlite): each word quoted (FTS operators neutralized) then a trailing `*`.
            val match = words.joinToString(" ") { "\"" + it.replace("\"", "\"\"") + "\"*" }
            try {
                db.rawQuery(
                    "SELECT m.id, m.chat_id FROM full_messages_fts f JOIN full_messages m ON m.rowid = f.rowid " +
                        "WHERE full_messages_fts MATCH ? ORDER BY m.ts DESC LIMIT $cap",
                    arrayOf(match),
                ).use { c -> while (c.moveToNext()) out.add(c.getString(0) to c.getString(1)) }
                return@exclusive out
            } catch (bad: Throwable) {
                // A malformed FTS expression (should not happen after quoting) falls through to the LIKE scan.
                android.util.Log.w("NativeStore", "FTS match failed; LIKE fallback", bad)
                out.clear()
            }
        }
        val like = "%" + words.joinToString(" ") + "%"
        db.rawQuery(
            "SELECT id, chat_id FROM full_messages WHERE search_text <> '' AND search_text LIKE ? ORDER BY ts DESC LIMIT $cap",
            arrayOf(like),
        ).use { c -> while (c.moveToNext()) out.add(c.getString(0) to c.getString(1)) }
        out
    }

    /**
     * Backfills the search index for messages stored before the index existed (JS supplies each id's searchable text,
     * since native keeps `json` opaque): sets search_text and re-syncs the FTS row per id. Idempotent; ids not stored
     * are skipped. Returns how many rows were updated. Ids are globally unique, so a message is matched by id alone.
     */
    fun reindexSearchText(entries: List<Pair<String, String>>): Int = exclusive {
        var updated = 0
        for ((id, text) in entries) {
            val chatId = db.rawQuery("SELECT chat_id FROM full_messages WHERE id = ? LIMIT 1", arrayOf(id)).use { if (it.moveToNext()) it.getString(0) else null } ?: continue
            db.execSQL("UPDATE full_messages SET search_text = ? WHERE chat_id = ? AND id = ?", arrayOf(text, chatId, id))
            syncFtsRow(chatId, id, text)
            updated++
        }
        updated
    }

    // ts/limit are internal numbers (not user text), inlined so the INTEGER column compares as a number (rawQuery binds
    // selection args as TEXT); chat_id stays parameter-bound. Returns one chat's rows older than beforeTs, oldest-first.
    private fun olderRows(chatId: String, beforeTs: Long, limit: Int): Pair<List<String>, Boolean> {
        val newestFirst = ArrayList<String>()
        db.rawQuery(
            "SELECT json FROM full_messages WHERE chat_id = ? AND ts < $beforeTs ORDER BY ts DESC LIMIT ${limit + 1}",
            arrayOf(chatId),
        ).use { c -> while (c.moveToNext()) newestFirst.add(c.getString(0)) }
        val more = newestFirst.size > limit
        val page = if (more) newestFirst.subList(0, limit) else newestFirst
        return page.asReversed().toList() to more // oldest-first, like messageDb.loadOlder
    }

    /** Up to [limit] of one chat's messages older than [beforeTs] (ms), oldest-first, and whether even older exist. */
    fun fullMessagesOlder(chatId: String, beforeTs: Long, limit: Int): Pair<List<String>, Boolean> = exclusive { olderRows(chatId, beforeTs, limit) }

    /** The newest [limit] messages of every chat (oldest-first per chat) and the chats that have more. */
    fun fullMessagesRecent(limit: Int): Pair<Map<String, List<String>>, Set<String>> = exclusive {
        val chats = ArrayList<String>()
        db.rawQuery("SELECT DISTINCT chat_id FROM full_messages", null).use { c -> while (c.moveToNext()) chats.add(c.getString(0)) }
        val out = LinkedHashMap<String, List<String>>()
        val more = HashSet<String>()
        for (chat in chats) {
            val (page, hasMore) = olderRows(chat, Long.MAX_VALUE, limit)
            out[chat] = page
            if (hasMore) more.add(chat)
        }
        out to more
    }

    /** Every stored message, { chatId: [json…] } oldest-first per chat (a full backup/migration dump). */
    fun fullMessagesAll(): Map<String, List<String>> = exclusive {
        val out = LinkedHashMap<String, ArrayList<String>>()
        db.rawQuery("SELECT chat_id, json FROM full_messages ORDER BY chat_id ASC, ts ASC", null).use { c ->
            while (c.moveToNext()) out.getOrPut(c.getString(0)) { ArrayList() }.add(c.getString(1))
        }
        out
    }

    /** How many messages the authoritative store holds. */
    fun fullMessageCount(): Int = exclusive {
        db.rawQuery("SELECT COUNT(*) FROM full_messages", null).use { if (it.moveToNext()) it.getInt(0) else 0 }
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
            db.execSQL("DELETE FROM full_messages")
            if (ftsAvailable) db.execSQL("DELETE FROM full_messages_fts")
            set(OWNER, account)
            bump()
        }
    }

    /** The account this store belongs to (adoptOwner), e.g. to resolve which reaction on a message is the user's own. */
    fun owner(): String? = exclusive { get(OWNER) }

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
            var fts = false // set once the full_messages FTS5 index is confirmed available (below)
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
                db.execSQL("CREATE TABLE IF NOT EXISTS chat_messages (chat_id TEXT NOT NULL, id TEXT NOT NULL, mine INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, time TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '', PRIMARY KEY (chat_id, id))")
                db.execSQL("CREATE INDEX IF NOT EXISTS chat_messages_order ON chat_messages (chat_id, ts)")
                // Checklist item 4 (read-receipt ticks): the delivery status of OUR sent messages ('' | sent | delivered
                // | read), shown as ticks in the native conversation. A no-op once the column exists.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                // Checklist item 4 (replies/quotes): the id of the message this one replies to (the inner `r` field),
                // so the native conversation can show the quoted snippet above the bubble. A no-op once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN reply_to TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                // Checklist item 4 (reactions): a JSON array [{u:userId, e:emoji}] of this message's reactions, shown as
                // chips under the bubble. A no-op once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN reactions TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                // Checklist item 4 (edit / delete-for-everyone): edited=1 shows an "edited" label; deleted=1 renders the
                // "This message was deleted" placeholder. No-ops once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0") } catch (ignored: Throwable) { /* already present */ }
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0") } catch (ignored: Throwable) { /* already present */ }
                // Checklist item 4 (forwarding): forwarded=1 shows a "Forwarded" label (the inner `fw` flag). No-op once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0") } catch (ignored: Throwable) { /* already present */ }
                // Checklist item 4 (disappearing messages): expires_at (epoch ms) is when this message should disappear
                // (0 = never). Set from the inner `ex` seconds on send/receive; the sweep deletes rows past it. No-op once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0") } catch (ignored: Throwable) { /* already present */ }
                // Checklist item 4 (link previews): the sender-made preview card as JSON (the inner `lp`), shown as a
                // WhatsApp-style card above the text. Travels inside the E2E message; recipients fetch nothing. No-op once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN link_preview TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                // Item 5 media rendering: the kind + a carried preview image (the inner `th`/`pv` JPEG data URL) + a
                // video/voice length, so the native bubble shows the real photo/video preview, not a text label. No-ops once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN media_kind TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN media_preview TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN media_duration INTEGER NOT NULL DEFAULT 0") } catch (ignored: Throwable) { /* already present */ }
                // Item 5 full-res media: the raw attachment content (emedia/media ref), so the native viewer can decrypt
                // the full-resolution file on tap. No-op once present.
                try { db.execSQL("ALTER TABLE chat_messages ADD COLUMN media_source TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                // Checklist item 2 (authoritative store): the WebView's message history, native-owned. Each row is one
                // message's FULL JSON, opaque to native (round-tripped, never parsed here — native stays decoupled from
                // the WebView's evolving message shape), keyed by (chat_id, id) and ordered by ts (epoch ms). This is the
                // messageStore backend; the chat_messages projection above stays the native-UI display seam.
                db.execSQL("CREATE TABLE IF NOT EXISTS full_messages (chat_id TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, PRIMARY KEY (chat_id, id))")
                db.execSQL("CREATE INDEX IF NOT EXISTS full_messages_order ON full_messages (chat_id, ts)")
                // Checklist item 2 (native full-text search): the readable words of each full_messages row, supplied by
                // JS (searchableText — native keeps `json` opaque), so search needs no scan of ciphertext. '' when a
                // message has nothing searchable. A no-op once present.
                try { db.execSQL("ALTER TABLE full_messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''") } catch (ignored: Throwable) { /* already present */ }
                // An FTS5 index over search_text, rowid-linked to full_messages (like src/sqliteMessageDb.js messages_fts).
                // SQLCipher may be built without FTS5; if the CREATE fails, search falls back to a LIKE scan of search_text.
                fts = try {
                    db.execSQL("CREATE VIRTUAL TABLE IF NOT EXISTS full_messages_fts USING fts5(text)")
                    true
                } catch (noFts: Throwable) {
                    android.util.Log.w("NativeStore", "FTS5 unavailable; search uses a LIKE scan", noFts)
                    false
                }
            } catch (bad: Throwable) {
                try { db.close() } catch (ignored: Throwable) { /* already unusable */ }
                throw bad
            }
            return NativeStore(db, fts)
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
