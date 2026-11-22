package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Signed device lists conform to the web protocol (src/e2e/deviceList.js), from the recorded vector: the canonical
 * list string is byte-identical, the recorded (web-made) signature verifies here, and a signature made here verifies
 * too. (ECDSA is randomized, so signatures are not byte-stable — verification is the equivalence, as for Sender Keys.)
 */
class DeviceListTest {
    private val vectors: Map<String, Any?> by lazy {
        val stream = javaClass.getResourceAsStream("/e2e-vectors.json")
        requireNotNull(stream) { "e2e-vectors.json missing — run: node scripts/e2e-native-vectors.mjs" }
        Json.map(Json.parse(stream.readBytes().toString(Charsets.UTF_8)))!!
    }
    private fun m(v: Any?) = Json.map(v)!!
    private fun s(v: Any?) = Json.string(v)!!

    @Test
    fun canonicalListAndSignatureMatchWebProtocol() {
        val dl = m(vectors["deviceList"])
        val accountKeyV = m(dl["accountKey"])
        val accountKeyB64 = P.b64(ReplayRng.hex(s(accountKeyV["pub"])))
        val devices = Json.list(dl["devices"])!!.map {
            val d = m(it); val id = m(d["identity"])
            DeviceList.Entry(s(d["deviceId"]), s(id["dh"]), s(id["sig"]))
        }
        val canonical = DeviceList.canonical(s(dl["userId"]), accountKeyB64, Json.safeInteger(dl["counter"])!!, Json.safeInteger(dl["at"])!!, devices)
        assertEquals("canonical list is byte-for-byte", s(dl["list"]), canonical)
        assertTrue("the recorded (web-made) signature verifies", DeviceList.verify(accountKeyB64, canonical, s(dl["signature"])))
        assertEquals("CONTEXT matches the web constant", s(dl["context"]), DeviceList.CONTEXT)

        // A signature made here (with the recorded account private key) verifies too.
        val accountKey = EcKeyPair.fromRaw(ReplayRng.hex(s(accountKeyV["d"])), ReplayRng.hex(s(accountKeyV["pub"])))
        val signed = DeviceList.signList(accountKey, s(dl["userId"]), Json.safeInteger(dl["counter"])!!, Json.safeInteger(dl["at"])!!, devices)
        assertEquals("built list equals the canonical", canonical, s(signed["list"]))
        assertTrue("native signature verifies", DeviceList.verify(accountKeyB64, canonical, s(signed["signature"])))
        assertFalse("a tampered list does not verify", DeviceList.verify(accountKeyB64, canonical + " ", s(signed["signature"])))
    }

    @Test
    fun devicesAreSortedById() {
        val key = DeviceList.createAccountKey(SecureRng)
        val a = DeviceList.Entry("dev-z", "AA", "BB")
        val b = DeviceList.Entry("dev-a", "CC", "DD")
        val list = DeviceList.canonical("u1", P.b64(key.pub), 1, 2, listOf(a, b))
        assertTrue("dev-a is listed before dev-z regardless of input order", list.indexOf("dev-a") < list.indexOf("dev-z"))
    }
}
