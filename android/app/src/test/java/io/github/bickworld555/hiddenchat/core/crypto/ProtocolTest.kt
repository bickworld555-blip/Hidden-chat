package io.github.bickworld555.hiddenchat.core.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Self-consistency of the X3DH + Double Ratchet + Sender Keys state machines, with real randomness (SecureRng): the
 * 12-step ratchet scenario from docs/native/CRYPTO-CORE-INTEGRATION.md (out-of-order delivery, a DH turn, replay and
 * tamper rejection, state persistence, the skip limit), then the group scenario. This proves the machines agree with
 * themselves; byte-for-byte agreement with the web protocol is a separate check (RatchetConformanceTest).
 * Converted from the author's standalone ProtocolTest; reuses the shared ProtocolError.
 */
class ProtocolTest {
    private val rng = SecureRng
    private fun t(s: String) = s.toByteArray()
    private fun fails(block: () -> Unit) = runCatching(block).isFailure

    @Test
    fun x3dhAndDoubleRatchetScenario() {
        val alice = IdentityKeys(rng.keyPair(), rng.keyPair())
        val bob = IdentityKeys(rng.keyPair(), rng.keyPair())
        val bobSpk = rng.keyPair(); val bobOpk = rng.keyPair()
        val bundle = PreKeyBundle(bob.dh.pub, bob.sig.pub, 1, bobSpk.pub, X3dh.signSignedPreKey(bob, bobSpk.pub), 7, bobOpk.pub)

        val init = X3dh.initiate(alice, bundle, rng)
        val resp = X3dh.respond(bob, alice.dh.pub, alice.sig.pub, init.ephemeralPub, bobSpk, bobOpk)
        assertTrue("X3DH shared secret matches", init.sharedSecret.contentEquals(resp.sharedSecret))
        assertTrue("X3DH ad matches (260 bytes)", init.ad.contentEquals(resp.ad) && init.ad.size == 260)
        val forged = PreKeyBundle(bob.dh.pub, bob.sig.pub, 1, bobSpk.pub, X3dh.signSignedPreKey(alice, bobSpk.pub), null, null)
        assertTrue("forged signed prekey rejected", fails { X3dh.initiate(alice, forged, rng) })

        var a = DoubleRatchet.initInitiator(init, rng)
        var b = DoubleRatchet.initResponder(resp, bobSpk)
        fun aEnc(m: String): RatchetMessage = DoubleRatchet.encrypt(a, t(m)).also { a = it.first }.second
        fun bEnc(m: String): RatchetMessage = DoubleRatchet.encrypt(b, t(m)).also { b = it.first }.second
        fun bDec(m: RatchetMessage) = String(DoubleRatchet.decrypt(b, m.header, m.ciphertext, rng).also { b = it.first }.second)
        fun aDec(m: RatchetMessage) = String(DoubleRatchet.decrypt(a, m.header, m.ciphertext, rng).also { a = it.first }.second)

        val m1 = aEnc("m1"); val m2 = aEnc("m2"); val m3 = aEnc("m3")
        assertEquals("Bob opens m1", "m1", bDec(m1))
        assertEquals("Bob opens m3", "m3", bDec(m3))
        assertEquals("skipped key stored", 1, b.skipped.size)
        assertEquals("Bob opens m2 (skipped key)", "m2", bDec(m2))
        assertTrue("replay of m2 rejected", fails { bDec(m2) })
        val r1 = bEnc("r1"); val r2 = bEnc("r2")
        assertEquals("Alice opens r1 (DH turn)", "r1", aDec(r1))
        assertEquals("Alice opens r2", "r2", aDec(r2))
        val m4 = aEnc("m4")
        assertTrue("m4 carries new ratchet key + pn=3", m4.header.dh != m1.header.dh && m4.header.pn == 3 && m4.header.n == 0)
        assertEquals("Bob opens m4 (DH turn)", "m4", bDec(m4))

        assertEquals("header bytes form", "[\"${m4.header.dh}\",3,0]", String(m4.header.bytes()))

        val m5 = aEnc("m5")
        val before = b
        val bad = m5.ciphertext.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertTrue("tampered ciphertext rejected", fails { DoubleRatchet.decrypt(b, m5.header, bad, rng) })
        assertSame("state unchanged after failure", before, b)
        assertEquals("real m5 still opens", "m5", bDec(m5))
        assertTrue("tampered header rejected", fails {
            DoubleRatchet.decrypt(b, RatchetHeader(m5.header.dh, m5.header.pn, m5.header.n + 1), m5.ciphertext, rng)
        })

        val b2 = RatchetState.fromMap(b.toMap())
        val m6 = aEnc("m6")
        assertEquals("state survives toMap/fromMap", "m6", String(DoubleRatchet.decrypt(b2, m6.header, m6.ciphertext, rng).second))

        repeat(DoubleRatchet.MAX_SKIP + 1) { aEnc("x") }
        val far = aEnc("far")
        assertTrue("MAX_SKIP enforced", fails { bDec(far) })
    }

    @Test
    fun senderKeysScenario() {
        var own = SenderKeys.create("group-1", "hash", rng)
        var inb = SenderKeys.accept(SenderKeyDistribution.fromMap(own.distribution().toMap()))
        val sender = "alice/1"
        fun gEnc(s: String) = SenderKeys.encrypt(own, sender, t(s)).also { own = it.first }.second
        fun gDec(m: SenderKeyMessage) = String(SenderKeys.decrypt(inb, sender, m).also { inb = it.first }.second)
        val g1 = gEnc("g1"); val g2 = gEnc("g2"); val g3 = gEnc("g3")
        assertEquals("group g1", "g1", gDec(g1))
        assertEquals("group g3 (skip)", "g3", gDec(g3))
        assertEquals("group g2 (skipped key)", "g2", gDec(g2))
        assertTrue("group replay rejected", fails { gDec(g2) })
        val g4 = gEnc("g4")
        assertTrue("wrong sender address rejected", fails { SenderKeys.decrypt(inb, "mallory/1", g4) })
        val g4bad = SenderKeyMessage(g4.kid, g4.n, g4.c.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }, g4.s)
        assertTrue("tampered group ciphertext rejected", fails { SenderKeys.decrypt(inb, sender, g4bad) })
        assertEquals("wire round trip + open g4", "g4", gDec(SenderKeyMessage.fromMap(g4.toMap())))
        assertTrue("kid is base64(12 bytes): 16 chars", Regex("^[A-Za-z0-9+/]{16}$").matches(g4.kid))
        assertTrue("unknown kid -> no-sender-key", runCatching {
            SenderKeys.decrypt(inb, sender, SenderKeyMessage("AAAAAAAAAAAAAAAA", 9, g4.c, g4.s))
        }.exceptionOrNull().let { it is ProtocolError && it.code == "no-sender-key" })
        assertTrue("confirm drops initial chain key", fails { own.confirmed().distribution() })
    }

    @Test
    fun jsonEscapesMatchJavaScript() {
        // kid is a string in the AD now (JS parity): JSON.stringify(["hm-sk-v1", groupId, senderAddress, keyId, n]).
        assertEquals(
            "[\"hm-sk-v1\",\"g\\\"\\n\\u0001\",\"a/1\",\"kid0000000000000\",2]",
            String(SenderKeys.ad("g\"\n\u0001", "a/1", "kid0000000000000", 2)),
        )
    }
}
