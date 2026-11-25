package io.github.bickworld555.hiddenchat

import android.content.Context
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.crypto.CryptoCores
import io.github.bickworld555.hiddenchat.core.crypto.DeviceList
import io.github.bickworld555.hiddenchat.core.store.NativeStore
import java.util.UUID

/**
 * Fully-native outgoing DIRECT TEXT send (Step 5) — the security-critical half the native UI needs so it does not lean
 * on the WebView to seal messages. A faithful Kotlin port of the web E2E send path:
 *  - devicesOf / trustedDevices (src/e2e/client.js) + verifyDeviceList / pinDecision / listedDevices (deviceList.js):
 *    fetch the recipient's device list, VERIFY its signature, PIN the account key on first sight, refuse a replayed
 *    (rollback) list, and encrypt only to the devices the signed list names — so the server cannot inject a device.
 *  - claimBundles (POST .../bundles) + CryptoCore.encryptForDevices for the ciphertexts.
 *  - buildEnvelope: `e2e2:text|{v,sd,d}` (src/e2e/envelope.js), the exact wire the receiver's NativeInbox opens.
 *  - relay send over the native socket + optimistic local echo.
 *
 * SECURITY-CRITICAL and UNVERIFIED: written without a running comparison, it MUST be reviewed against the web code and
 * validated on two real devices before the native-UI flag is enabled. Scope: direct plain-text only (no groups, media,
 * extras, receipts). TRANSPORT: sends over [NativeSendSocket] (the native UI's own foreground connection) when visible,
 * or [NativeRelay] when backgrounded; the caller falls back to the web relay only if neither native socket is open.
 */
object NativeSend {
    // A base64 P-256 public key (43 bytes -> 86 chars + "=="); a device id. Mirrors deviceList.js KEY / DEVICE_ID.
    private val KEY = Regex("^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$")
    private val DEVICE_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
    private const val MAX_LISTED = 64

    /** Seal `text` to `peerId` (native trust + encryption) and send it over the relay; true only when it went out.
     *  [replyToId] (item 4 replies) is the id of the message being replied to, carried in the inner `r` field. */
    fun sendText(context: Context, peerId: String, text: String, replyToId: String? = null): Boolean {
        // A native socket must be open: the native-owned online socket (socket_owner), the foreground send socket, or
        // the background relay.
        if (!NativeForegroundSocket.isOnline() && !NativeSendSocket.canSend() && !NativeRelay.canSend()) return false
        val inner = linkedMapOf<String, Any?>("c" to text)
        if (!replyToId.isNullOrEmpty()) inner["r"] = replyToId // item 4 replies: same inner field the web uses (client.js)
        val envelope = sealTo(context, peerId, inner) ?: return false

        val messageId = UUID.randomUUID().toString()
        val message = org.json.JSONObject().put("id", messageId).put("receiverId", peerId).put("content", envelope)
        // Prefer the native-owned online socket (socket_owner), then the foreground send socket, then the background relay.
        if (!NativeForegroundSocket.sendMessage(message) && !NativeSendSocket.sendMessage(message) && !NativeRelay.sendMessage(message)) return false

        // Optimistic local echo so the native conversation shows the sent message at once.
        val store = NativeStore.get(context)
        val ts = System.currentTimeMillis()
        val time = java.text.SimpleDateFormat("h:mm a", java.util.Locale.US).format(java.util.Date(ts)).lowercase(java.util.Locale.US)
        try {
            store?.addMessage(peerId, messageId, true, text, time, ts)
            store?.raiseStatusById(messageId, "sent")
            if (!replyToId.isNullOrEmpty()) store?.setReplyTo(peerId, messageId, replyToId)
        } catch (ignored: Throwable) { /* echo only */ }
        return true
    }

    /**
     * Item 4 reactions (SEND): seals "reaction:<emoji>" to [peerId] with the SAME trusted device list + ratchet as a
     * message (web src/e2e: transmitReaction → sealDirect), and sends it as `message:reaction { messageId, emoji }` over
     * the native-owned online socket. [emoji] null removes the reaction (sent unsealed, as the web/server expect).
     * Applies the reaction locally at once. Requires the online socket (the native UI is foreground when reacting).
     */
    fun sendReaction(context: Context, peerId: String, messageId: String, emoji: String?): Boolean {
        if (!NativeForegroundSocket.isOnline()) return false
        val session = RelaySession.read(context) ?: return false
        val meUserId = session.userId ?: return false
        val store = NativeStore.get(context)
        val frame = org.json.JSONObject().put("type", "message:reaction").put("messageId", messageId)
        if (emoji.isNullOrEmpty()) {
            frame.put("emoji", org.json.JSONObject.NULL) // removal: null emoji, the server deletes the reaction
        } else {
            val sealed = sealTo(context, peerId, linkedMapOf<String, Any?>("c" to ("reaction:$emoji"))) ?: return false
            frame.put("emoji", sealed)
        }
        if (!NativeForegroundSocket.sendRawFrame(frame.toString())) return false
        try { store?.addReaction(messageId, meUserId, emoji) } catch (ignored: Throwable) { /* local echo only */ }
        return true
    }

