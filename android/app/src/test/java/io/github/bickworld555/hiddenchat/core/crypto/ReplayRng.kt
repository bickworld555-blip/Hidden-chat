package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.Json

/**
 * The test-side replay driver for the conformance vectors (e2e-vectors.json). It is **not** cryptography — it hands
 * back, in order, the exact key material and random bytes the JavaScript protocol drew while the vectors were
 * recorded (`scripts/e2e-native-vectors.mjs`). A native CryptoCore implementation that is built to take its
 * randomness from an injected source can be fed one of these per party, so every generated key pair and random draw
 * matches the recording and the resulting ciphertexts/headers must come out byte-for-byte identical.
 *
 * This removes the replay plumbing from the implementer's plate: once the X3DH / Double Ratchet / Sender Keys core
 * exists and exposes a deterministic constructor (records + a randomness source), completing
 * `E2eVectorsTest.coreConformanceWhenInstalled` is: build a ReplayRng per party, run the recorded step order, assert.
 *
 * Each `generated` entry is `{ alg, d (private scalar hex), pub (65-byte point hex) }`; `randoms` are hex byte
 * strings. `next*` throw if the core asks for more than was recorded (a sign the call order diverged from the web
 * protocol — itself a conformance failure worth surfacing).
 */
class ReplayRng(party: Map<String, Any?>) {
    data class RecordedKey(val algorithm: String, val privateScalar: ByteArray, val publicPoint: ByteArray)

    private val keys: List<RecordedKey> = (Json.list(party["generated"]) ?: emptyList()).map {
        val m = Json.map(it)!!
        RecordedKey(Json.string(m["alg"]) ?: "", hex(Json.string(m["d"])!!), hex(Json.string(m["pub"])!!))
    }
    private val randoms: List<ByteArray> = (Json.list(party["randoms"]) ?: emptyList()).map { hex(Json.string(it)!!) }

    private var keyIndex = 0
    private var randomIndex = 0

    /** The next generated key pair, in recording order. */
    fun nextKey(): RecordedKey {
        if (keyIndex >= keys.size) throw IllegalStateException("ReplayRng: core requested more key pairs than were recorded")
        return keys[keyIndex++]
    }

    /** The next recorded random draw (e.g. an AEAD nonce or a sender-key seed), in recording order. */
    fun nextRandom(): ByteArray {
        if (randomIndex >= randoms.size) throw IllegalStateException("ReplayRng: core requested more randomness than was recorded")
        return randoms[randomIndex++].copyOf()
    }

    val keyCount: Int get() = keys.size
    val randomCount: Int get() = randoms.size
    val keysConsumed: Int get() = keyIndex
    val randomsConsumed: Int get() = randomIndex

    companion object {
        fun hex(s: String): ByteArray {
            require(s.length % 2 == 0) { "odd-length hex" }
            return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        }
    }
}
