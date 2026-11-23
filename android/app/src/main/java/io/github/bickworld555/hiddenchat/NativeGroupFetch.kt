package io.github.bickworld555.hiddenchat

import android.content.Context
import android.util.Log
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.NativeFetchHandler
import io.github.bickworld555.hiddenchat.core.crypto.CryptoCore

/**
 * The native background delivery of GROUP messages. Group messages are not replayed over the relay.fetch socket (the
 * server's connect replay is direct-only, and notifyGroup live-broadcasts only to online sockets), so an offline
 * device catches them up over REST: GET /api/v1/queue names the waiting group messages ({ id, groupId }); each group's
 * history carries the Sender Key envelopes; this device decrypts them with the installed core, seals each into the
 * native inbox and posts its notification, then acknowledges the ones it durably kept (POST /api/v1/queue/ack) so the
 * server stops re-queuing them. This mirrors what the WebView background page does on open (src/App.jsx's /queue drain)
 * and runs after the socket fetch in NativeBackgroundService. Decryption and the stored/notified step are shared with
 * the socket path (NativeFetchHandler, NativeDelivery): one owner, identical seal-before-ack and notification look.
 */
object NativeGroupFetch {
    private const val TAG = "NGF"

    /** Drains the group-message queue once. Returns how many group messages were delivered (decrypted, kept, acked). */
    fun run(context: Context, core: CryptoCore, meUserId: String, meDeviceId: String): Int {
        val server = NativeServer.from(context) ?: return 0
        val queue = server.getJson("/api/v1/queue") ?: return 0
        val waiting = Json.list(queue["groupMessages"]) ?: return 0
        if (waiting.isEmpty()) return 0

        // The waiting group message ids, grouped by the group whose history carries them.
        val pendingByGroup = LinkedHashMap<String, MutableSet<String>>()
        for (item in waiting) {
            val row = Json.map(item) ?: continue
            val id = Json.string(row["id"]) ?: continue
            val groupId = Json.string(row["groupId"]) ?: continue
            pendingByGroup.getOrPut(groupId) { LinkedHashSet() }.add(id)
        }

        val session = RelaySession.read(context)
        val acked = ArrayList<String>()
        for ((groupId, pendingIds) in pendingByGroup) {
            try {
                val history = server.getArray("/api/v1/groups/$groupId/messages") ?: continue
                val muted = session?.mutedGroups?.contains(groupId) == true
                // History is oldest-first, so Sender Key distributions are accepted before the messages that use them.
                for (item in history) {
                    val row = Json.map(item) ?: continue
                    val id = Json.string(row["id"]) ?: continue
                    if (!pendingIds.contains(id)) continue
                    val senderId = Json.string(row["senderId"]) ?: continue
                    if (senderId == meUserId) { acked.add(id); continue } // my own message echoed back: nothing to show
                    val content = Json.string(row["content"]) ?: continue
                    val event = Json.obj(
                        "type" to "group:message",
                        "message" to Json.obj("id" to id, "senderId" to senderId, "content" to content, "groupId" to groupId),
                    )
                    val delivery = NativeFetchHandler.handle(core, meUserId, meDeviceId, event)
                    if (delivery == null) continue
                    if (!delivery.opened) { Log.i(TAG, "left for app id=$id error=${delivery.error}"); continue }
                    // Durably keep BEFORE acking (seal-before-ack); the ratchet/sender-key has already advanced.
                    if (!NativeDelivery.persist(context, event, delivery)) continue
                    acked.add(id)
                    // Muting suppresses the notification, not delivery — the message is still kept and acked.
                    if (!muted) try { NativeDelivery.notify(context, delivery) } catch (shown: Throwable) { Log.w(TAG, "notify failed", shown) }
                }
            } catch (failed: Throwable) {
                Log.w(TAG, "group $groupId failed", failed)
            }
        }

        if (acked.isNotEmpty()) {
            server.postJson("/api/v1/queue/ack", Json.obj("messageIds" to acked, "eventIds" to emptyList<String>()))
        }
        Log.i(TAG, "group fetch: ${acked.size} delivered")
        return acked.size
    }
}
