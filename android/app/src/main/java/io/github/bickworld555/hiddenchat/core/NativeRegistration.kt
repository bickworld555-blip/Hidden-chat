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
        val serverPreKeyCount = if (published) (Json.safeInteger(status?.get("preKeys")) ?: 0L).toInt() else 0
        val upload = core.prepareUpload(serverPreKeyCount, now)
        val newSpkId = Json.safeInteger(Json.map(upload["signedPreKey"])!!["id"])
        val needKeys = !published || (Json.list(upload["preKeys"])?.isNotEmpty() == true) || Json.safeInteger(status?.get("signedPreKeyId")) != newSpkId
        if (needKeys) transport.putJson("/api/v1/e2e/keys", upload)

        val account = accountKey(store)
        val identity = core.publicIdentity()
        val entry = DeviceList.Entry(deviceId, Json.string(identity["dh"])!!, Json.string(identity["sig"])!!)
        val signed = DeviceList.signList(account, userId, nextCounter(store), now, listOf(entry))
        transport.putJson("/api/v1/e2e/device-list?create=1", signed)
        return true
    }
}
