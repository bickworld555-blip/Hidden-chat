package io.github.bickworld555.hiddenchat.core.crypto

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Low-level primitives, byte-compatible with src/e2e/primitives.js (Web Crypto).
 * P-256 ECDH/ECDSA, HKDF-SHA-256, AES-256-GCM, canonical padded base64.
 */
object Primitives {

    // ---------- P-256 domain ----------
    private val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    private val N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    private val A = P.subtract(BigInteger.valueOf(3))

    val P256: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
    }

    const val PUBLIC_KEY_LEN = 65
    const val SIGNATURE_LEN = 64
    private val ZERO_SALT = ByteArray(32)

    // ---------- base64 (canonical, padded) ----------
    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun unb64(s: String): ByteArray {
        if (s.length % 4 != 0 || !s.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '+' || it == '/' || it == '=' })
            throw ProtocolError("decrypt-failed", "non-canonical base64")
        val out = try { Base64.getDecoder().decode(s) } catch (e: IllegalArgumentException) {
            throw ProtocolError("decrypt-failed", "bad base64")
        }
        if (b64(out) != s) throw ProtocolError("decrypt-failed", "non-canonical base64")
        return out
    }

    // ---------- byte helpers ----------
    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var o = 0
        for (p in parts) { System.arraycopy(p, 0, out, o, p.size); o += p.size }
        return out
    }

    fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    fun wipe(b: ByteArray?) { b?.fill(0) }

    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    private fun fixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size == 33 && raw[0] == 0.toByte() -> raw.copyOfRange(1, 33)
            raw.size < 32 -> ByteArray(32 - raw.size) + raw
            else -> throw IllegalArgumentException("integer too large")
        }
    }

    // ---------- keys ----------
    fun generateKeyPair(random: SecureRandom = SecureRandom()): KeyPair =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), random) }.generateKeyPair()

    /** 65-byte uncompressed point 0x04‖x‖y. */
    fun encodePublic(pub: ECPublicKey): ByteArray =
        concat(byteArrayOf(0x04), fixed32(pub.w.affineX), fixed32(pub.w.affineY))

    /** Parses and validates (on-curve, in-range) a 65-byte uncompressed point. */
    fun decodePublic(raw: ByteArray): ECPublicKey {
        if (raw.size != PUBLIC_KEY_LEN || raw[0] != 0x04.toByte())
            throw ProtocolError("decrypt-failed", "bad public key encoding")
        val x = BigInteger(1, raw.copyOfRange(1, 33))
        val y = BigInteger(1, raw.copyOfRange(33, 65))
        if (x >= P || y >= P) throw ProtocolError("decrypt-failed", "public key out of range")
        val lhs = y.multiply(y).mod(P)
        val rhs = x.pow(3).add(A.multiply(x)).add(B).mod(P)
        if (lhs != rhs) throw ProtocolError("decrypt-failed", "public key not on curve")
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), P256)) as ECPublicKey
    }

    fun encodePrivate(priv: ECPrivateKey): ByteArray = fixed32(priv.s)

    fun decodePrivate(d: ByteArray): ECPrivateKey {
        val s = BigInteger(1, d)
        require(s.signum() > 0 && s < N) { "private scalar out of range" }
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(s, P256)) as ECPrivateKey
    }

    // ---------- ECDH ----------
    /** Raw 32-byte x-coordinate, as Web Crypto deriveBits(256) returns. */
    fun dh(priv: ECPrivateKey, pub: ECPublicKey): ByteArray =
        KeyAgreement.getInstance("ECDH").run { init(priv); doPhase(pub, true); generateSecret() }

    fun dh(priv: ECPrivateKey, pubRaw: ByteArray): ByteArray = dh(priv, decodePublic(pubRaw))

    // ---------- hashing / HMAC / HKDF ----------
    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(data) }

    private fun hkdfExpand(prk: ByteArray, info: ByteArray, len: Int): ByteArray {
        require(len in 1..255 * 32)
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }
        val out = ByteArray(len)
        var t = ByteArray(0)
        var off = 0
        var i = 1
        while (off < len) {
            mac.update(t); mac.update(info); mac.update(i.toByte())
            t = mac.doFinal()
            val n = minOf(32, len - off)
            System.arraycopy(t, 0, out, off, n)
            off += n; i++
        }
        wipe(t)
        return out
    }

    /** RFC 5869. Empty salt == 32 zero bytes. */
    fun hkdf(ikm: ByteArray, salt: ByteArray?, info: String, len: Int): ByteArray {
        val s = if (salt == null || salt.isEmpty()) ZERO_SALT else salt
        val prk = hmac(s, ikm)
        return hkdfExpand(prk, utf8(info), len).also { wipe(prk) }
    }

    fun hkdfRaw(ikm: ByteArray, salt: ByteArray?, info: ByteArray, len: Int): ByteArray {
        val s = if (salt == null || salt.isEmpty()) ZERO_SALT else salt
        val prk = hmac(s, ikm)
        return hkdfExpand(prk, info, len).also { wipe(prk) }
    }

    /** Extract = HMAC(saltKey, ikm), then RFC 5869 expand. Root KDF. */
    fun hkdfWithKeySalt(saltKey: ByteArray, ikm: ByteArray, info: String, len: Int): ByteArray {
        val prk = hmac(saltKey, ikm)
        return hkdfExpand(prk, utf8(info), len).also { wipe(prk) }
    }

    // ---------- AEAD ----------
    class AeadKey(val key: ByteArray, val iv: ByteArray) {
        fun wipe() { key.fill(0); iv.fill(0) }
    }

    /** okm = HKDF(mk, 0×32, info, 44); key = okm[0:32], nonce = okm[32:44]. Wipes mk. */
    fun messageCipher(mk: ByteArray, info: String): AeadKey {
        val okm = hkdf(mk, null, info, 44)
        wipe(mk)
        return AeadKey(okm.copyOfRange(0, 32), okm.copyOfRange(32, 44)).also { wipe(okm) }
    }

    fun aeadEncrypt(k: AeadKey, data: ByteArray, ad: ByteArray): ByteArray =
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(k.key, "AES"), GCMParameterSpec(128, k.iv))
            updateAAD(ad)
            doFinal(data)
        }

    fun aeadDecrypt(k: AeadKey, data: ByteArray, ad: ByteArray): ByteArray = try {
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(k.key, "AES"), GCMParameterSpec(128, k.iv))
            updateAAD(ad)
            doFinal(data)
        }
    } catch (e: Exception) {
        throw ProtocolError("decrypt-failed", "AEAD authentication failed")
    }

    // ---------- ECDSA (r‖s 64 bytes on the wire) ----------
    fun sign(priv: ECPrivateKey, data: ByteArray): ByteArray {
        val der = Signature.getInstance("SHA256withECDSA").run { initSign(priv); update(data); sign() }
        return derToRaw(der)
    }

    fun verify(pub: ECPublicKey, data: ByteArray, raw: ByteArray): Boolean {
        if (raw.size != SIGNATURE_LEN) return false
        val r = BigInteger(1, raw.copyOfRange(0, 32))
        val s = BigInteger(1, raw.copyOfRange(32, 64))
        if (r.signum() == 0 || s.signum() == 0 || r >= N || s >= N) return false
        return try {
            Signature.getInstance("SHA256withECDSA").run { initVerify(pub); update(data); verify(rawToDer(raw)) }
        } catch (e: Exception) { false }
    }

    fun verify(pubRaw: ByteArray, data: ByteArray, raw: ByteArray): Boolean =
        try { verify(decodePublic(pubRaw), data, raw) } catch (e: ProtocolError) { false }

    fun derToRaw(der: ByteArray): ByteArray {
        var i = 0
        require(der[i++] == 0x30.toByte()) { "bad DER" }
        var len = der[i++].toInt() and 0xff
        if (len and 0x80 != 0) { val n = len and 0x7f; len = 0; repeat(n) { len = (len shl 8) or (der[i++].toInt() and 0xff) } }
        fun readInt(): BigInteger {
            require(der[i++] == 0x02.toByte()) { "bad DER int" }
            val l = der[i++].toInt() and 0xff
            return BigInteger(1, der.copyOfRange(i, i + l)).also { i += l }
        }
        val r = readInt(); val s = readInt()
        return concat(fixed32(r), fixed32(s))
    }

    fun rawToDer(raw: ByteArray): ByteArray {
        fun enc(b: ByteArray): ByteArray {
            var v = b.dropWhile { it == 0.toByte() }.toByteArray()
            if (v.isEmpty()) v = byteArrayOf(0)
            if (v[0].toInt() and 0x80 != 0) v = byteArrayOf(0) + v
            return byteArrayOf(0x02, v.size.toByte()) + v
        }
        val body = enc(raw.copyOfRange(0, 32)) + enc(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    // ---------- Ratchet KDFs ----------
    /** message key = HMAC(chain, 0x01), next chain = HMAC(chain, 0x02). */
    fun chainStep(chainKey: ByteArray): Pair<ByteArray, ByteArray> =
        hmac(chainKey, byteArrayOf(0x01)) to hmac(chainKey, byteArrayOf(0x02))

    /** HKDF(salt = rootKey, ikm = dh, info = ROOT, 64) → (nextRoot, chain). */
    fun rootStep(rootKey: ByteArray, dhOut: ByteArray, info: String): Pair<ByteArray, ByteArray> {
        val okm = hkdfWithKeySalt(rootKey, dhOut, info, 64)
        return (okm.copyOfRange(0, 32) to okm.copyOfRange(32, 64)).also { wipe(okm) }
    }

    /** SK = HKDF(0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4], 0×32, X3DH, 32). */
    fun x3dhSecret(info: String, vararg dhs: ByteArray): ByteArray {
        val ikm = concat(ByteArray(32) { 0xFF.toByte() }, *dhs)
        return hkdf(ikm, null, info, 32).also { wipe(ikm) }
    }

    /** SHA-256 iterated `rounds` times (safety numbers use 1024). */
    fun iteratedSha256(input: ByteArray, rounds: Int): ByteArray {
        var h = input
        repeat(rounds) { h = sha256(h) }
        return h
    }
}
