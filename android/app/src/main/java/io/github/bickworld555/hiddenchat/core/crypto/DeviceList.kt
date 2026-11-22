package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P

/**
 * Signed device lists (src/e2e/deviceList.js). An account key (ECDSA P-256, made on one of the account's devices and
 * never leaving it) signs the canonical list of the account's device identities. Contacts pin the account key on
 * first sight and encrypt only to devices the signed list names, so the server cannot add a device unseen. A fresh
 * account key (the native path's new identity) shows to contacts as "security code changed".
 *
 * The canonical form and the signing input are byte-compatible with the web code — a list signed here verifies on a
 * device running the web code (checked by DeviceListTest against the recorded vector).
 */
object DeviceList {
    const val CONTEXT = "HiddenMessenger device list v1"
    const val MAX_LISTED_DEVICES = 64

    /** A device as named in the list: its id and its identity public keys (base64). */
    data class Entry(val id: String, val dh: String, val sig: String)

    /** The exact bytes that are signed: JSON.stringify({ v:1, u, ak, n, at, d:[{id,dh,sig} sorted by id] }). */
    fun canonical(userId: String, accountKeyB64: String, counter: Long, at: Long, devices: List<Entry>): String {
        val sorted = devices.sortedBy { it.id }.map { Json.obj("id" to it.id, "dh" to it.dh, "sig" to it.sig) }
        return Json.stringify(Json.obj("v" to 1L, "u" to userId, "ak" to accountKeyB64, "n" to counter, "at" to at, "d" to sorted))
    }

    /** A new account key (ECDSA P-256). The base64 public half is the `ak` contacts pin. */
    fun createAccountKey(rng: Rng): EcKeyPair = rng.keyPair()

    /** Signs a canonical list with the account key: base64 ECDSA over CONTEXT ‖ list. */
    fun sign(accountKey: EcKeyPair, list: String): String =
        P.b64(P.sign(accountKey.priv, P.concat(P.utf8(CONTEXT), P.utf8(list))))

    /** Builds and signs a list: returns { list (canonical JSON), signature (base64) } as a map. */
    fun signList(accountKey: EcKeyPair, userId: String, counter: Long, at: Long, devices: List<Entry>): Map<String, Any?> {
        val list = canonical(userId, P.b64(accountKey.pub), counter, at, devices)
        return Json.obj("list" to list, "signature" to sign(accountKey, list))
    }

    /** Whether a signature over a canonical list checks out under the account key (base64). */
    fun verify(accountKeyB64: String, list: String, signatureB64: String): Boolean =
        P.verify(P.unb64(accountKeyB64), P.concat(P.utf8(CONTEXT), P.utf8(list)), P.unb64(signatureB64))
}
