package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.DeviceList
import io.github.bickworld555.hiddenchat.core.crypto.HmCryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.MapRecords
import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P
import io.github.bickworld555.hiddenchat.core.crypto.SecureRng
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Native key publish: the registration builds a valid key upload and a device list signed by the account key. */
class NativeRegistrationTest {
    private class FakeTransport(private val status: Map<String, Any?>?) : NativeTransport {
        val puts = mutableListOf<Pair<String, Map<String, Any?>>>()
        override fun getJson(path: String): Map<String, Any?>? = status
        override fun putJson(path: String, body: Map<String, Any?>): Map<String, Any?>? { puts.add(path to body); return Json.obj("ok" to true) }
    }

    @Test
    fun publishesKeysAndSignedDeviceList() {
        val store = MapRecords()
        val core = HmCryptoCore(store, SecureRng)
        val transport = FakeTransport(status = null) // not published yet
        val userId = "2222222222"; val deviceId = "bob-dev"

        NativeRegistration.register(core, store, userId, deviceId, transport, 1700000000000L)

        val keys = transport.puts.first { it.first == "/api/v1/e2e/keys" }.second
        val identity = Json.map(keys["identity"])!!
        assertTrue("identity published", identity["dh"] is String && identity["sig"] is String)
        assertTrue("signed prekey published", Json.map(keys["signedPreKey"]) != null)
        assertTrue("one-time prekeys for a fresh device", (Json.list(keys["preKeys"])?.size ?: 0) > 0)

        val dl = transport.puts.first { it.first.startsWith("/api/v1/e2e/device-list") }.second
        val list = Json.string(dl["list"])!!
        val signature = Json.string(dl["signature"])!!
        val account = NativeRegistration.accountKey(store)
        assertTrue("device list is signed by the account key", DeviceList.verify(P.b64(account.pub), list, signature))
        assertTrue("the list names this device", list.contains(deviceId))
        assertTrue("with this device's identity", list.contains(Json.string(core.publicIdentity()["dh"])!!))
    }

    @Test
    fun skipsKeyUploadWhenAlreadyPublishedAndStocked() {
        val store = MapRecords()
        val core = HmCryptoCore(store, SecureRng)
        // Publish once so the signed-prekey id and prekey stock are known.
        val first = FakeTransport(status = null)
        NativeRegistration.register(core, store, "2222222222", "bob-dev", first, 1700000000000L)
        val spkId = Json.safeInteger(Json.map(first.puts.first { it.first == "/api/v1/e2e/keys" }.second["signedPreKey"])!!["id"])
        assertEquals("device list published once on the first run", 1, first.puts.count { it.first.startsWith("/api/v1/e2e/device-list") })
        // Second run: server reports published, plenty of prekeys, same signed prekey → no key upload, and the device
        // list is not re-signed (already published once).
        val second = FakeTransport(status = Json.obj("published" to true, "preKeys" to 100L, "signedPreKeyId" to spkId))
        NativeRegistration.register(core, store, "2222222222", "bob-dev", second, 1700000100000L)
        assertEquals("no key upload when already stocked", 0, second.puts.count { it.first == "/api/v1/e2e/keys" })
        assertEquals("device list not re-published", 0, second.puts.count { it.first.startsWith("/api/v1/e2e/device-list") })
    }
}
