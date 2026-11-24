package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.CryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.DeviceList
import io.github.bickworld555.hiddenchat.core.crypto.EcKeyPair
import io.github.bickworld555.hiddenchat.core.crypto.KeyRecords
import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P
import io.github.bickworld555.hiddenchat.core.crypto.SecureRng

/** The HTTP the native path needs: authenticated JSON GET/PUT to the account's server. NativeServer backs it; tests fake it. */
interface NativeTransport {
    fun getJson(path: String): Map<String, Any?>?
    fun putJson(path: String, body: Map<String, Any?>): Map<String, Any?>?
}

/**
 * Publishing this device's native keys so others can encrypt to it (the key half of src/e2e/client.js publishKeys +
 * syncDeviceList). The native store is the key owner: the account key is created and kept here, the device keeps its
 * session device id, and a fresh identity under that id is what makes contacts see "security code changed" — the
 * chosen migration. The HTTP transport is injected so the orchestration is unit-tested without a server.
 */
object NativeRegistration {
    private fun str(m: Map<String, Any?>?, key: String) = Json.string(m?.get(key))

    /** The account key (ECDSA P-256), created on first use and kept in the store; contacts pin its public half. */
    fun accountKey(store: KeyRecords): EcKeyPair = store.exclusive {
        store.get("account-key")?.let {
            val m = Json.map(Json.parse(it))!!
            EcKeyPair.fromRaw(P.unb64(Json.string(m["d"])!!), P.unb64(Json.string(m["pub"])!!))
        } ?: run {
            val key = DeviceList.createAccountKey(SecureRng)
            store.set("account-key", Json.stringify(Json.obj("d" to P.b64(P.encodePrivate(key.priv)), "pub" to P.b64(key.pub))))
            key
        }
    }

    private fun nextCounter(store: KeyRecords): Long = store.exclusive {
        val next = (store.get("device-list-counter")?.let { Json.safeInteger(Json.parse(it)) } ?: 0L) + 1
        store.set("device-list-counter", next.toString())
        next
    }

    /**
     * Publishes keys (when missing or stale) and a signed device list naming this device. Returns true when the
     * device is registered. `now` is injectable for tests.
     */
    fun register(core: CryptoCore, store: KeyRecords, userId: String, deviceId: String, transport: NativeTransport, now: Long = System.currentTimeMillis()): Boolean {
        val status = transport.getJson("/api/v1/e2e/keys")
        val published = status?.get("published") == true
        // The native core owns a FRESH identity. On the first native registration for this install it must replace
        // whatever the WebView path (or an earlier identity) published for this device — identity AND prekeys — even
        // when the server's prekey count and signed-prekey id happen to match (the status does not expose the stored
        // identity, so count/spk alone cannot detect the swap). The server deletes the old device + prekeys on an
        // identity change ("security code changed"), so fresh prekeys (serverPreKeyCount 0) must accompany it. Reset
        // by clear() on sign-out, so a later fresh identity re-registers.
        val nativePublished = store.get("native-keys-published") == "done"
        val serverPreKeyCount = if (published && nativePublished) (Json.safeInteger(status?.get("preKeys")) ?: 0L).toInt() else 0
        val upload = core.prepareUpload(serverPreKeyCount, now)
        val newSpkId = Json.safeInteger(Json.map(upload["signedPreKey"])!!["id"])
        val needKeys = !nativePublished || !published || (Json.list(upload["preKeys"])?.isNotEmpty() == true) || Json.safeInteger(status?.get("signedPreKeyId")) != newSpkId
        if (needKeys && transport.putJson("/api/v1/e2e/keys", upload) != null) store.set("native-keys-published", "done")

        // The signed device list is published once per install (a single account key naming this device). Prekey
        // refreshes do not re-sign it; a sign-out (clear) resets this so a fresh identity re-registers.
        if (store.get("list-published") != "done") {
            val account = accountKey(store)
            val identity = core.publicIdentity()
            val entry = DeviceList.Entry(deviceId, Json.string(identity["dh"])!!, Json.string(identity["sig"])!!)
            val signed = DeviceList.signList(account, userId, nextCounter(store), now, listOf(entry))
            // A plain PUT (not create=1): the native path takes over the account with its own account key, replacing
            // whatever list the WebView path published (the server rejects create=1 when a list already exists, and a
            // rotation under a new account key is accepted). A truly first list is also created by this same PUT.
            if (transport.putJson("/api/v1/e2e/device-list", signed) != null) store.set("list-published", "done")
        }
        return true
    }

    /**
     * Publishes this device's notification preview public key, signed by its identity (src/e2e/client.js
     * publishPreviewKey), once per key — so a push can carry a sealed preview the native side opens (PreviewKey),
     * without the WebView publishing it. The key comes from Android (PreviewKey) and is passed in so this stays
     * Android-free and unit-testable. A no-op when there is no key; idempotent for the same key + identity.
     */
    fun publishPreviewKey(core: CryptoCore, store: KeyRecords, userId: String, deviceId: String, previewKey: String?, transport: NativeTransport): Boolean {
        if (previewKey.isNullOrEmpty()) return false
        val identitySig = Json.string(core.publicIdentity()["sig"]) ?: ""
        val marker = "$previewKey|$identitySig"
        val markKey = "e2e:preview-key:$userId:$deviceId"
        if (store.get(markKey) == marker) return true
        val signature = core.signPreviewKey(previewKey)
        return if (transport.putJson("/api/v1/e2e/preview-key", Json.obj("key" to previewKey, "signature" to signature)) != null) {
            store.set(markKey, marker)
            true
        } else {
            false
        }
    }
}
