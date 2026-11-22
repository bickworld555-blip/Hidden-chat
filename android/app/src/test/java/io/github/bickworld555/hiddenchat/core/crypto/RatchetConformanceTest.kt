package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Byte-for-byte conformance of the native X3DH + Double Ratchet against the web protocol (src/e2e/), replayed from
 * the recorded transcript in e2e-vectors.json (scripts/e2e-native-vectors.mjs). Both parties' recorded key material
 * and random draws are fed through [ReplayRng], the recorded 12-step order is driven, and every produced header and
 * ciphertext must equal the recording, every decrypt must return the recorded plaintext. If this is green, a message
 * this native code seals opens on a device still running the web code, and the other way round.
 *
 * (The Double Ratchet carries no per-message signature, so its ciphertexts are deterministic given the keys and
 * reproducible here. Sender Keys sign each message with randomized ECDSA, so their signatures are not byte-stable;
 * their conformance is handled separately.)
 */
class RatchetConformanceTest {
    private val vectors: Map<String, Any?> by lazy {
        val stream = javaClass.getResourceAsStream("/e2e-vectors.json")
        requireNotNull(stream) { "e2e-vectors.json missing — run: node scripts/e2e-native-vectors.mjs" }
        Json.map(Json.parse(stream.readBytes().toString(Charsets.UTF_8)))!!
    }

    private fun m(v: Any?) = Json.map(v)!!
    private fun s(v: Any?) = Json.string(v)!!
    private fun i(v: Any?) = Json.safeInteger(v)!!.toInt()
    private fun keyFrom(entry: Any?): EcKeyPair { val k = m(entry); return EcKeyPair.fromRaw(ReplayRng.hex(s(k["d"])), ReplayRng.hex(s(k["pub"]))) }
    private fun toHex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    @Test
    fun x3dhAndDoubleRatchetMatchWebProtocolByteForByte() {
        val ratchet = m(vectors["ratchet"])
        val aliceV = m(ratchet["alice"])
        val bobV = m(ratchet["bob"])
        val bundleV = m(ratchet["bundle"])
        val adV = m(ratchet["ad"])

        val aliceIdentity = IdentityKeys(keyFrom(m(aliceV["identity"])["dh"]), keyFrom(m(aliceV["identity"])["sig"]))
        val bobIdentity = IdentityKeys(keyFrom(m(bobV["identity"])["dh"]), keyFrom(m(bobV["identity"])["sig"]))
        val bobSpk = keyFrom(bobV["signedPreKey"])
        val bobOpk = keyFrom(bobV["preKey"])

        val spkV = m(bundleV["signedPreKey"])
        val opkV = m(bundleV["preKey"])
        val bundle = PreKeyBundle(
            identityDh = P.unb64(s(m(bundleV["identity"])["dh"])),
            identitySig = P.unb64(s(m(bundleV["identity"])["sig"])),
            signedPreKeyId = i(spkV["id"]),
            signedPreKey = P.unb64(s(spkV["key"])),
            signedPreKeySignature = P.unb64(s(spkV["signature"])),
            preKeyId = i(opkV["id"]),
            preKey = P.unb64(s(opkV["key"])),
        )

        val aliceRng = ReplayRng(aliceV)
        val bobRng = ReplayRng(bobV)

        // --- X3DH both sides, checked against the recorded secret and associated data ---
        val init = X3dh.initiate(aliceIdentity, bundle, aliceRng)
        assertEquals("recorded shared secret (initiator)", s(ratchet["sharedSecret"]), toHex(init.sharedSecret))
        assertEquals("recorded ephemeral public key", s(m(ratchet["preKeyHeader"])["ek"]), P.b64(init.ephemeralPub))
        assertEquals("recorded associated data (initiator side)", s(adV["aliceSide"]), toHex(init.ad))
        var a = DoubleRatchet.initInitiator(init, aliceRng)

        val resp = X3dh.respond(bobIdentity, aliceIdentity.dh.pub, aliceIdentity.sig.pub, init.ephemeralPub, bobSpk, bobOpk)
        assertEquals("recorded shared secret (responder)", s(ratchet["sharedSecret"]), toHex(resp.sharedSecret))
        assertEquals("recorded associated data (responder side)", s(adV["bobSide"]), toHex(resp.ad))
        var b = DoubleRatchet.initResponder(resp, bobSpk)

        // --- drive the recorded order; every output is asserted against the recording ---
        val steps = (Json.list(ratchet["steps"]) ?: emptyList()).map { m(it) }
        fun step(name: String) = steps.first { s(it["name"]) == name }
        val order = (Json.list(ratchet["order"]) ?: emptyList()).map { s(it) }

        for (entry in order) {
            if (entry.startsWith("send ")) {
                val st = step(entry.removePrefix("send "))
                val produced: RatchetMessage
                if (s(st["from"]) == "alice") { val r = DoubleRatchet.encrypt(a, P.utf8(s(st["plaintext"]))); a = r.first; produced = r.second }
                else { val r = DoubleRatchet.encrypt(b, P.utf8(s(st["plaintext"]))); b = r.first; produced = r.second }
                val h = m(st["header"])
                assertEquals("${s(st["name"])} header.dh", s(h["dh"]), produced.header.dh)
                assertEquals("${s(st["name"])} header.pn", i(h["pn"]), produced.header.pn)
                assertEquals("${s(st["name"])} header.n", i(h["n"]), produced.header.n)
                assertEquals("${s(st["name"])} ciphertext byte-for-byte", s(st["ciphertext"]), P.b64(produced.ciphertext))
            } else { // "<who> opens <name>"
                val who = entry.substringBefore(" opens ")
                val st = step(entry.substringAfter("opens ").trim())
                val h = m(st["header"])
                val header = RatchetHeader(s(h["dh"]), i(h["pn"]), i(h["n"]))
                val ct = P.unb64(s(st["ciphertext"]))
                val plain: ByteArray
                if (who == "bob") { val r = DoubleRatchet.decrypt(b, header, ct, bobRng); b = r.first; plain = r.second }
                else { val r = DoubleRatchet.decrypt(a, header, ct, aliceRng); a = r.first; plain = r.second }
                assertEquals("$entry plaintext", s(st["plaintext"]), String(plain, Charsets.UTF_8))
            }
        }

        assertTrue("all of Alice's recorded keys were consumed in the recorded order", aliceRng.keysConsumed == aliceRng.keyCount)
        assertTrue("all of Bob's recorded keys were consumed in the recorded order", bobRng.keysConsumed == bobRng.keyCount)
    }

