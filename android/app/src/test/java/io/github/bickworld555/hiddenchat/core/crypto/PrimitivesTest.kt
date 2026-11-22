package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.crypto.Primitives as Pr
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Standalone check of the primitives against the published standard vectors — RFC 5869 (HKDF), RFC 5903 §8.1 (P-256
 * ECDH) and RFC 6979 A.2.5 (ECDSA P-256/SHA-256) — plus the project's own encoding rules. Mirrors the JavaScript
 * checks in server/e2e-vectors.test.mjs, so the Kotlin primitives are shown to compute the same standard algorithms.
 * Uses the project's shared ProtocolError (crypto/CryptoCore.kt); no duplicate is declared.
 */
class PrimitivesTest {
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    @Test
    fun rfc5869TestCase1() {
        val okm = Pr.hkdfRaw(ByteArray(22) { 0x0b }, hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42)
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", okm.hex())
    }

    @Test
    fun rfc5903P256Ecdh() {
        val i = Pr.decodePrivate(hex("C88F01F510D9AC3F70A292DAA2316DE544E9AAB8AFE84049C62A9C57862D1433"))
        val gr = Pr.decodePublic(hex("04" + "D12DFB5289C8D4F81208B70270398C342296970A0BCCB74C736FC7554494BF63" + "56FBF3CA366CC23E8157854C13C58D6AAC23F046ADA30F8353E74F33039872AB"))
        assertEquals("d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de", Pr.dh(i, gr).hex())
    }

    @Test
    fun rfc6979VerifyAndTamper() {
        val u = hex("04" + "60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6" + "7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299")
        val sig = hex("EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716" + "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8")
        assertTrue("RFC 6979 A.2.5 signature verifies", Pr.verify(u, "sample".toByteArray(), sig))
        assertFalse("a changed message is rejected", Pr.verify(u, "samplf".toByteArray(), sig))
    }

    @Test
    fun signRoundTripIs64Bytes() {
        val kp = Pr.generateKeyPair()
        val pubRaw = Pr.encodePublic(kp.public as ECPublicKey)
        val s = Pr.sign(kp.private as ECPrivateKey, "hi".toByteArray())
        assertEquals("a signature is r‖s, 64 bytes", 64, s.size)
        assertTrue(Pr.verify(pubRaw, "hi".toByteArray(), s))
    }

    @Test
    fun offCurvePointRejected() {
        val kp = Pr.generateKeyPair()
        val pubRaw = Pr.encodePublic(kp.public as ECPublicKey)
        val bad = pubRaw.copyOf().also { it[64] = (it[64] + 1).toByte() }
        assertTrue(runCatching { Pr.decodePublic(bad) }.isFailure)
    }

    @Test
    fun base64IsCanonical() {
        assertEquals("0001", Pr.unb64("AAE=").hex())
        assertTrue("non-canonical trailing bits rejected", runCatching { Pr.unb64("AAF=") }.isFailure)
        assertTrue("unpadded rejected", runCatching { Pr.unb64("AAE") }.isFailure)
    }

    @Test
    fun aeadRoundTripAndWrongAd() {
        val info = "HiddenMessenger DoubleRatchet message v1"
        val mk = ByteArray(32) { 7 }
        val c = Pr.aeadEncrypt(Pr.messageCipher(mk.copyOf(), info), "hello".toByteArray(), "ad".toByteArray())
        val p = Pr.aeadDecrypt(Pr.messageCipher(mk.copyOf(), info), c, "ad".toByteArray())
        assertEquals("hello", String(p))
        assertTrue("wrong associated data is rejected", runCatching { Pr.aeadDecrypt(Pr.messageCipher(mk.copyOf(), info), c, "x".toByteArray()) }.isFailure)
    }
}
