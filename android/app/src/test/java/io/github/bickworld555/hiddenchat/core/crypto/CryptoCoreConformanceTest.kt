package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Conformance of the [HmCryptoCore] orchestration (CryptoCore interface) against the web protocol.
 *  - The recorded encryptForDevices → decryptFromDevice transcript (directInterface) is replayed through two cores
 *    fed the recorded randomness, and the per-device { p, h, c } entries come out byte-for-byte, the plaintexts open.
 *  - The safety number matches the recorded value.
 *  - A full group round trip (encryptGroup → decryptGroup, distribution sealed over the direct sessions) and the
 *    preview-key signature are checked for self-consistency.
 */
class CryptoCoreConformanceTest {
    private val vectors: Map<String, Any?> by lazy {
        val stream = javaClass.getResourceAsStream("/e2e-vectors.json")
        requireNotNull(stream) { "e2e-vectors.json missing — run: node scripts/e2e-native-vectors.mjs" }
        Json.map(Json.parse(stream.readBytes().toString(Charsets.UTF_8)))!!
    }
    private fun m(v: Any?) = Json.map(v)!!
    private fun s(v: Any?) = Json.string(v)!!

    private fun seedIdentity(records: KeyRecords, identityV: Map<String, Any?>) {
        fun key(part: Map<String, Any?>) = Json.obj("d" to P.b64(ReplayRng.hex(s(part["d"]))), "pub" to P.b64(ReplayRng.hex(s(part["pub"]))))
        records.set("identity", Json.stringify(Json.obj("dh" to key(m(identityV["dh"])), "sig" to key(m(identityV["sig"])), "createdAt" to 1L)))
    }

    private fun assertEntryEquals(label: String, expected: Map<String, Any?>, actual: Map<String, Any?>) {
        assertEquals("$label ciphertext", s(expected["c"]), s(actual["c"]))
        val eh = m(expected["h"]); val ah = m(actual["h"])
        assertEquals("$label header.dh", s(eh["dh"]), s(ah["dh"]))
        assertEquals("$label header.pn", Json.safeInteger(eh["pn"]), Json.safeInteger(ah["pn"]))
        assertEquals("$label header.n", Json.safeInteger(eh["n"]), Json.safeInteger(ah["n"]))
        val ep = Json.map(expected["p"]); val ap = Json.map(actual["p"])
        if (ep != null) {
            requireNotNull(ap) { "$label expected a prekey header" }
            assertEquals("$label p.ek", s(ep["ek"]), s(ap["ek"]))
            assertEquals("$label p.spk", Json.safeInteger(ep["spk"]), Json.safeInteger(ap["spk"]))
            assertEquals("$label p.opk", Json.safeInteger(ep["opk"]), Json.safeInteger(ap["opk"]))
            assertEquals("$label p.ik.dh", s(m(ep["ik"])["dh"]), s(m(ap["ik"])["dh"]))
            assertEquals("$label p.ik.sig", s(m(ep["ik"])["sig"]), s(m(ap["ik"])["sig"]))
        }
    }

