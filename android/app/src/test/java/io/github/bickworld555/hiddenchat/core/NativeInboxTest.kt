package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.HmCryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.MapRecords
import io.github.bickworld555.hiddenchat.core.crypto.ProtocolError
import io.github.bickworld555.hiddenchat.core.crypto.SecureRng
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The native receive path (NativeInbox) opens a real end-to-end envelope through the CryptoCore — the decrypt-on-push
 * work the WebView background page does today, now in Kotlin. Round-trips a direct and a group message through two
 * cores, and checks the not-addressed / malformed cases.
 */
class NativeInboxTest {
    private val aliceUser = "1111111111"; private val aliceDev = "alice-dev"
    private val bobUser = "2222222222"; private val bobDev = "bob-dev"

    private fun pair(): Triple<HmCryptoCore, HmCryptoCore, (String, List<String>) -> List<Any?>> {
        val alice = HmCryptoCore(MapRecords(), SecureRng)
        val bob = HmCryptoCore(MapRecords(), SecureRng)
        val upload = bob.prepareUpload(0, 1700000000000L)
        val preKeys = Json.list(upload["preKeys"])!!
        var next = 0
        val claim: (String, List<String>) -> List<Any?> = { _, ids ->
            ids.map { Json.obj("deviceId" to it, "identity" to upload["identity"], "signedPreKey" to upload["signedPreKey"], "preKey" to preKeys[next++]) }
        }
        return Triple(alice, bob, claim)
    }

    private fun directEnvelope(entries: Map<String, Any?>): String =
        NativeInbox.PREFIX + "text|" + Json.stringify(Json.obj("v" to 2L, "sd" to aliceDev, "d" to entries))

    @Test
    fun opensADirectMessage() {
        val (alice, bob, claim) = pair()
        val devices = mapOf(bobUser to listOf(Json.obj("deviceId" to bobDev)))
        val entries = alice.encryptForDevices(devices, "hello native — বাংলা", claim)
        val content = directEnvelope(entries)
        assertEquals("hello native — বাংলা", NativeInbox.openDirect(bob, bobUser, bobDev, aliceUser, content))
    }

    @Test
    fun opensAGroupMessage() {
        val (alice, bob, claim) = pair()
        val members = mapOf(aliceUser to listOf(aliceDev), bobUser to listOf(bobDev))
        val sent = alice.encryptGroup("grp-1", aliceUser, aliceDev, members, "group native line", claim)
        val body = Json.map(sent["body"])!!
        val env = Json.obj("v" to 2L, "sd" to aliceDev, "mh" to body["mh"], "g" to body["g"])
        if (body["x"] != null) env["x"] = body["x"]
        val content = NativeInbox.PREFIX + "text|" + Json.stringify(env)
        assertEquals("group native line", NativeInbox.openGroup(bob, "grp-1", bobUser, bobDev, aliceUser, content))
    }

    @Test
    fun rejectsAMessageNotForThisDevice() {
        val (alice, bob, claim) = pair()
        val entries = alice.encryptForDevices(mapOf(bobUser to listOf(Json.obj("deviceId" to bobDev))), "x", claim)
        val content = directEnvelope(entries)
        // A different device id on this account has no slice.
        val error = runCatching { NativeInbox.openDirect(bob, bobUser, "other-dev", aliceUser, content) }.exceptionOrNull()
        assertTrue("not-addressed", error is ProtocolError && error.code == "not-addressed")
    }

    @Test
    fun rejectsMalformedEnvelopes() {
        for (bad in listOf("not an envelope", "e2e2:text", "e2e2:text|{not json}", "e2e2:text|{\"v\":1}")) {
            assertTrue("rejected: $bad", runCatching { NativeInbox.parse(bad) }.exceptionOrNull() is ProtocolError)
        }
        assertTrue(NativeInbox.isEnvelope("e2e2:text|{}"))
        assertTrue(!NativeInbox.isEnvelope("plain text"))
    }
}