    @Test
    fun senderKeysMatchWebProtocolByteForByte() {
        val sk = m(vectors["senderKeys"])
        val groupId = s(sk["groupId"]); val memberHash = s(sk["membersHash"]); val sender = s(sk["senderAddress"])
        val dist = m(sk["distribution"])
        val messages = (Json.list(sk["messages"]) ?: emptyList()).map { m(it) }

        // Encrypt direction: the distribution and each ciphertext come out byte-for-byte (the per-message signature is
        // randomized ECDSA, so it is verified on decrypt below, not equated here).
        val aliceRng = ReplayRng(m(sk["alice"]))
        var own = SenderKeys.create(groupId, memberHash, aliceRng)
        val producedDist = own.distribution()
        assertEquals("recorded kid (base64 of 12 bytes)", s(dist["kid"]), producedDist.kid)
        assertEquals("recorded chain key", s(dist["ck"]), P.b64(producedDist.chainKey))
        assertEquals("recorded signing public key", s(dist["sp"]), P.b64(producedDist.signingPub))
        for (mm in messages) {
            val msgV = m(mm["message"])
            val r = SenderKeys.encrypt(own, sender, P.utf8(s(mm["plaintext"]))); own = r.first
            assertEquals("kid on the wire", s(msgV["kid"]), r.second.kid)
            assertEquals("group ciphertext byte-for-byte (n=${r.second.n})", s(msgV["c"]), P.b64(r.second.c))
        }

        // Decrypt direction: the web-sealed group messages (real JS signatures) open here in the recorded
        // out-of-order sequence — proof a native client reads web/desktop group messages.
        var inb = SenderKeys.accept(SenderKeyDistribution.fromMap(dist))
        for (idx in (Json.list(sk["bobOrder"]) ?: emptyList()).map { i(it) }) {
            val mm = messages[idx]
            val r = SenderKeys.decrypt(inb, sender, SenderKeyMessage.fromMap(m(mm["message"]))); inb = r.first
            assertEquals("web group message opens (index $idx)", s(mm["plaintext"]), String(r.second, Charsets.UTF_8))
        }
    }
}
