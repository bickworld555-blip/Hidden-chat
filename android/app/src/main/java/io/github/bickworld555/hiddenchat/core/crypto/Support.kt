package io.github.bickworld555.hiddenchat.core.crypto

import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey

/** A P-256 key pair: JVM private key + 65-byte uncompressed public point. */
class EcKeyPair(val priv: ECPrivateKey, val pub: ByteArray) {
    val pubB64: String get() = Primitives.b64(pub)

    companion object {
        fun fromRaw(privD: ByteArray, pub: ByteArray) =
            EcKeyPair(Primitives.decodePrivate(privD), Primitives.decodePublic(pub).let { Primitives.encodePublic(it) })
    }
}

/**
 * All randomness goes through here, so the conformance test can feed the
 * recorded `generated` key pairs and `randoms` from e2e-vectors.json in order.
 */
interface Rng {
    fun keyPair(): EcKeyPair
    fun bytes(n: Int): ByteArray
}

object SecureRng : Rng {
    private val random = SecureRandom()
    override fun keyPair(): EcKeyPair {
        val kp = Primitives.generateKeyPair(random)
        return EcKeyPair(kp.private as ECPrivateKey, Primitives.encodePublic(kp.public as ECPublicKey))
    }
    override fun bytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }
}

/** Device identity: one DH key (X3DH) and one signing key (ECDSA). */
class IdentityKeys(val dh: EcKeyPair, val sig: EcKeyPair) {
    /** 65+65 bytes, the form used in the ratchet associated data. */
    fun publicBytes(): ByteArray = Primitives.concat(dh.pub, sig.pub)
}

/** Fixed protocol strings — must equal ProtocolConstants in the repo. */
internal object Ctx {
    const val X3DH = "HiddenMessenger X3DH P-256 v1"
    const val ROOT = "HiddenMessenger DoubleRatchet root v1"
    const val MESSAGE = "HiddenMessenger DoubleRatchet message v1"
    const val SIGNED_PREKEY = "HiddenMessenger signed prekey v1"
    const val SENDER_KEY = "HiddenMessenger SenderKey message v1"
    const val SK_AD_TAG = "hm-sk-v1"
}

/**
 * Minimal JSON.stringify for the arrays that feed AEAD/signature input.
 * Matches ES2019 well-formed JSON.stringify for strings and safe integers.
 * In the repo, prefer the existing `Json.stringify` — this is the same contract.
 */
internal object JsJson {
    fun string(s: String): String {
        val sb = StringBuilder(s.length + 2).append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append("\\u%04x".format(c.code))
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    sb.append(c).append(s[i + 1]); i++
                }
                Character.isSurrogate(c) -> sb.append("\\u%04x".format(c.code)) // lone surrogate
                else -> sb.append(c)
            }
            i++
        }
        return sb.append('"').toString()
    }

    fun value(v: Any?): String = when (v) {
        null -> "null"
        is String -> string(v)
        is Int, is Long -> v.toString()
        is Boolean -> v.toString()
        is List<*> -> v.joinToString(",", "[", "]") { value(it) }
        else -> throw IllegalArgumentException("unsupported JSON value: ${v::class}")
    }

    fun bytes(v: List<Any?>): ByteArray = Primitives.utf8(value(v))
}

internal fun requireNonNegInt(v: Any?, name: String): Int {
    val n = when (v) { is Int -> v.toLong(); is Long -> v; is Number -> v.toDouble().let { if (it % 1.0 == 0.0) it.toLong() else -1 }; else -> -1 }
    if (n < 0 || n > Int.MAX_VALUE) throw ProtocolError("decrypt-failed", "bad $name")
    return n.toInt()
}
