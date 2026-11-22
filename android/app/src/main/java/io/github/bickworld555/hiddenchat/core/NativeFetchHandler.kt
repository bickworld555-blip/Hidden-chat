package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.CryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.ProtocolError

/**
 * Turning one fetched event into a delivery: decrypt the message with the installed [CryptoCore] (advancing and
 * persisting the ratchet in NativeStore), and report what the socket client should do — notify, store, acknowledge.
 * The socket transport (NativeRelayFetch) is separate; this is the pure per-event logic, unit-tested end to end.
 *
 * Events are the server's `message:new` / `group:message` (server/index.mjs): `{ type, message: { id, senderId,
 * content, groupId? } }`, where `content` is the e2e envelope.
 */
object NativeFetchHandler {
    /**
     * A decrypted (or undecryptable) incoming message. `plaintext` is null when `error` is set (a message this device
     * cannot open — a sealed "🔒 Message" notice, left for the app, never acknowledged as stored).
     */
    data class Delivery(
        val type: String,
        val messageId: String,
        val senderId: String,
        val groupId: String?,
        val plaintext: String?,
        val error: String?,
    ) {
        val opened: Boolean get() = plaintext != null
    }

    /** Null when the event is not a message to open. A decrypt failure comes back as a Delivery with `error` set. */
    fun handle(core: CryptoCore, meUserId: String, meDeviceId: String, event: Map<String, Any?>): Delivery? {
        val type = Json.string(event["type"]) ?: return null
        if (type != "message:new" && type != "group:message") return null
        val message = Json.map(event["message"]) ?: return null
        val messageId = Json.string(message["id"]) ?: return null
        val senderId = Json.string(message["senderId"]) ?: return null
        val content = Json.string(message["content"]) ?: return null
        val groupId = Json.string(message["groupId"])
        return try {
            val plaintext = if (type == "group:message") {
                val gid = groupId ?: return Delivery(type, messageId, senderId, null, null, "no-group")
                NativeInbox.openGroup(core, gid, meUserId, meDeviceId, senderId, content)
            } else {
                NativeInbox.openDirect(core, meUserId, meDeviceId, senderId, content)
            }
            Delivery(type, messageId, senderId, groupId, plaintext, null)
        } catch (failed: ProtocolError) {
            Delivery(type, messageId, senderId, groupId, null, failed.code)
        }
    }
}
