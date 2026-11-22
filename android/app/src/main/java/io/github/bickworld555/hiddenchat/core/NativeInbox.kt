package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.CryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.ProtocolError

/**
 * Opening an incoming message natively (the job the WebView background page does today): parse the end-to-end
 * envelope a `message:new` / `group:message` event carries, find this device's slice, and decrypt it with the
 * installed [CryptoCore]. The plaintext then becomes the notification text and the stored message.
 *
 * Envelope (src/e2e/envelope.js): `e2e2:<routing>|<json>`. For a direct message the json is
 * `{ v:2, sd, d: { [userId]: { [deviceId]: {p?,h,c} } } }`; for a group it is `{ v:2, sd, mh, g, x? }`.
 */
object NativeInbox {
    const val PREFIX = "e2e2:"
    const val VERSION = 2L

    data class Parsed(val routing: String, val senderDeviceId: String, val body: Map<String, Any?>)

    fun isEnvelope(content: String?): Boolean = content != null && content.startsWith(PREFIX)

    /** Splits and validates an envelope. Throws [ProtocolError] "decrypt-failed" when it is not well formed. */
    fun parse(content: String): Parsed {
        if (!isEnvelope(content)) throw ProtocolError("decrypt-failed", "not an envelope")
        val bar = content.indexOf('|')
        if (bar < 0) throw ProtocolError("decrypt-failed", "malformed envelope")
        val routing = content.substring(PREFIX.length, bar)
        val body = try { Json.map(Json.parse(content.substring(bar + 1))) } catch (e: Exception) { null }
            ?: throw ProtocolError("decrypt-failed", "malformed envelope body")
        if (Json.safeInteger(body["v"]) != VERSION) throw ProtocolError("decrypt-failed", "unsupported envelope version")
        val sd = Json.string(body["sd"]) ?: throw ProtocolError("decrypt-failed", "no sender device")
        return Parsed(routing, sd, body)
    }

    /**
     * Opens a direct message addressed to this device. `senderUserId` is the message sender; `meUserId`/`meDeviceId`
     * this device. Returns the plaintext, or throws "not-addressed" when the envelope does not carry a slice for this
     * device, or a [ProtocolError] from the core when it cannot be decrypted.
     */
    fun openDirect(core: CryptoCore, meUserId: String, meDeviceId: String, senderUserId: String, content: String): String {
        val parsed = parse(content)
        val forUser = Json.map(Json.map(parsed.body["d"])?.get(meUserId))
            ?: throw ProtocolError("not-addressed", "this message was not encrypted for this device")
        val entry = Json.map(forUser[meDeviceId])
            ?: throw ProtocolError("not-addressed", "this message was not encrypted for this device")
        return core.decryptFromDevice(senderUserId, parsed.senderDeviceId, entry)
    }

    /** Opens a group message addressed to this device (sender keys, with the distribution it may carry). */
    fun openGroup(core: CryptoCore, groupId: String, meUserId: String, meDeviceId: String, senderUserId: String, content: String): String {
        val parsed = parse(content)
        val groupBody = Json.obj("mh" to parsed.body["mh"], "g" to parsed.body["g"])
        if (parsed.body["x"] != null) groupBody["x"] = parsed.body["x"]
        return core.decryptGroup(groupId, meUserId, meDeviceId, senderUserId, parsed.senderDeviceId, groupBody)
    }
}
