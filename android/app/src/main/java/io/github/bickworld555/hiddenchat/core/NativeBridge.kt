package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.CryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.ProtocolError

/**
 * The one entry point the WebView calls over the Capacitor bridge so that every end-to-end crypto operation runs in
 * the native core (HiddenNativePlugin.crypto delegates here). Native is the single key owner — one identity and one
 * ratchet per device, shared by the foreground WebView and the background fetch.
 *
 * Request: `{ method, args }`; reply: `{ result }` (a value), `{ ok: true }` (no value), or `{ error: <code> }` with
 * one of the protocol's error codes. The arg/result JSON shapes are exactly the web protocol's (src/e2e/), so the
 * bridge protocol is a drop-in for createProtocol. `encryptForDevices`/`encryptGroup` take pre-claimed `bundles`
 * (the JS side claims them from the server first), so the native method stays pure.
 */
object NativeBridge {
    private fun s(args: Map<String, Any?>, key: String) = Json.string(args[key]) ?: throw ProtocolError("decrypt-failed", "missing $key")
    private fun i(args: Map<String, Any?>, key: String) = (Json.safeInteger(args[key]) ?: 0L).toInt()

    @Suppress("UNCHECKED_CAST")
    private fun bundleClaim(args: Map<String, Any?>): (String, List<String>) -> List<Any?> {
        val bundles = Json.map(args["bundles"]) ?: emptyMap()
        return { userId, ids ->
            (Json.list(bundles[userId]) ?: emptyList()).filter { ids.contains(Json.string(Json.map(it)?.get("deviceId"))) }
        }
    }

    /** Dispatches one bridge call. Never throws across the bridge: a [ProtocolError] comes back as `{ error }`. */
    fun call(core: CryptoCore, method: String, args: Map<String, Any?>): Map<String, Any?> {
        return try {
            when (method) {
                "prepareUpload" -> result(core.prepareUpload(i(args, "serverPreKeyCount"), Json.safeInteger(args["now"]) ?: System.currentTimeMillis()))
                "publicIdentity" -> result(core.publicIdentity())
                "missingSessions" -> result(core.missingSessions(Json.map(args["devices"]) ?: emptyMap()))
                "encryptForDevices" -> result(core.encryptForDevices(Json.map(args["devices"]) ?: emptyMap(), s(args, "plaintext"), bundleClaim(args)))
                "decryptFromDevice" -> result(core.decryptFromDevice(s(args, "userId"), s(args, "deviceId"), Json.map(args["entry"]) ?: throw ProtocolError("not-addressed", "no entry")))
                "forgetSession" -> { core.forgetSession(s(args, "userId"), s(args, "deviceId")); ok() }
                "encryptGroup" -> result(core.encryptGroup(s(args, "groupId"), s(args, "meUserId"), s(args, "meDeviceId"), memberDevices(args), s(args, "plaintext"), bundleClaim(args)))
                "confirmGroupSend" -> { core.confirmGroupSend(s(args, "groupId"), s(args, "keyId")); ok() }
                "resetGroup" -> { core.resetGroup(s(args, "groupId")); ok() }
                "decryptGroup" -> result(core.decryptGroup(s(args, "groupId"), s(args, "meUserId"), s(args, "meDeviceId"), s(args, "userId"), s(args, "deviceId"), Json.map(args["body"]) ?: throw ProtocolError("decrypt-failed", "no body")))
                "safetyNumber" -> result(core.safetyNumber(mapList(args["mine"]), mapList(args["theirs"])))
                "signPreviewKey" -> result(core.signPreviewKey(s(args, "previewKey")))
                "identityAgreement" -> result(io.github.bickworld555.hiddenchat.core.crypto.Primitives.b64(core.identityAgreement(io.github.bickworld555.hiddenchat.core.crypto.Primitives.unb64(s(args, "publicKey")))))
                "wipe" -> { core.wipe(); ok() }
                else -> error("unknown-method")
            }
        } catch (failed: ProtocolError) {
            error(failed.code)
        }
    }

    private fun result(value: Any?): Map<String, Any?> = Json.obj("result" to value)
    private fun ok(): Map<String, Any?> = Json.obj("ok" to true)
    private fun error(code: String): Map<String, Any?> = Json.obj("error" to code)

    @Suppress("UNCHECKED_CAST")
    private fun memberDevices(args: Map<String, Any?>): Map<String, List<String>> {
        val raw = Json.map(args["memberDevices"]) ?: emptyMap()
        return raw.mapValues { (_, v) -> (Json.list(v) ?: emptyList()).map { it as String } }
    }

    @Suppress("UNCHECKED_CAST")
    private fun mapList(value: Any?): List<Map<String, Any?>> = (Json.list(value) ?: emptyList()).map { Json.map(it) ?: emptyMap() }
}
