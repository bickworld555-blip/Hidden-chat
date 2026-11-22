package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P

/** A peer's published bundle as returned by claimBundles (already base64-decoded). */
class PreKeyBundle(
    val identityDh: ByteArray,
    val identitySig: ByteArray,
    val signedPreKeyId: Int,
    val signedPreKey: ByteArray,
    val signedPreKeySignature: ByteArray,
    val preKeyId: Int? = null,
    val preKey: ByteArray? = null,
)

/** Output of X3DH on the initiator side: feeds DoubleRatchet.initInitiator and the `p` header. */
class X3dhInitiation(
    val sharedSecret: ByteArray,
    val ad: ByteArray,
    val ephemeralPub: ByteArray,
    val signedPreKeyId: Int,
    val preKeyId: Int?,
    val theirSignedPreKey: ByteArray,
)

class X3dhResponse(val sharedSecret: ByteArray, val ad: ByteArray)

object X3dh {

    /**
     * Bytes the identity signing key signs for a signed prekey.
     * VERIFY-JS: exact layout in src/e2e (assumed UTF-8(context) ‖ 65-byte SPK).
     */
    fun signedPreKeyMessage(spkPub: ByteArray): ByteArray =
        P.concat(P.utf8(Ctx.SIGNED_PREKEY), spkPub)

    fun signSignedPreKey(identity: IdentityKeys, spkPub: ByteArray): ByteArray =
        P.sign(identity.sig.priv, signedPreKeyMessage(spkPub))

    fun verifySignedPreKey(identitySigPub: ByteArray, spkPub: ByteArray, signature: ByteArray): Boolean =
        P.verify(identitySigPub, signedPreKeyMessage(spkPub), signature)

    /** ad = IK_initiator(dh‖sig) ‖ IK_responder(dh‖sig), 260 bytes, same on both sides. */
    fun associatedData(initDh: ByteArray, initSig: ByteArray, respDh: ByteArray, respSig: ByteArray): ByteArray =
        P.concat(initDh, initSig, respDh, respSig)

    /** Initiator: DH1=IK↔SPK, DH2=EK↔IK, DH3=EK↔SPK, DH4=EK↔OPK. */
    fun initiate(me: IdentityKeys, bundle: PreKeyBundle, rng: Rng): X3dhInitiation {
        // validate every point before use
        P.decodePublic(bundle.identityDh); P.decodePublic(bundle.identitySig); P.decodePublic(bundle.signedPreKey)
        bundle.preKey?.let { P.decodePublic(it) }
        if (!verifySignedPreKey(bundle.identitySig, bundle.signedPreKey, bundle.signedPreKeySignature))
            throw ProtocolError("no-bundle", "signed prekey signature invalid")

        val ek = rng.keyPair()
        val dh1 = P.dh(me.dh.priv, bundle.signedPreKey)
        val dh2 = P.dh(ek.priv, bundle.identityDh)
        val dh3 = P.dh(ek.priv, bundle.signedPreKey)
        val dh4 = bundle.preKey?.let { P.dh(ek.priv, it) }
        val sk = if (dh4 != null) P.x3dhSecret(Ctx.X3DH, dh1, dh2, dh3, dh4) else P.x3dhSecret(Ctx.X3DH, dh1, dh2, dh3)
        listOf(dh1, dh2, dh3, dh4).forEach { P.wipe(it) }

        return X3dhInitiation(
            sharedSecret = sk,
            ad = associatedData(me.dh.pub, me.sig.pub, bundle.identityDh, bundle.identitySig),
            ephemeralPub = ek.pub,
            signedPreKeyId = bundle.signedPreKeyId,
            preKeyId = if (bundle.preKey != null) bundle.preKeyId else null,
            theirSignedPreKey = bundle.signedPreKey,
        )
    }

    /** Responder: mirror of initiate, using the stored SPK and (consumed) OPK. */
    fun respond(
        me: IdentityKeys,
        theirIdentityDh: ByteArray,
        theirIdentitySig: ByteArray,
        theirEphemeral: ByteArray,
        signedPreKey: EcKeyPair,
        oneTimePreKey: EcKeyPair?,
    ): X3dhResponse {
        P.decodePublic(theirIdentityDh); P.decodePublic(theirIdentitySig)
        val dh1 = P.dh(signedPreKey.priv, theirIdentityDh)
        val dh2 = P.dh(me.dh.priv, theirEphemeral)
        val dh3 = P.dh(signedPreKey.priv, theirEphemeral)
        val dh4 = oneTimePreKey?.let { P.dh(it.priv, theirEphemeral) }
        val sk = if (dh4 != null) P.x3dhSecret(Ctx.X3DH, dh1, dh2, dh3, dh4) else P.x3dhSecret(Ctx.X3DH, dh1, dh2, dh3)
        listOf(dh1, dh2, dh3, dh4).forEach { P.wipe(it) }
        return X3dhResponse(sk, associatedData(theirIdentityDh, theirIdentitySig, me.dh.pub, me.sig.pub))
    }
}
