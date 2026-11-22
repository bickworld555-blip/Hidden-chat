package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P

/** Message header { dh, pn, n }. */
class RatchetHeader(val dh: String, val pn: Int, val n: Int) {
    /** AEAD bytes: JSON.stringify([dh, pn, n]). */
    fun bytes(): ByteArray = JsJson.bytes(listOf(dh, pn, n))
    fun toMap(): Map<String, Any> = linkedMapOf("dh" to dh, "pn" to pn, "n" to n)

    companion object {
        fun fromMap(m: Map<*, *>): RatchetHeader {
            val dh = m["dh"] as? String ?: throw ProtocolError("decrypt-failed", "bad header")
            P.decodePublic(P.unb64(dh))
            return RatchetHeader(dh, requireNonNegInt(m["pn"], "pn"), requireNonNegInt(m["n"], "n"))
        }
    }
}

class RatchetMessage(val header: RatchetHeader, val ciphertext: ByteArray)

/**
 * Immutable Double Ratchet session state. Every operation returns a NEW state;
 * the caller persists it only after the whole operation succeeded.
 */
class RatchetState internal constructor(
    val rootKey: ByteArray,
    val dhSelf: EcKeyPair,
    val dhRemote: ByteArray?,
    val sendChain: ByteArray?,
    val recvChain: ByteArray?,
    val ns: Int,
    val nr: Int,
    val pn: Int,
    /** "<dhBase64>|<n>" → message key, insertion order = age. */
    val skipped: Map<String, ByteArray>,
    val ad: ByteArray,
) {
    /**
     * Storage form. VERIFY-JS: field names/encoding must equal the web `session:*` record
     * if sessions are ever shared or migrated between the WebView and native stores.
     */
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "rk" to P.b64(rootKey),
        "dhs" to linkedMapOf("pub" to dhSelf.pubB64, "priv" to P.b64(P.encodePrivate(dhSelf.priv))),
        "dhr" to dhRemote?.let { P.b64(it) },
        "cks" to sendChain?.let { P.b64(it) },
        "ckr" to recvChain?.let { P.b64(it) },
        "ns" to ns, "nr" to nr, "pn" to pn,
        "skipped" to skipped.mapValuesTo(linkedMapOf()) { P.b64(it.value) },
        "ad" to P.b64(ad),
    )

    companion object {
        fun fromMap(m: Map<*, *>): RatchetState {
            fun b(k: String) = (m[k] as String?)?.let { P.unb64(it) }
            val dhs = m["dhs"] as Map<*, *>
            val skipped = linkedMapOf<String, ByteArray>()
            (m["skipped"] as Map<*, *>?)?.forEach { (k, v) -> skipped[k as String] = P.unb64(v as String) }
            return RatchetState(
                rootKey = b("rk")!!,
                dhSelf = EcKeyPair.fromRaw(P.unb64(dhs["priv"] as String), P.unb64(dhs["pub"] as String)),
                dhRemote = b("dhr"), sendChain = b("cks"), recvChain = b("ckr"),
                ns = (m["ns"] as Number).toInt(), nr = (m["nr"] as Number).toInt(), pn = (m["pn"] as Number).toInt(),
                skipped = skipped, ad = b("ad")!!,
            )
        }
    }
}

object DoubleRatchet {
    const val MAX_SKIP = 1000
    const val MAX_STORED_SKIPPED = 2000

    /** Initiator (Alice) after X3DH: DHr = Bob's signed prekey. */
    fun initInitiator(x: X3dhInitiation, rng: Rng): RatchetState {
        val dhs = rng.keyPair()
        val out = P.dh(dhs.priv, x.theirSignedPreKey)
        val (rk, cks) = P.rootStep(x.sharedSecret, out, Ctx.ROOT)
        P.wipe(out)
        return RatchetState(rk, dhs, x.theirSignedPreKey, cks, null, 0, 0, 0, emptyMap(), x.ad)
    }