    @Test
    fun directInterfaceReplayByteForByte() {
        val di = m(vectors["directInterface"])
        val aliceRec = MapRecords(); val bobRec = MapRecords()
        seedIdentity(aliceRec, m(m(di["alice"])["identity"]))
        seedIdentity(bobRec, m(m(di["bob"])["identity"]))
        val alice = HmCryptoCore(aliceRec, ReplayRng(m(di["alice"])))
        val bob = HmCryptoCore(bobRec, ReplayRng(m(di["bob"])))

        val aliceUser = s(di["aliceUser"]); val aliceDev = s(di["aliceDev"])
        val bobUser = s(di["bobUser"]); val bobDev = s(di["bobDev"])

        // Bob publishes keys first. serverPreKeyCount 99 is at/above the low-water mark, so NO one-time prekey is
        // generated (as in the recording) and the bundle has none — X3DH runs 3-DH, exactly as recorded.
        val bobUpload = bob.prepareUpload(99, 1700000000000L)
        val preKeys = Json.list(bobUpload["preKeys"])!!
        val bundle = Json.obj("deviceId" to bobDev, "identity" to bobUpload["identity"], "signedPreKey" to bobUpload["signedPreKey"])
        if (preKeys.isNotEmpty()) bundle["preKey"] = preKeys[0]
        val claim: (String, List<String>) -> List<Any?> = { _, _ -> listOf(bundle) }
        val devices = m(di["devices"])
        val messages = Json.list(di["messages"])!!.map { m(it) }

        // Interleave exactly as recorded: alice enc0, bob dec0, alice enc1, bob dec1.
        val out0 = alice.encryptForDevices(devices, s(messages[0]["plaintext"]), claim)
        assertEntryEquals("msg0", m(messages[0]["entry"]), m(m(out0[bobUser])[bobDev]))
        assertEquals("msg0 opens", s(messages[0]["plaintext"]), bob.decryptFromDevice(aliceUser, aliceDev, m(messages[0]["entry"])))

        val out1 = alice.encryptForDevices(devices, s(messages[1]["plaintext"]), claim)
        assertEntryEquals("msg1", m(messages[1]["entry"]), m(m(out1[bobUser])[bobDev]))
        assertEquals("msg1 opens", s(messages[1]["plaintext"]), bob.decryptFromDevice(aliceUser, aliceDev, m(messages[1]["entry"])))
    }

    @Test
    fun safetyNumberMatchesRecorded() {
        val sn = m(vectors["safetyNumber"])
        @Suppress("UNCHECKED_CAST")
        val mine = (Json.list(sn["mine"])!!.map { m(it) }) as List<Map<String, Any?>>
        @Suppress("UNCHECKED_CAST")
        val theirs = (Json.list(sn["theirs"])!!.map { m(it) }) as List<Map<String, Any?>>
        val core = HmCryptoCore(MapRecords(), SecureRng)
        assertEquals(s(sn["expected"]), core.safetyNumber(mine, theirs))
        assertEquals("order-independent", s(sn["reversed"]), core.safetyNumber(theirs, mine))
    }

    @Test
    fun signPreviewKeyVerifiesUnderIdentity() {
        val core = HmCryptoCore(MapRecords(), SecureRng)
        val identity = core.publicIdentity()
        val previewKey = SecureRng.keyPair().pub
        val signature = core.signPreviewKey(P.b64(previewKey))
        val statement = P.concat(P.utf8("hm-preview-key-v1|"), previewKey)
        assertTrue("preview key signature verifies under the device identity", P.verify(P.unb64(s(identity["sig"])), statement, P.unb64(signature)))
    }

    @Test
    fun groupRoundTripThroughTheInterface() {
        val alice = HmCryptoCore(MapRecords(), SecureRng)
        val bob = HmCryptoCore(MapRecords(), SecureRng)
        val groupId = "group-core-1"
        val aliceUser = "1111111111"; val aliceDev = "alice-dev"
        val bobUser = "2222222222"; val bobDev = "bob-dev"

        val bobUpload = bob.prepareUpload(0, 1700000000000L)
        val preKeys = Json.list(bobUpload["preKeys"])!!
        var next = 0
        val claim: (String, List<String>) -> List<Any?> = { _, ids ->
            ids.map { Json.obj("deviceId" to it, "identity" to bobUpload["identity"], "signedPreKey" to bobUpload["signedPreKey"], "preKey" to preKeys[next++]) }
        }
        val members = mapOf(aliceUser to listOf(aliceDev), bobUser to listOf(bobDev))
        val sent = alice.encryptGroup(groupId, aliceUser, aliceDev, members, "group hello — বাংলা", claim)
        val opened = bob.decryptGroup(groupId, bobUser, bobDev, aliceUser, aliceDev, m(sent["body"]))
        assertEquals("group hello — বাংলা", opened)

        // A second message reuses the sender key (same member set); confirm the distribution, then send again.
        alice.confirmGroupSend(groupId, s(sent["keyId"]))
        val sent2 = alice.encryptGroup(groupId, aliceUser, aliceDev, members, "second group line", claim)
        assertEquals("second group line", bob.decryptGroup(groupId, bobUser, bobDev, aliceUser, aliceDev, m(sent2["body"])))
    }
}