    /**
     * Seals one inner payload to [peerId] using the VERIFIED device list (the trust half below) and the native ratchet,
     * returning the `e2e2:text|{v,sd,d}` envelope, or null on any failure. Shared by [sendText] and [sendReaction] so
     * the device-list trust + sealing lives in exactly one place.
     */
    private fun sealTo(context: Context, peerId: String, inner: LinkedHashMap<String, Any?>): String? {
        val core = CryptoCores.current() ?: return null
        val session = RelaySession.read(context) ?: return null
        val meUserId = session.userId ?: return null
        val meDeviceId = RelaySession.deviceId(context) ?: return null
        val server = NativeServer.from(context) ?: return null
        val store = NativeStore.get(context) ?: return null

        val peer = devicesOf(server, store, peerId)
        if (peer.isEmpty()) return null                     // the contact has no (trusted) keys yet
        val mine = devicesOf(server, store, meUserId).filter { Json.string(Json.map(it)?.get("deviceId")) != meDeviceId }

        val targets = LinkedHashMap<String, Any?>()
        targets[peerId] = peer
        if (mine.isNotEmpty()) targets[meUserId] = mine

        val claim: (String, List<String>) -> List<Any?> = { userId, ids ->
            val res = server.postJson("/api/v1/e2e/users/${enc(userId)}/bundles", linkedMapOf<String, Any?>("deviceIds" to ids))
            Json.list(res?.get("bundles")) ?: emptyList()
        }
        val d = try { core.encryptForDevices(targets, Json.stringify(inner), claim) } catch (failed: Throwable) { return null }
        return "e2e2:text|" + Json.stringify(linkedMapOf<String, Any?>("v" to 2, "sd" to meDeviceId, "d" to d))
    }

    // --- device-list trust (port of client.js devicesOf/trustedDevices + deviceList.js) --------------------------------
    private fun devicesOf(server: NativeServer, store: NativeStore, userId: String): List<Any?> {
        val res = server.getJson("/api/v1/e2e/users/${enc(userId)}/devices") ?: return emptyList()
        val devices = Json.list(res["devices"]) ?: emptyList()
        val signedList = Json.map(res["signedList"])
        return trustedDevices(store, userId, devices, signedList)
    }

    private fun trustedDevices(store: NativeStore, userId: String, devices: List<Any?>, signedList: Map<String, Any?>?): List<Any?> {
        val pin = store.get(pinKey(userId))?.let { runCatching { Json.map(Json.parse(it)) }.getOrNull() }
        if (signedList == null) return if (pin != null) emptyList() else devices   // a list was seen before, now gone -> none
        val verified = verifyDeviceList(signedList, userId) ?: return emptyList()
        when (pinDecision(pin, verified)) {
            "rollback" -> return emptyList()                                       // an older list replayed by the server
            "pin", "changed" -> store.set(pinKey(userId), pinJson(verified))        // first sight, or a new account key
            "same" -> if (verified.counter > pinCounter(pin)) store.set(pinKey(userId), pinJson(verified))
        }
        return listedDevices(devices, verified)
    }

    private class Verified(val accountKey: String, val counter: Long, val devices: Map<String, Pair<String, String>>)

    private fun verifyDeviceList(signed: Map<String, Any?>, userId: String): Verified? {
        val listStr = Json.string(signed["list"]) ?: return null
        val signature = Json.string(signed["signature"]) ?: return null
        if (listStr.length > 32_768) return null
        val value = runCatching { Json.map(Json.parse(listStr)) }.getOrNull() ?: return null
        val v = (value["v"] as? Number)?.toInt()
        val u = Json.string(value["u"])
        val ak = Json.string(value["ak"])
        val n = Json.safeInteger(value["n"])
        val at = Json.safeInteger(value["at"])
        val list = Json.list(value["d"])
        if (v != 1 || u != userId || ak == null || !KEY.matches(ak) || n == null || n < 1 || at == null ||
            list == null || list.isEmpty() || list.size > MAX_LISTED) return null
        val entries = ArrayList<DeviceList.Entry>(list.size)
        val ids = HashSet<String>()
        for (devAny in list) {
            val dev = Json.map(devAny) ?: return null
            val id = Json.string(dev["id"]); val dh = Json.string(dev["dh"]); val sig = Json.string(dev["sig"])
            if (id == null || !DEVICE_ID.matches(id) || dh == null || !KEY.matches(dh) || sig == null || !KEY.matches(sig)) return null
            if (!ids.add(id)) return null
            entries.add(DeviceList.Entry(id, dh, sig))
        }
        if (DeviceList.canonical(u, ak, n, at, entries) != listStr) return null     // one canonical encoding per list
        if (!DeviceList.verify(ak, listStr, signature)) return null                 // signed by the key it names
        return Verified(ak, n, entries.associate { it.id to (it.dh to it.sig) })
    }

    private fun listedDevices(devices: List<Any?>, verified: Verified): List<Any?> = devices.filter { devAny ->
        val dev = Json.map(devAny) ?: return@filter false
        val deviceId = Json.string(dev["deviceId"]) ?: return@filter false
        val identity = Json.map(dev["identity"]) ?: return@filter false
        val entry = verified.devices[deviceId] ?: return@filter false
        Json.string(identity["dh"]) == entry.first && Json.string(identity["sig"]) == entry.second
    }

    private fun pinDecision(pin: Map<String, Any?>?, verified: Verified): String {
        if (pin == null) return "pin"
        if (Json.string(pin["accountKey"]) != verified.accountKey) return "changed"
        return if (verified.counter < pinCounter(pin)) "rollback" else "same"
    }

    private fun pinCounter(pin: Map<String, Any?>?): Long = (pin?.get("counter") as? Number)?.toLong() ?: 0L
    private fun pinJson(verified: Verified) = Json.stringify(linkedMapOf<String, Any?>("accountKey" to verified.accountKey, "counter" to verified.counter))
    private fun pinKey(userId: String) = "device-list-pin:$userId"
    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
}
