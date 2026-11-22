package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.Json

/**
 * The test-side replay driver for the conformance vectors (e2e-vectors.json). It implements the production [Rng] so
 * a party's state machine (X3dh / DoubleRatchet / SenderKeys) draws the **exact** key pairs and random bytes the
 * JavaScript protocol drew while the vectors were recorded (`scripts/e2e-native-vectors.mjs`), in the same order.
 * Driven through the recorded step sequence, every header and ciphertext must then come out byte-for-byte identical.
 *
 * This is not cryptography — it is deterministic replay of recorded material. Each `generated` entry is
 * `{ alg, d (private scalar hex), pub (65-byte point hex) }`; `randoms` are hex byte strings. `keyPair`/`bytes`
 * throw if the code asks for more than was recorded (a sign the call order diverged from the web protocol — itself a
 * conformance failure worth surfacing).
 */
class ReplayRng(party: Map<String, Any?>) : Rng {
    private val keys: List<Pair<ByteArray, ByteArray>> = (Json.list(party["generated"]) ?: emptyList()).map {
        val m = Json.map(it)!!
        hex(Json.string(m["d"])!!) to hex(Json.string(m["pub"])!!)
    }
    private val randoms: List<ByteArray> = (Json.list(party["randoms"]) ?: emptyList()).map { hex(Json.string(it)!!) }

    private var keyIndex = 0
    private var randomIndex = 0

    override fun keyPair(): EcKeyPair {
        if (keyIndex >= keys.size) throw IllegalStateException("ReplayRng: code requested more key pairs than were recorded")
        val (d, pub) = keys[keyIndex++]
        return EcKeyPair.fromRaw(d, pub)
    }

    override fun bytes(n: Int): ByteArray {
        if (randomIndex >= randoms.size) throw IllegalStateException("ReplayRng: code requested more randomness than was recorded")
        val next = randoms[randomIndex++]
        // A size the recording did not have means the native call order diverged from the web protocol.
        if (next.size != n) throw IllegalStateException("ReplayRng: requested $n random bytes but ${next.size} were recorded at this step")
        return next.copyOf()
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
