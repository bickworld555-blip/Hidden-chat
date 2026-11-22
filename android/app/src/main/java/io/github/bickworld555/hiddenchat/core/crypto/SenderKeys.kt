package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P

/** Group message { kid, n, c, s }. */
class SenderKeyMessage(val kid: Long, val n: Int, val c: ByteArray, val s: ByteArray) {
    fun toMap(): Map<String, Any> = linkedMapOf("kid" to kid, "n" to n, "c" to P.b64(c), "s" to P.b64(s))

    companion object {
        fun fromMap(m: Map<*, *>) = SenderKeyMessage(
            kid = (m["kid"] as? Number)?.toLong() ?: throw ProtocolError("decrypt-failed", "bad kid"),
            n = requireNonNegInt(m["n"], "n"),
            c = P.unb64(m["c"] as String),
            s = P.unb64(m["s"] as String),
        )
    }
}

/** Distribution { type:"skdm", g, kid, ck, sp } — sent pairwise-sealed until confirmed. */
class SenderKeyDistribution(val groupId: String, val kid: Long, val chainKey: ByteArray, val signingPub: ByteArray) {
    fun toMap(): Map<String, Any> = linkedMapOf(
        "type" to "skdm", "g" to groupId, "kid" to kid, "ck" to P.b64(chainKey), "sp" to P.b64(signingPub),
    )

    companion object {
        fun fromMap(m: Map<*, *>): SenderKeyDistribution {
            if (m["type"] != "skdm") throw ProtocolError("decrypt-failed", "not a distribution")
            val sp = P.unb64(m["sp"] as String).also { P.decodePublic(it) }
            val ck = P.unb64(m["ck"] as String)
            if (ck.size != 32) throw ProtocolError("decrypt-failed", "bad chain key")
            return SenderKeyDistribution(m["g"] as String, (m["kid"] as Number).toLong(), ck, sp)
        }
    }
}

/** Own sending state (record `sk-own:<group>`). */
class OwnSenderKey internal constructor(
    val groupId: String,
    val kid: Long,
    val chainKey: ByteArray,
    val n: Int,
    val signing: EcKeyPair,
    /** Chain key at n = 0, kept only until every member confirmed the distribution. */
    val initialChainKey: ByteArray?,
    val memberHash: String,
) {
    fun distribution(): SenderKeyDistribution =
        SenderKeyDistribution(groupId, kid, initialChainKey ?: throw ProtocolError("no-sender-key", "distribution already confirmed"), signing.pub)

    fun confirmed(): OwnSenderKey = OwnSenderKey(groupId, kid, chainKey, n, signing, null, memberHash)
}

/** Received state for one sending device (record `sk-in:<group>:<user>/<device>`). */
class InboundSenderKey internal constructor(
    val groupId: String,
    val kid: Long,
    val chainKey: ByteArray,
    val n: Int,
    val signingPub: ByteArray,
    val skipped: Map<Int, ByteArray>,
)

object SenderKeys {
    const val MAX_GROUP_SKIP = 2000

    /**
     * New sender key. VERIFY-JS: how `kid` is generated (assumed uint32 from 4 random bytes)
     * and the order randoms are consumed (chain key, then kid, then signing key pair).
     */
    fun create(groupId: String, memberHash: String, rng: Rng): OwnSenderKey {
        val ck = rng.bytes(32)
        val kidBytes = rng.bytes(4)
        val kid = ((kidBytes[0].toLong() and 0xff) shl 24) or ((kidBytes[1].toLong() and 0xff) shl 16) or
            ((kidBytes[2].toLong() and 0xff) shl 8) or (kidBytes[3].toLong() and 0xff)
        val signing = rng.keyPair()
        return OwnSenderKey(groupId, kid, ck, 0, signing, ck.copyOf(), memberHash)
    }

    /** ad = JSON.stringify(["hm-sk-v1", groupId, senderAddress, keyId, n]). */
    fun ad(groupId: String, senderAddress: String, kid: Long, n: Int): ByteArray =
        JsJson.bytes(listOf(Ctx.SK_AD_TAG, groupId, senderAddress, kid, n))

    fun encrypt(own: OwnSenderKey, senderAddress: String, plaintext: ByteArray): Pair<OwnSenderKey, SenderKeyMessage> {
        val (mk, next) = P.chainStep(own.chainKey)
        val ad = ad(own.groupId, senderAddress, own.kid, own.n)
        // VERIFY-JS: AEAD associated data assumed to be `ad`.
        val c = P.aeadEncrypt(P.messageCipher(mk, Ctx.SENDER_KEY), plaintext, ad)
        val s = P.sign(own.signing.priv, P.concat(ad, c))
        val nextOwn = OwnSenderKey(own.groupId, own.kid, next, own.n + 1, own.signing, own.initialChainKey, own.memberHash)
        return nextOwn to SenderKeyMessage(own.kid, own.n, c, s)
    }

    fun accept(d: SenderKeyDistribution): InboundSenderKey =
        InboundSenderKey(d.groupId, d.kid, d.chainKey.copyOf(), 0, d.signingPub, emptyMap())

    /** Transactional: returns the new inbound state; `inb` is never modified. */
    fun decrypt(inb: InboundSenderKey, senderAddress: String, msg: SenderKeyMessage): Pair<InboundSenderKey, ByteArray> {
        if (msg.kid != inb.kid) throw ProtocolError("no-sender-key", "unknown sender key ${msg.kid}")
        val ad = ad(inb.groupId, senderAddress, msg.kid, msg.n)
        // signature first: nothing is derived for a forged message
        if (!P.verify(inb.signingPub, P.concat(ad, msg.c), msg.s))
            throw ProtocolError("decrypt-failed", "sender key signature invalid")

        val skipped = LinkedHashMap(inb.skipped)
        if (msg.n < inb.n) {
            val mk = skipped.remove(msg.n) ?: throw ProtocolError("decrypt-failed", "duplicate or expired group message")
            val pt = P.aeadDecrypt(P.messageCipher(mk, Ctx.SENDER_KEY), msg.c, ad)
            return InboundSenderKey(inb.groupId, inb.kid, inb.chainKey, inb.n, inb.signingPub, skipped) to pt
        }
        if (msg.n - inb.n > MAX_GROUP_SKIP) throw ProtocolError("decrypt-failed", "too many skipped group messages")

        var ck = inb.chainKey
        var n = inb.n
        while (n < msg.n) {
            val (mk, next) = P.chainStep(ck)
            skipped[n] = mk; ck = next; n++
            while (skipped.size > MAX_GROUP_SKIP) skipped.remove(skipped.keys.first())
        }
        val (mk, next) = P.chainStep(ck)
        val pt = P.aeadDecrypt(P.messageCipher(mk, Ctx.SENDER_KEY), msg.c, ad)
        return InboundSenderKey(inb.groupId, inb.kid, next, n + 1, inb.signingPub, skipped) to pt
    }
}
