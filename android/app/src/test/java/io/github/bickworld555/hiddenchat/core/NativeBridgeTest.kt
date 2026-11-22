package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.HmCryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.MapRecords
import io.github.bickworld555.hiddenchat.core.crypto.SecureRng
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bridge the WebView will call: a full message round trip done entirely through NativeBridge.call (the path all
 * foreground WebView crypto will take), proving it is a drop-in for the web protocol. Also group, prepareUpload,
 * safety number, preview signing, and the error shape.
 */
class NativeBridgeTest {
    private val aliceUser = "1111111111"; private val aliceDev = "alice-dev"
    private val bobUser = "2222222222"; private val bobDev = "bob-dev"

    private fun call(core: HmCryptoCore, method: String, args: Map<String, Any?>) = NativeBridge.call(core, method, args)

    @Test
    fun directRoundTripThroughTheBridge() {
        val alice = HmCryptoCore(MapRecords(), SecureRng)
        val bob = HmCryptoCore(MapRecords(), SecureRng)
        // Bob publishes keys through the bridge; the JS side would POST them and claim bundles. Here we read them back.
        val upload = Json.map(call(bob, "prepareUpload", Json.obj("serverPreKeyCount" to 0L, "now" to 1700000000000L))["result"])!!
        val preKey = Json.list(upload["preKeys"])!![0]
        val bundle = Json.obj("deviceId" to bobDev, "identity" to upload["identity"], "signedPreKey" to upload["signedPreKey"], "preKey" to preKey)

        val devices = mapOf(bobUser to listOf(Json.obj("deviceId" to bobDev)))
        val bundles = mapOf(bobUser to listOf(bundle))
        val entries = Json.map(call(alice, "encryptForDevices", Json.obj("devices" to devices, "plaintext" to "hi via bridge — বাংলা", "bundles" to bundles))["result"])!!

        // What a sender ships: the per-device entry for bob.
        val entry = Json.map(Json.map(entries[bobUser])!![bobDev])!!
        val opened = call(bob, "decryptFromDevice", Json.obj("userId" to aliceUser, "deviceId" to aliceDev, "entry" to entry))
        assertEquals("hi via bridge — বাংলা", Json.string(opened["result"]))
    }

    @Test
    fun groupRoundTripThroughTheBridge() {
        val alice = HmCryptoCore(MapRecords(), SecureRng)
        val bob = HmCryptoCore(MapRecords(), SecureRng)
        val upload = Json.map(call(bob, "prepareUpload", Json.obj("serverPreKeyCount" to 0L))["result"])!!
        val bundles = mapOf(bobUser to listOf(Json.obj("deviceId" to bobDev, "identity" to upload["identity"], "signedPreKey" to upload["signedPreKey"], "preKey" to Json.list(upload["preKeys"])!![0])))
        val members = mapOf(aliceUser to listOf(aliceDev), bobUser to listOf(bobDev))
        val sent = Json.map(call(alice, "encryptGroup", Json.obj("groupId" to "g", "meUserId" to aliceUser, "meDeviceId" to aliceDev, "memberDevices" to members, "plaintext" to "group via bridge", "bundles" to bundles))["result"])!!
        val opened = call(bob, "decryptGroup", Json.obj("groupId" to "g", "meUserId" to bobUser, "meDeviceId" to bobDev, "userId" to aliceUser, "deviceId" to aliceDev, "body" to sent["body"]))
        assertEquals("group via bridge", Json.string(opened["result"]))
    }

    @Test
    fun safetyNumberAndPreviewAndWipeThroughTheBridge() {
        val core = HmCryptoCore(MapRecords(), SecureRng)
        val id = Json.map(call(core, "publicIdentity", Json.obj())["result"])!!
        val sn = call(core, "safetyNumber", Json.obj("mine" to listOf(id), "theirs" to listOf(id)))
        assertTrue("60 digits", Regex("^(\\d{5} ){11}\\d{5}$").matches(Json.string(sn["result"])!!))
        val previewKey = SecureRng.keyPair().pub
        val sig = call(core, "signPreviewKey", Json.obj("previewKey" to io.github.bickworld555.hiddenchat.core.crypto.Primitives.b64(previewKey)))
        assertTrue(Json.string(sig["result"])!!.isNotEmpty())
        assertEquals(true, call(core, "wipe", Json.obj())["ok"])
    }

    @Test
    fun errorsComeBackAsCodesNotThrows() {
        val bob = HmCryptoCore(MapRecords(), SecureRng)
        val reply = call(bob, "decryptFromDevice", Json.obj("userId" to aliceUser, "deviceId" to aliceDev, "entry" to Json.obj("h" to Json.obj("dh" to "x", "pn" to 0L, "n" to 0L), "c" to "AAAA")))
        assertTrue("an error code, not an exception", Json.string(reply["error"]) != null)
        assertNull(reply["result"])
        assertEquals("unknown-method", Json.string(call(bob, "nope", Json.obj())["error"]))
    }
}