    /** Responder (Bob): his ratchet key starts as the signed prekey; root = SK. */
    fun initResponder(r: X3dhResponse, signedPreKey: EcKeyPair): RatchetState =
        RatchetState(r.sharedSecret.copyOf(), signedPreKey, null, null, null, 0, 0, 0, emptyMap(), r.ad)

    fun encrypt(s: RatchetState, plaintext: ByteArray): Pair<RatchetState, RatchetMessage> {
        val ck = s.sendChain ?: throw ProtocolError("no-session", "no sending chain")
        val (mk, nextCk) = P.chainStep(ck)
        val header = RatchetHeader(s.dhSelf.pubB64, s.pn, s.ns)
        val c = P.aeadEncrypt(P.messageCipher(mk, Ctx.MESSAGE), plaintext, P.concat(s.ad, header.bytes()))
        val next = RatchetState(s.rootKey, s.dhSelf, s.dhRemote, nextCk, s.recvChain, s.ns + 1, s.nr, s.pn, s.skipped, s.ad)
        return next to RatchetMessage(header, c)
    }

    /** Transactional: on any failure an exception is thrown and `s` is untouched. */
    fun decrypt(s: RatchetState, header: RatchetHeader, ciphertext: ByteArray, rng: Rng): Pair<RatchetState, ByteArray> {
        val aead = P.concat(s.ad, header.bytes())
        val skipped = LinkedHashMap(s.skipped)

        // 1. a key we already skipped past
        val skKey = "${header.dh}|${header.n}"
        skipped.remove(skKey)?.let { mk ->
            val pt = P.aeadDecrypt(P.messageCipher(mk, Ctx.MESSAGE), ciphertext, aead)
            return RatchetState(s.rootKey, s.dhSelf, s.dhRemote, s.sendChain, s.recvChain, s.ns, s.nr, s.pn, skipped, s.ad) to pt
        }

        var rk = s.rootKey; var dhs = s.dhSelf; var dhr = s.dhRemote
        var cks = s.sendChain; var ckr = s.recvChain
        var ns = s.ns; var nr = s.nr; var pn = s.pn

        fun skipUntil(until: Int) {
            val chain = ckr ?: return
            if (until - nr > MAX_SKIP) throw ProtocolError("decrypt-failed", "too many skipped messages")
            var ck = chain
            val dhB64 = P.b64(dhr!!)
            while (nr < until) {
                val (mk, next) = P.chainStep(ck)
                skipped["$dhB64|$nr"] = mk
                ck = next; nr++
                while (skipped.size > MAX_STORED_SKIPPED) skipped.remove(skipped.keys.first())
            }
            ckr = ck
        }

        // 2. DH ratchet step on a new remote key
        val headerDh = P.unb64(header.dh)
        if (dhr == null || !P.constantTimeEquals(headerDh, dhr)) {
            skipUntil(header.pn)
            pn = ns; ns = 0; nr = 0
            dhr = headerDh
            val o1 = P.dh(dhs.priv, dhr)
            val (rk1, ckr1) = P.rootStep(rk, o1, Ctx.ROOT); P.wipe(o1)
            dhs = rng.keyPair()
            val o2 = P.dh(dhs.priv, dhr)
            val (rk2, cks2) = P.rootStep(rk1, o2, Ctx.ROOT); P.wipe(o2)
            rk = rk2; ckr = ckr1; cks = cks2
        }

        // 3. advance the receiving chain to n
        if (header.n < nr) throw ProtocolError("decrypt-failed", "duplicate or expired message")
        skipUntil(header.n)
        val (mk, nextCkr) = P.chainStep(ckr!!)
        val pt = P.aeadDecrypt(P.messageCipher(mk, Ctx.MESSAGE), ciphertext, aead)
        return RatchetState(rk, dhs, dhr, cks, nextCkr, ns, nr + 1, pn, skipped, s.ad) to pt
    }
}
